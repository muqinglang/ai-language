import asyncio
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import current_user, current_user_optional
from ..db import get_db
from ..models import (
    AIConversation,
    Category,
    Chunk,
    Episode,
    EpisodeChapter,
    EpisodeVisit,
    Subtitle,
    User,
)
from ..schemas import CategoryOut, EpisodeCard, EpisodeChapterOut, EpisodeDetail, Page
from ..services import llm as _llm
from .user_llm import note_byok_error, require_override


def _ms_to_vtt(ms: int) -> str:
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1_000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"

router = APIRouter(prefix="/api/episodes", tags=["episodes"])


class DiscoverItem(BaseModel):
    """One Discover grid card — either a standalone episode or a
    collapsed collection of same-source segments. Pagination is by
    THIS unit so a collection always renders as exactly one card and
    never splits across a page boundary."""
    kind: str  # "episode" | "collection"
    episode: EpisodeCard | None = None       # set when kind == "episode"
    # collection fields (kind == "collection")
    youtube_id: str = ""
    title: str = ""
    thumbnail_url: str = ""
    topic: str = ""
    segment_count: int = 0
    total_duration_sec: int = 0
    creator: str = ""


_YT_ID_RE = re.compile(r"(?:watch\?v=|youtu\.be/|embed/|shorts/)([A-Za-z0-9_-]{11})")


def _yt_id(url: str) -> str:
    m = _YT_ID_RE.search(url or "")
    return m.group(1) if m else ""


def _seg_key(e: Episode) -> int:
    """Sort key inside a collection: explicit segment_index, else the
    "(N/M)" title prefix, else end-of-list."""
    if e.segment_index is not None:
        return e.segment_index
    m = re.match(r"^\((\d+)/\d+\)", e.title or "")
    return int(m.group(1)) if m else 9999


@router.get("", response_model=Page[DiscoverItem])
async def list_episodes(
    category: str | None = None,
    topic: str | None = None,
    difficulty: int | None = None,
    accent: str | None = None,
    creator: int | None = None,   # speaker_id filter
    sort: str = "latest",  # latest | shortest
    page: int = 1,
    size: int = 24,
    db: AsyncSession = Depends(get_db),
):
    """Discover feed. Same-source segments are folded into ONE collection
    unit; pagination is by unit. Episode count is curation-bounded
    (hundreds), so fetch-all → group → slice stays cheap and keeps a
    collection whole."""
    size = max(1, min(size, 100))
    page = max(1, page)
    base = select(Episode).where(Episode.status == "published")
    if category:
        base = base.join(Category).where(Category.slug == category)
    if topic:
        base = base.where(Episode.topic == topic)
    if difficulty:
        base = base.where(Episode.difficulty == difficulty)
    if accent:
        base = base.where(Episode.accent == accent)
    if creator:
        base = base.where(Episode.speaker_id == creator)

    order = {
        "latest": Episode.published_at.desc().nulls_last(),
        "shortest": Episode.duration_sec.asc(),
    }.get(sort, Episode.published_at.desc().nulls_last())
    rows = list((await db.execute(base.order_by(order))).scalars().all())

    # Group by YouTube id; first-encounter order = unit order (so the
    # chosen sort carries through — a group sits where its top-sorted
    # episode landed).
    groups: dict[str, list[Episode]] = {}
    group_order: list[str] = []
    for e in rows:
        key = _yt_id(e.youtube_url) or f"__solo_{e.id}"
        if key not in groups:
            groups[key] = []
            group_order.append(key)
        groups[key].append(e)

    units: list[DiscoverItem] = []
    for key in group_order:
        g = groups[key]
        if len(g) > 1 and not key.startswith("__solo_"):
            g_sorted = sorted(g, key=_seg_key)
            first = g_sorted[0]
            topic_counts: dict[str, int] = {}
            for e in g:
                topic_counts[e.topic or "other"] = topic_counts.get(e.topic or "other", 0) + 1
            dominant = max(topic_counts.items(), key=lambda kv: kv[1])[0]
            creators = {e.speaker.name for e in g if e.speaker and e.speaker.name}
            units.append(DiscoverItem(
                kind="collection",
                youtube_id=key,
                title=re.sub(r"^\(\d+/\d+\)\s*", "", first.title or ""),
                thumbnail_url=first.thumbnail_url,
                topic=dominant,
                segment_count=len(g),
                total_duration_sec=sum(int(e.duration_sec or 0) for e in g),
                creator=(
                    next(iter(creators)) if len(creators) == 1
                    else (f"{len(creators)} 位创作者" if creators else "")
                ),
            ))
        else:
            units.append(DiscoverItem(
                kind="episode",
                episode=EpisodeCard.model_validate(g[0]),
            ))

    total = len(units)
    start = (page - 1) * size
    page_units = units[start:start + size]
    return Page(items=page_units, total=total, has_more=start + len(page_units) < total)


