"""Collection endpoints.

A "Collection" is the result of importing a long YouTube video in
`mode="full"` — the pipeline splits it into N coherent 2-3 min
segments, each stored as an Episode row sharing the same
`youtube_url` and ordered by `segment_index`.

The collection's identity is the YouTube video ID (the 11-char
suffix after `v=`); we surface that to the frontend as the route
slug instead of inventing a separate Collection table.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from datetime import datetime, timezone

from sqlalchemy import update

from ..auth import current_admin, current_user
from ..db import get_db
from ..models import Episode, Speaker, User
from ..schemas import Page

router = APIRouter(prefix="/api/collections", tags=["collections"])
# Admin-only sibling router so /api/admin/collections* lives next to
# the other admin endpoints in the frontend client.
admin_router = APIRouter(prefix="/api/admin/collections", tags=["admin-collections"])


def _extract_youtube_id(url: str) -> str:
    """Return the 11-char video id, or "" if we can't parse it.

    Mirrors `services.pipeline._extract_youtube_id` so we don't have to
    cross-import that module from a request handler.
    """
    if not url:
        return ""
    # youtu.be/<id>
    m = re.search(r"youtu\.be/([A-Za-z0-9_-]{11})", url)
    if m:
        return m.group(1)
    try:
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        if "v" in qs and qs["v"]:
            v = qs["v"][0]
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", v):
                return v
        # /shorts/<id> or /embed/<id>
        m = re.search(r"/(shorts|embed)/([A-Za-z0-9_-]{11})", parsed.path)
        if m:
            return m.group(2)
    except Exception:
        pass
    return ""


class CollectionSegment(BaseModel):
    id: int
    title: str
    segment_index: int
    thumbnail_url: str
    duration_sec: int
    chunks_count: int
    summary_zh: str
    topic_zh: str
    # "published" / "reviewing" — public detail page renders reviewing
    # segments grayed-out with a 审核中 badge so the learner knows the
    # collection isn't fully ready yet.
    status: str = "published"

    model_config = {"from_attributes": True}


class CollectionRow(BaseModel):
    """Light card for the Home page horizontal scroll row."""
    youtube_id: str
    title: str          # original video title (taken from first segment, stripped of "title prefix - " noise)
    thumbnail_url: str
    creator_name: str   # speaker.name, when available
    segment_count: int          # total segments (published + reviewing)
    published_count: int = 0    # count of fully-published segments
    total_duration_sec: int
    # First segment id is the "play" target — clicking the card on Home
    # could either open the collection page (preferred) or jump straight
    # to segment 1; we expose both so the UI decides.
    first_episode_id: int


class CollectionDetail(CollectionRow):
    segments: list[CollectionSegment]


def _strip_segment_title_prefix(title: str) -> str:
    """Pull the original video title back out of a segment title.

    Pipeline writes segment titles as `"<LLM segment title> - <original
    video title>"` so the Catalog page (which doesn't know about
    collections) still shows something contextual. For the collection
    Home card we want the original video title; this strips the leading
    `<segment title> - ` if present, otherwise returns the title as-is.
    """
    # Heuristic: split on the FIRST " - " (en dash with surrounding spaces).
    # LLM segment titles never contain " - " (≤18 字 Chinese) so this is safe.
    parts = title.split(" - ", 1)
    if len(parts) == 2:
        return parts[1].strip() or title
    return title


async def _build_collection_rows(
    db: AsyncSession, include_reviewing: bool,
) -> list[tuple[str, list[Episode]]]:
    """Group full-mode episodes by youtube_url. When include_reviewing is
    False, returns only collections where *every* segment is published
    (half-published collections are hidden from regular users).
    """
    statuses = ("published", "reviewing") if include_reviewing else ("published", "reviewing")
    # We fetch both statuses regardless — the filter decides whether to
    # surface partially-ready collections, but we need to *see* reviewing
    # rows to know whether any exist for a given URL.
    rows = (
        await db.execute(
            select(Episode)
            .where(Episode.collection_kind == "full")
            .where(Episode.status.in_(statuses))
            .order_by(Episode.created_at.desc(), Episode.segment_index.asc())
        )
    ).scalars().all()
    if not rows:
        return []

    by_url: dict[str, list[Episode]] = {}
    for r in rows:
        by_url.setdefault(r.youtube_url or "", []).append(r)

    out: list[tuple[str, list[Episode]]] = []
    for url, eps in by_url.items():
        if not url or not eps:
            continue
        if not include_reviewing:
            # Hide collections that have ANY non-published segment so the
            # user never lands on "Part 6 (审核中)" when they expected a
            # finished course.
            if any(e.status != "published" for e in eps):
                continue
        # id as tiebreaker: highlight-mode segments share segment_index 0,
        # so without it they'd come back in arbitrary (reverse) query order.
        # Ascending id = import order = natural 1→N sequence.
        out.append((url, sorted(eps, key=lambda e: (e.segment_index or 0, e.id))))
    return out


def _row_from_eps(yt_id: str, eps: list[Episode], speaker: Speaker | None) -> CollectionRow:
    first = eps[0]
    return CollectionRow(
        youtube_id=yt_id,
        title=_strip_segment_title_prefix(first.title),
        thumbnail_url=first.thumbnail_url,
        creator_name=speaker.name if speaker else "",
        segment_count=len(eps),
        published_count=sum(1 for e in eps if e.status == "published"),
        total_duration_sec=sum(int(e.duration_sec or 0) for e in eps),
        first_episode_id=first.id,
    )


@router.get("", response_model=Page[CollectionRow])
async def list_collections(
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(current_user),
):
    """Public collection list — only fully-published collections appear here.

    Half-published collections (where some segments are still reviewing)
    are hidden until the admin flips them all to published; otherwise a
    learner clicking "Part 6" would hit a 404 / blank page mid-course.
    """
    limit = max(1, min(limit, 200))
    grouped = await _build_collection_rows(db, include_reviewing=False)
    if not grouped:
        return Page(items=[], total=0, has_more=False)
    speaker_ids = {eps[0].speaker_id for _u, eps in grouped if eps[0].speaker_id}
    speakers = {
        s.id: s
        for s in (
            await db.execute(select(Speaker).where(Speaker.id.in_(speaker_ids)))
        ).scalars().all()
    } if speaker_ids else {}

    out: list[CollectionRow] = []
    for url, eps in grouped:
        yt_id = _extract_youtube_id(url)
        if not yt_id:
            continue
        out.append(_row_from_eps(yt_id, eps, speakers.get(eps[0].speaker_id) if eps[0].speaker_id else None))
    total = len(out)
    page = out[offset:offset + limit]
    return Page(items=page, total=total, has_more=offset + len(page) < total)


def _build_segments(matched: list[Episode]) -> list[CollectionSegment]:
    """Materialise per-segment cards including their publish status so the
    public detail page can gray out reviewing rows."""
    return [
        CollectionSegment(
            id=e.id,
            title=e.title.split(" - ", 1)[0].strip() if " - " in e.title else e.title,
            segment_index=int(e.segment_index or 0),
            thumbnail_url=e.thumbnail_url,
            duration_sec=int(e.duration_sec or 0),
            chunks_count=int(e.chunks_count or 0),
            summary_zh=e.summary_zh,
            topic_zh=(
                (e.ai_metadata or {}).get("segment", {}).get("topic_zh", "")
                if isinstance(e.ai_metadata, dict) else ""
            ),
            status=e.status,
        )
        for e in matched
    ]


@router.get("/{youtube_id}", response_model=CollectionDetail)
async def get_collection(
    youtube_id: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(current_user),
):
    """All segments of one collection, sorted by segment_index.

    Public-facing: returns the collection so long as it has at least one
    published segment (so a teaser collection works). Reviewing segments
    are returned with status="reviewing" and the frontend grays them out
    rather than hiding entirely — keeps the table-of-contents honest.
    """
    # Lenient acceptance: the path param may carry extra query/anchor
    # garbage from a shared link (e.g. "Jfo0KxSvOzc&t=1855s"). Pull the
    # first 11-char [A-Za-z0-9_-] pattern out — that's the real id.
    norm = re.search(r"[A-Za-z0-9_-]{11}", youtube_id)
    if not norm:
        raise HTTPException(400, "invalid youtube id")
    yt_id = norm.group(0)

    # Match any youtube_url whose value contains this id. We can't
    # canonicalise URLs at import (admin can paste youtu.be / watch?v / etc),
    # so we filter post-fetch instead of inventing a normalized column.
    # No collection_kind filter: highlight-mode multi-segments (N>1
    # Episodes sharing one youtube_url) also count as a collection from
    # the learner's POV; Catalog hard-collapses them onto this page.
    rows = (
        await db.execute(
            select(Episode)
            .where(Episode.status.in_(("published", "reviewing")))
        )
    ).scalars().all()
    # Two-step match: prefer canonicalised id extraction; fall back to
    # substring search on the stored youtube_url (rescues rows whose URL
    # was stored as a fragment like "Jfo0KxSvOzc&t=1855s" without a
    # canonical "watch?v=" prefix).
    matched = [
        r for r in rows
        if _extract_youtube_id(r.youtube_url or "") == yt_id
        or (r.youtube_url or "").find(yt_id) >= 0
    ]
    if not matched:
        raise HTTPException(404, "collection not found")
    # At least one segment must be published before non-admin users see
    # the page at all (otherwise a 0-published collection becomes a
    # 404-like dead end from the user's POV).
    if not any(r.status == "published" for r in matched):
        raise HTTPException(404, "collection not yet published")
    # id tiebreaker — highlight-mode segments all carry segment_index 0,
    # so sort by id to recover the natural import order (1→N).
    matched.sort(key=lambda e: (e.segment_index or 0, e.id))

    first = matched[0]
    speaker = None
    if first.speaker_id:
        speaker = await db.get(Speaker, first.speaker_id)

    return CollectionDetail(
        youtube_id=youtube_id,
        title=_strip_segment_title_prefix(first.title),
        thumbnail_url=first.thumbnail_url,
        creator_name=speaker.name if speaker else "",
        segment_count=len(matched),
        published_count=sum(1 for e in matched if e.status == "published"),
        total_duration_sec=sum(int(e.duration_sec or 0) for e in matched),
        first_episode_id=first.id,
        segments=_build_segments(matched),
    )


# ============================================================
# Admin endpoints: collection-level publish / unpublish
# ============================================================

class AdminCollectionRow(CollectionRow):
    """Admin view of a collection — includes review status counts so
    the admin page can render \"5/12 已发布 · 7 待审\" badges."""
    reviewing_count: int = 0