@router.get("/categories", response_model=list[CategoryOut])
async def list_categories(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Category).order_by(Category.sort))).scalars().all()
    return list(rows)


@router.get("/topics")
async def list_topics():
    """Return the curated topic enum.  Static — no DB hit."""
    from ..services.topics import TOPICS
    return TOPICS


@router.get("/feed")
async def feed(
    user: User | None = Depends(current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Home page rails.

    "continue" comes from the EpisodeVisit table — every time a learner
    spends ≥5s on /learn/:id the frontend pings POST /visit and we
    record/refresh `last_visited_at`.  Sorting by that timestamp gives
    "most recently studied" no matter whether the engagement was video
    listening, subtitle reading, or AI chat.  Anon visitors and brand-
    new users get [] so the rail stays hidden.

    Earlier the signal was AIConversation.created_at, which broke for
    learners who watched without chatting; revisit that history if the
    visits-based version stops fitting.

    "latest" stays as the most recent N published episodes for use as
    fallback when no continue exists (also the source for the
    "推荐给你" rail on the home page).  ai_picks / editor were
    placeholder rails of dubious value (latest[:5] mislabelled) — they
    misled users (an AI rail full of lifestyle videos) so they're
    removed entirely.
    """
    latest_q = (
        select(Episode)
        .where(Episode.status == "published")
        .order_by(Episode.published_at.desc().nulls_last())
        .limit(12)
    )
    latest_eps = (await db.execute(latest_q)).scalars().all()
    latest = [EpisodeCard.model_validate(e).model_dump() for e in latest_eps]

    continue_eps: list[dict] = []
    if user is not None:
        # Most recent 5 distinct episodes the user spent real time on.
        # Joining EpisodeVisit → Episode lets us filter by published status
        # in one query and skip episodes that got archived/deleted after
        # the visit was recorded.
        visit_q = (
            select(Episode)
            .join(EpisodeVisit, EpisodeVisit.episode_id == Episode.id)
            .where(EpisodeVisit.user_id == user.id)
            .where(Episode.status == "published")
            .order_by(EpisodeVisit.last_visited_at.desc())
            .limit(5)
        )
        visited_eps = (await db.execute(visit_q)).scalars().all()
        continue_eps = [EpisodeCard.model_validate(e).model_dump() for e in visited_eps]

    return {
        "continue": continue_eps,
        "latest": latest[:6],
    }


@router.post("/{ep_id}/visit", status_code=204)
async def record_visit(
    ep_id: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Record/refresh the user's most recent visit to an episode page.

    Called by the Learn page after the learner has been on the page for
    ~5s (frontend timer), which keeps accidental click-and-bounce out
    of the "继续学习" rail.  Idempotent: hitting it many times for the
    same (user, ep) just bumps last_visited_at — there's no row growth.

    Why a dedicated endpoint instead of piggy-backing on GET /episodes/:id:
    the GET fires for any consumer (admin previews, share-link probes,
    React Query refetch on tab focus) and we don't want all of those
    to count as "the user is studying this episode".
    """
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")

    visit = await db.get(EpisodeVisit, (user.id, ep_id))
    if visit is None:
        db.add(EpisodeVisit(user_id=user.id, episode_id=ep_id))
    else:
        visit.last_visited_at = datetime.now(timezone.utc)
    await db.commit()
    return Response(status_code=204)


@router.get("/{ep_id}/chapters", response_model=list[EpisodeChapterOut])
async def list_chapters(ep_id: int, db: AsyncSession = Depends(get_db)):
    """Chapter navigation markers for a chapters-mode Episode.

    Returns [] when the episode exists but was imported in segment mode
    (no chapters to enumerate) — that's the common case and the frontend
    treats empty list as "no chapter strip". 404 only when the episode
    itself is missing.
    """
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    rows = (
        await db.execute(
            select(EpisodeChapter)
            .where(EpisodeChapter.episode_id == ep_id)
            .order_by(EpisodeChapter.order_idx)
        )
    ).scalars().all()
    return list(rows)


@router.get("/{ep_id}/subtitles.vtt", response_class=PlainTextResponse)
async def episode_vtt(ep_id: int, db: AsyncSession = Depends(get_db)) -> PlainTextResponse:
    """Serve subtitles as a WebVTT file consumable by an HTML <track> element."""
    rows = (
        await db.execute(
            select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq)
        )
    ).scalars().all()
    cues = ["WEBVTT", ""]
    for s in rows:
        cues.append(str(s.seq))
        cues.append(f"{_ms_to_vtt(s.start_ms)} --> {_ms_to_vtt(s.end_ms)}")
        cues.append(s.text_en or "")
        cues.append("")
    return PlainTextResponse("\n".join(cues), media_type="text/vtt; charset=utf-8")


@router.get("/{ep_id}", response_model=EpisodeDetail)
async def get_episode(ep_id: int, db: AsyncSession = Depends(get_db)):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "not found")
    subs = (
        await db.execute(select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq))
    ).scalars().all()
    chunks = (
        await db.execute(select(Chunk).where(Chunk.episode_id == ep_id))
    ).scalars().all()
    d = EpisodeDetail.model_validate(ep).model_dump()
    d["ai_metadata"] = ep.ai_metadata or {}
    d["subtitles"] = [dict(
        id=s.id, seq=s.seq, start_ms=s.start_ms, end_ms=s.end_ms,
        text_en=s.text_en, text_zh=s.text_zh, chunk_refs=s.chunk_refs,
        word_timings=s.word_timings or [],
    ) for s in subs]
    d["chunks"] = [dict(
        id=c.id, text=c.text, chunk_type=c.chunk_type,
        why_explanation=c.why_explanation, usage_scenario=c.usage_scenario,
        similar_expressions=c.similar_expressions, common_collocations=c.common_collocations,
        pronunciation_tip=c.pronunciation_tip, difficulty=c.difficulty,
    ) for c in chunks]
    return d


class SentencePatternReq(BaseModel):
    # Optional learner steer appended to the (fixed) system prompt — e.g.
    # "多给职场场景的句子". Empty = use the default behaviour.
    extra_instruction: str = ""


@router.post("/{ep_id}/sentence-pattern")
async def generate_sentence_pattern(
    ep_id: int,
    body: SentencePatternReq | None = None,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Learner-triggered generation of the Patterns-tab sentence lesson.

    Episodes imported after the feature shipped already carry
    ai_metadata.sentence_pattern (filled in pipeline stage 5). The Learn
    page's Rephrase (换着花样说) tab POSTs here both to generate one for an
    older episode that lacks it and to "再换一句" regenerate an existing one.
    Runs on the LEARNER'S key, like every other model call they trigger.
    The result is cached into ai_metadata, so the next viewer reads it
    instantly and needs no key of their own — only the person who asks for
    a generation pays for one, and they get the content immediately.

    This used to run on the platform key, on the theory that "generated
    once, read by everyone" shouldn't be billed to whoever happened to
    click first. That theory cost more than it saved: it left a key the
    learner-facing product silently depended on, and when it lapsed this
    tab broke while the settings page still said 连接正常 (that tests the
    learner's key, which was fine). One rule with no exceptions is worth
    more than the few hundred tokens it saves.

    An explicit POST always regenerates (the button is also a "重新生成")."""
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "not found")

    subs = (await db.execute(
        select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq)
    )).scalars().all()
    # Use the real seq as the LLM line index so the returned subtitle_idx
    # maps straight back to the row the frontend seeks by (s.seq === idx).
    pattern_subs = [(s.seq, s.text_en) for s in subs if (s.text_en or "").strip()]
    if not pattern_subs:
        raise HTTPException(400, "episode has no subtitles")

    extra = (body.extra_instruction if body else "") or ""
    override = await require_override(db, user)
    try:
        pattern = await asyncio.wait_for(
            asyncio.to_thread(
                _llm.pick_sentence_pattern,
                ep.title or "", ep.summary or "", pattern_subs, extra, override,
            ),
            timeout=120,
        )
    except _llm.BYOKCallFailed as e:
        await note_byok_error(db, user.id, str(e))
        raise HTTPException(502, str(e)) from e
    except Exception:
        pattern = None
    if not pattern:
        # "请重试" is a lie when the platform key is revoked or out of
        # balance — the learner can retry all afternoon. pick_sentence_pattern
        # soft-fails to None by design (the pipeline depends on that), so the
        # reason has to be fetched from the provider layer.
        why = _llm.last_provider_error()
        raise HTTPException(502, f"生成失败：{why}" if why else "生成失败，请重试")

    meta = dict(ep.ai_metadata or {})
    meta["sentence_pattern"] = pattern
    ep.ai_metadata = meta
    await db.commit()
    return {"sentence_pattern": pattern}