@admin_router.get("", response_model=Page[AdminCollectionRow])
async def admin_list_collections(
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(current_admin),
):
    """List ALL full-mode collections regardless of publish status so
    the admin sees half-published ones too."""
    limit = max(1, min(limit, 200))
    grouped = await _build_collection_rows(db, include_reviewing=True)
    if not grouped:
        return Page(items=[], total=0, has_more=False)
    speaker_ids = {eps[0].speaker_id for _u, eps in grouped if eps[0].speaker_id}
    speakers = {
        s.id: s
        for s in (
            await db.execute(select(Speaker).where(Speaker.id.in_(speaker_ids)))
        ).scalars().all()
    } if speaker_ids else {}

    out: list[AdminCollectionRow] = []
    for url, eps in grouped:
        yt_id = _extract_youtube_id(url)
        if not yt_id:
            continue
        speaker = speakers.get(eps[0].speaker_id) if eps[0].speaker_id else None
        base = _row_from_eps(yt_id, eps, speaker)
        out.append(AdminCollectionRow(
            **base.model_dump(),
            reviewing_count=sum(1 for e in eps if e.status == "reviewing"),
        ))
    total = len(out)
    page = out[offset:offset + limit]
    return Page(items=page, total=total, has_more=offset + len(page) < total)


@admin_router.get("/{youtube_id}", response_model=CollectionDetail)
async def admin_get_collection(
    youtube_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(current_admin),
):
    """Admin variant of the detail endpoint — returns the collection
    even when 0 segments are published yet, so the admin can review
    before flipping the switch."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", youtube_id):
        raise HTTPException(400, "invalid youtube id")
    rows = (
        await db.execute(
            select(Episode)
            .where(Episode.collection_kind == "full")
            .where(Episode.status.in_(("published", "reviewing")))
        )
    ).scalars().all()
    matched = [r for r in rows if _extract_youtube_id(r.youtube_url or "") == youtube_id]
    if not matched:
        raise HTTPException(404, "collection not found")
    # id tiebreaker — highlight-mode segments all carry segment_index 0,
    # so sort by id to recover the natural import order (1→N).
    matched.sort(key=lambda e: (e.segment_index or 0, e.id))

    first = matched[0]
    speaker = await db.get(Speaker, first.speaker_id) if first.speaker_id else None
    return CollectionDetail(
        youtube_id=youtube_id,
        title=_strip_segment_title_prefix(first.title),
        thumbnail_url=first.thumbnail_url,
        creator_name=speaker.name if speaker else "",
        segment_count=len(matched),
        published_count=sum(1 for e in matched if e.status == "published"),
        total_duration_sec=sum(int(e.duration_sec or 0) for e in matched),
        first_episode_id=first.id,
        segments=_build_segments(matched),
    )


async def _flip_collection_status(
    db: AsyncSession, youtube_id: str, new_status: str,
) -> dict:
    """Bulk-update every segment of the matching collection. We can't
    do a single UPDATE-by-WHERE because youtube_url isn't canonicalised
    (admin can paste youtu.be / watch?v / etc), so we collect IDs first
    then update by id-list inside one transaction."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", youtube_id):
        raise HTTPException(400, "invalid youtube id")
    rows = (
        await db.execute(
            select(Episode)
            .where(Episode.collection_kind == "full")
        )
    ).scalars().all()
    matched = [r for r in rows if _extract_youtube_id(r.youtube_url or "") == youtube_id]
    if not matched:
        raise HTTPException(404, "collection not found")
    ids = [e.id for e in matched]
    now = datetime.now(timezone.utc)
    if new_status == "published":
        await db.execute(
            update(Episode)
            .where(Episode.id.in_(ids))
            .values(status="published", published_at=now)
        )
    else:
        # Unpublish: leave published_at alone — it's a record of when the
        # episode was first promoted; clearing it would lose history.
        await db.execute(
            update(Episode)
            .where(Episode.id.in_(ids))
            .values(status=new_status)
        )
    await db.commit()
    return {"ok": True, "updated": len(ids), "ids": ids, "status": new_status}


@admin_router.post("/{youtube_id}/publish")
async def admin_publish_collection(
    youtube_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(current_admin),
):
    """Flip every segment of the collection to status=\"published\"."""
    return await _flip_collection_status(db, youtube_id, "published")


@admin_router.post("/{youtube_id}/unpublish")
async def admin_unpublish_collection(
    youtube_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(current_admin),
):
    """Flip every segment of the collection back to status=\"reviewing\"."""
    return await _flip_collection_status(db, youtube_id, "reviewing")
