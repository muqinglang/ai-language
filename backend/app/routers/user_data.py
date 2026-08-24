from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import AIConversation, Chunk, Episode, EpisodeVisit, Favorite, Note, Progress, Subtitle, User, UserChunk
from ..schemas import EpisodeCard, Page

router = APIRouter(prefix="/api", tags=["user-data"])


# ============ Favorites ============
class FavoriteCreate(BaseModel):
    target_type: str  # episode | subtitle | chunk
    target_id: int
    note: str = ""


class FavoriteOut(BaseModel):
    id: int
    target_type: str
    target_id: int
    note: str


@router.post("/favorites", response_model=FavoriteOut)
async def add_favorite(
    body: FavoriteCreate,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.target_type not in ("episode", "subtitle", "chunk"):
        raise HTTPException(400, "bad target_type")
    # Dedupe
    existing = await db.scalar(
        select(Favorite).where(
            and_(
                Favorite.user_id == user.id,
                Favorite.target_type == body.target_type,
                Favorite.target_id == body.target_id,
            )
        )
    )
    if existing:
        return FavoriteOut(id=existing.id, target_type=existing.target_type, target_id=existing.target_id, note=existing.note)
    fav = Favorite(
        user_id=user.id, target_type=body.target_type, target_id=body.target_id, note=body.note
    )
    db.add(fav)
    await db.commit()
    await db.refresh(fav)
    return FavoriteOut(id=fav.id, target_type=fav.target_type, target_id=fav.target_id, note=fav.note)


@router.delete("/favorites", status_code=204)
async def remove_favorite(
    target_type: str,
    target_id: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        delete(Favorite).where(
            and_(
                Favorite.user_id == user.id,
                Favorite.target_type == target_type,
                Favorite.target_id == target_id,
            )
        )
    )
    await db.commit()


@router.get("/favorites", response_model=list[FavoriteOut])
async def list_favorites(
    target_type: str | None = None,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(Favorite).where(Favorite.user_id == user.id)
    if target_type:
        q = q.where(Favorite.target_type == target_type)
    rows = (await db.execute(q.order_by(Favorite.created_at.desc()))).scalars().all()
    return [FavoriteOut(id=r.id, target_type=r.target_type, target_id=r.target_id, note=r.note) for r in rows]


# ============ Notes ============
class NoteCreate(BaseModel):
    episode_id: int
    subtitle_id: int | None = None
    content: str


class NoteOut(BaseModel):
    id: int
    episode_id: int
    episode_title: str = ""
    subtitle_id: int | None
    content: str
    created_at: datetime | None = None


@router.post("/notes", response_model=NoteOut)
async def add_note(
    body: NoteCreate,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    note = Note(
        user_id=user.id,
        episode_id=body.episode_id,
        subtitle_id=body.subtitle_id,
        content=body.content,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    # Best-effort title fetch — note creation rarely happens at scale so a
    # second tiny query is fine. If the episode was deleted out from under
    # us (shouldn't happen for the original creator), fall back to "".
    ep = await db.get(Episode, note.episode_id)
    return NoteOut(
        id=note.id,
        episode_id=note.episode_id,
        episode_title=ep.title if ep else "",
        subtitle_id=note.subtitle_id,
        content=note.content,
        created_at=note.created_at,
    )


@router.get("/notes", response_model=Page[NoteOut])
async def list_notes(
    episode_id: int | None = None,
    q: str | None = None,
    limit: int = 30,
    offset: int = 0,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """List notes for the current user, newest first. Standard envelope."""
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    where = [Note.user_id == user.id]
    if episode_id:
        where.append(Note.episode_id == episode_id)
    if q:
        where.append(Note.content.ilike(f"%{q}%"))
    total = int(await db.scalar(
        select(func.count(Note.id)).where(*where)
    ) or 0)
    rows = (await db.execute(
        select(Note, Episode.title)
        .join(Episode, Note.episode_id == Episode.id)
        .where(*where)
        .order_by(Note.created_at.desc())
        .limit(limit).offset(offset)
    )).all()
    items = [
        NoteOut(
            id=n.id, episode_id=n.episode_id, episode_title=t or "",
            subtitle_id=n.subtitle_id, content=n.content, created_at=n.created_at,
        )
        for n, t in rows
    ]
    return Page(items=items, total=total, has_more=offset + len(items) < total)


@router.delete("/notes/{nid}", status_code=204)
async def delete_note(
    nid: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    n = await db.get(Note, nid)
    if not n or n.user_id != user.id:
        raise HTTPException(404, "not found")
    await db.delete(n)
    await db.commit()


# ============ Progress (打卡) ============
class ProgressPut(BaseModel):
    episode_id: int
    last_seq: int
    finished: bool = False


@router.put("/progress")
async def upsert_progress(
    body: ProgressPut,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.scalar(
        select(Progress).where(
            and_(Progress.user_id == user.id, Progress.episode_id == body.episode_id)
        )
    )
    if existing:
        existing.last_seq = max(existing.last_seq, body.last_seq)
        if body.finished:
            existing.status = "finished"
    else:
        db.add(
            Progress(
                user_id=user.id,
                episode_id=body.episode_id,
                last_seq=body.last_seq,
                status="finished" if body.finished else "in_progress",
            )
        )
    await db.commit()
    return {"ok": True}


@router.get("/progress")
async def list_progress(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(Progress).where(Progress.user_id == user.id).order_by(Progress.updated_at.desc())
        )
    ).scalars().all()
    return [
        {
            "episode_id": r.episode_id,
            "status": r.status,
            "last_seq": r.last_seq,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    ]


# ============ Enriched Favorites (with target details) ============
@router.get("/favorites/enriched")
async def list_favorites_enriched(
    limit: int = 30,
    offset: int = 0,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Favorites split into episode / subtitle / chunk buckets.

    Paginated over the combined favorites timeline: one limit/offset
    slice (newest first) is fetched, then split into the 3 buckets.
    Not the standard {items} envelope because the payload is inherently
    3-way; carries total + has_more so the frontend can "load more".
    """
    limit = max(1, min(100, limit))
    offset = max(0, offset)
    total = int(await db.scalar(
        select(func.count(Favorite.id)).where(Favorite.user_id == user.id)
    ) or 0)
    favs = (await db.execute(
        select(Favorite).where(Favorite.user_id == user.id)
        .order_by(Favorite.created_at.desc())
        .limit(limit).offset(offset)
    )).scalars().all()

    ep_ids = [f.target_id for f in favs if f.target_type == "episode"]
    sub_ids = [f.target_id for f in favs if f.target_type == "subtitle"]
    chunk_ids = [f.target_id for f in favs if f.target_type == "chunk"]

    episodes = {}
    if ep_ids:
        rows = (await db.execute(select(Episode).where(Episode.id.in_(ep_ids)))).scalars().all()
        episodes = {e.id: e for e in rows}

    subtitles = {}
    if sub_ids:
        rows = (await db.execute(
            select(Subtitle, Episode.title)
            .join(Episode, Subtitle.episode_id == Episode.id)
            .where(Subtitle.id.in_(sub_ids))
        )).all()
        subtitles = {s.id: (s, t) for s, t in rows}

    chunks = {}
    if chunk_ids:
        rows = (await db.execute(
            select(Chunk, Episode.title)
            .join(Episode, Chunk.episode_id == Episode.id)
            .where(Chunk.id.in_(chunk_ids))
        )).all()
        chunks = {c.id: (c, t) for c, t in rows}

    result: dict = {"episodes": [], "subtitles": [], "chunks": []}
    for f in favs:
        if f.target_type == "episode" and f.target_id in episodes:
            e = episodes[f.target_id]
            result["episodes"].append({
                "fav_id": f.id, "episode_id": e.id, "title": e.title,
                "thumbnail_url": e.thumbnail_url, "duration_sec": e.duration_sec,
                "note": f.note or "",
            })
        elif f.target_type == "subtitle" and f.target_id in subtitles:
            s, ep_title = subtitles[f.target_id]
            result["subtitles"].append({
                "fav_id": f.id, "subtitle_id": s.id,
                "episode_id": s.episode_id, "episode_title": ep_title,
                "text_en": s.text_en, "text_zh": s.text_zh,
                "note": f.note or "",
            })
        elif f.target_type == "chunk" and f.target_id in chunks:
            c, ep_title = chunks[f.target_id]
            result["chunks"].append({
                "fav_id": f.id, "chunk_id": c.id,
                "episode_id": c.episode_id, "episode_title": ep_title,
                "text": c.text, "chunk_type": c.chunk_type,
                "why_explanation": c.why_explanation,
                "note": f.note or "",
            })
    result["total"] = total
    result["has_more"] = offset + len(favs) < total
    return result


# ============ Paginated/searchable favorited chunks (Library tab) ============
@router.get("/favorites/chunks")
async def list_favorite_chunks(
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the user's favorited chunks (target_type='chunk') as a flat
    list with episode title, paginated and optionally filtered by `q`
    (substring on chunk text or why_explanation).

    Lives next to `/favorites/enriched` rather than replacing it because
    /favorites still wants the 3-bucket shape (episodes/subtitles/chunks).
    """
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    base = (
        select(Favorite, Chunk, Episode.title)
        .join(Chunk, Favorite.target_id == Chunk.id)
        .join(Episode, Chunk.episode_id == Episode.id)
        .where(Favorite.user_id == user.id)
        .where(Favorite.target_type == "chunk")
    )
    if q:
        like = f"%{q}%"
        base = base.where(Chunk.text.ilike(like) | Chunk.why_explanation.ilike(like))
    total = int(await db.scalar(
        select(func.count()).select_from(base.subquery())
    ) or 0)
    rows = (await db.execute(
        base.order_by(Favorite.created_at.desc()).limit(limit).offset(offset)
    )).all()
    items = [
        {
            "fav_id": f.id,
            "chunk_id": c.id,
            "episode_id": c.episode_id,
            "episode_title": t or "",
            "text": c.text,
            "chunk_type": c.chunk_type,
            "why_explanation": c.why_explanation,
            "note": f.note or "",
        }
        for f, c, t in rows
    ]
    return {"items": items, "total": total, "has_more": offset + len(items) < total}


# ============ User-marked chunks ============
class UserChunkCreate(BaseModel):
    episode_id: int
    subtitle_id: int
    text: str


class UserChunkOut(BaseModel):
    id: int
    episode_id: int
    subtitle_id: int
    text: str

    model_config = {"from_attributes": True}


@router.get("/episodes/{episode_id}/user-chunks", response_model=list[UserChunkOut])
async def list_user_chunks(
    episode_id: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(UserChunk)
            .where(UserChunk.user_id == user.id)
            .where(UserChunk.episode_id == episode_id)
            .order_by(UserChunk.id.asc())
        )
    ).scalars().all()
    return rows


@router.post("/user-chunks", response_model=UserChunkOut)
async def add_user_chunk(
    body: UserChunkCreate,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    if len(text) > 200:
        raise HTTPException(400, "phrase too long")
    # Idempotent: same span re-marked just returns the existing row.
    existing = (
        await db.execute(
            select(UserChunk).where(
                and_(
                    UserChunk.user_id == user.id,
                    UserChunk.subtitle_id == body.subtitle_id,
                    UserChunk.text == text,
                )
            )
        )
    ).scalar_one_or_none()
    if existing:
        return existing
    uc = UserChunk(
        user_id=user.id,
        episode_id=body.episode_id,
        subtitle_id=body.subtitle_id,
        text=text,
    )
    db.add(uc)
    await db.commit()
    await db.refresh(uc)
    return uc


@router.delete("/user-chunks/{uc_id}", status_code=204)
async def remove_user_chunk(
    uc_id: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        delete(UserChunk).where(
            and_(UserChunk.id == uc_id, UserChunk.user_id == user.id)
        )
    )
    await db.commit()


# ============ Me / Stats ============
@router.get("/me/stats")
async def my_stats(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    progress_rows = (await db.execute(
        select(Progress).where(Progress.user_id == user.id)
        .order_by(Progress.updated_at.desc())
    )).scalars().all()

    finished = sum(1 for p in progress_rows if p.status == "finished")

    fav_count = await db.scalar(
        select(func.count(Favorite.id)).where(Favorite.user_id == user.id)
    ) or 0

    note_count = await db.scalar(
        select(func.count(Note.id)).where(Note.user_id == user.id)
    ) or 0

    conv_count = await db.scalar(
        select(func.count(AIConversation.id)).where(AIConversation.user_id == user.id)
    ) or 0

    chunks_used_rows = (await db.execute(
        select(AIConversation.chunks_used).where(AIConversation.user_id == user.id)
    )).scalars().all()
    all_chunks = set()
    for cu in chunks_used_rows:
        if cu:
            all_chunks.update(cu)

    # Recent notes with episode title
    recent_notes_q = (
        select(Note, Episode.title)
        .join(Episode, Note.episode_id == Episode.id)
        .where(Note.user_id == user.id)
        .order_by(Note.created_at.desc())
        .limit(5)
    )
    recent_notes = (await db.execute(recent_notes_q)).all()

    # In-progress episodes with episode details
    in_progress_ids = [p.episode_id for p in progress_rows if p.status == "in_progress"]
    in_progress_eps = []
    if in_progress_ids:
        eps = (await db.execute(
            select(Episode).where(Episode.id.in_(in_progress_ids))
        )).scalars().all()
        ep_map = {e.id: e for e in eps}
        for p in progress_rows:
            if p.status == "in_progress" and p.episode_id in ep_map:
                e = ep_map[p.episode_id]
                in_progress_eps.append({
                    "episode_id": e.id, "title": e.title,
                    "thumbnail_url": e.thumbnail_url,
                    "last_seq": p.last_seq,
                    "subtitles_count": e.subtitles_count,
                    "updated_at": p.updated_at.isoformat() if p.updated_at else None,
                })

    return {
        "episodes_started": len(progress_rows),
        "episodes_finished": finished,
        "favorites_count": fav_count,
        "notes_count": note_count,
        "conversations_count": conv_count,
        "chunks_mastered": len(all_chunks),
        "joined_at": user.created_at.isoformat() if user.created_at else None,
        "last_active": progress_rows[0].updated_at.isoformat() if progress_rows else None,
        "recent_notes": [
            {"id": n.id, "episode_id": n.episode_id, "episode_title": t,
             "content": n.content, "created_at": n.created_at.isoformat() if n.created_at else None}
            for n, t in recent_notes
        ],
        "in_progress": in_progress_eps,
    }


@router.get("/me/heatmap")
async def my_heatmap(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """GitHub-style per-day activity for the last 84 days (12 weeks).

    Counts any meaningful interaction — progress tick, note written, AI
    conversation message, or vocabulary review. Returns a dict keyed by
    ISO-date string with integer activity count.
    """
    from datetime import date, timedelta

    today = date.today()
    start = today - timedelta(days=83)  # 12 weeks inclusive of today

    # Progress updates
    from sqlalchemy import cast, Date
    progress_daily = (
        await db.execute(
            select(cast(Progress.updated_at, Date).label("d"), func.count(Progress.id))
            .where(Progress.user_id == user.id)
            .where(cast(Progress.updated_at, Date) >= start)
            .group_by(cast(Progress.updated_at, Date))
        )
    ).all()
    notes_daily = (
        await db.execute(
            select(cast(Note.created_at, Date).label("d"), func.count(Note.id))
            .where(Note.user_id == user.id)
            .where(cast(Note.created_at, Date) >= start)
            .group_by(cast(Note.created_at, Date))
        )
    ).all()

    # Vocabulary review uses last_reviewed_at (SM-2 touch).
    from ..models import Vocabulary
    vocab_daily = (
        await db.execute(
            select(cast(Vocabulary.last_reviewed_at, Date).label("d"), func.count(Vocabulary.id))
            .where(Vocabulary.user_id == user.id)
            .where(Vocabulary.last_reviewed_at.is_not(None))
            .where(cast(Vocabulary.last_reviewed_at, Date) >= start)
            .group_by(cast(Vocabulary.last_reviewed_at, Date))
        )
    ).all()

    counts: dict[str, int] = {}
    for d, cnt in progress_daily + notes_daily + vocab_daily:
        if d is None:
            continue
        k = d.isoformat()
        counts[k] = counts.get(k, 0) + int(cnt or 0)

    # Longest streak (consecutive days with activity, ending on or before today).
    streak_current = 0
    streak_best = 0
    day = today
    while (day - start).days >= 0:
        if counts.get(day.isoformat(), 0) > 0:
            streak_current += 1
            streak_best = max(streak_best, streak_current)
        else:
            streak_current = 0
        day -= timedelta(days=1)

    # Live streak — counting back from today consecutively.
    live = 0
    day = today
    while counts.get(day.isoformat(), 0) > 0:
        live += 1
        day -= timedelta(days=1)

    return {
        "start": start.isoformat(),
        "end": today.isoformat(),
        "counts": counts,
        "total_active_days": sum(1 for v in counts.values() if v > 0),
        "best_streak": streak_best,
        "current_streak": live,
    }


# ============ Preferences ============
class PreferencesIn(BaseModel):
    # Use Optional to distinguish "not set" from "set to false". Both PATCH
    # semantics — sending None = leave alone.
    onboarding_dismissed: bool | None = None


class PreferencesOut(BaseModel):
    onboarding_dismissed: bool


@router.patch("/me/preferences", response_model=PreferencesOut)
async def update_preferences(
    body: PreferencesIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.onboarding_dismissed is not None:
        user.onboarding_dismissed = body.onboarding_dismissed
    db.add(user)
    await db.commit()
    return PreferencesOut(onboarding_dismissed=user.onboarding_dismissed)


# ============ Recent learning (Home opt-out view) ============
class RecentCollectionItem(BaseModel):
    id: int
    title: str
    segment_index: int | None
    duration_sec: int
    thumbnail_url: str
    progress_status: str  # "not_started" | "in_progress" | "finished"
    is_current: bool       # the segment this user most recently studied


class RecentCollection(BaseModel):
    youtube_url: str
    items: list[RecentCollectionItem]


class RecentOut(BaseModel):
    hero: EpisodeCard | None
    collection: RecentCollection | None


@router.get("/me/recent", response_model=RecentOut)
async def my_recent(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Continue-learning hero + (if applicable) the collection ToC.

    Powers Home's RecentView when the learner has opted out of the
    topic-anchor onboarding. Phase 1 returns the most-recently-OPENED
    Episode (per EpisodeVisit — written ~5s into a page load, so just
    browsing Discover thumbnails doesn't count) plus its sibling
    segments (episodes sharing the same youtube_url, ordered by
    segment_index). No cross-collection recent list yet.

    EpisodeVisit is the right signal here — Progress only ticks once
    the learner advances past seq=0, so a quick "watched the intro
    then bounced" still shows up in the rail.
    """
    hero_ep = (
        await db.execute(
            select(Episode)
            .join(EpisodeVisit, EpisodeVisit.episode_id == Episode.id)
            .where(EpisodeVisit.user_id == user.id)
            .order_by(EpisodeVisit.last_visited_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if hero_ep is None:
        return RecentOut(hero=None, collection=None)

    hero_card = EpisodeCard.model_validate(hero_ep)

    # No youtube_url → can't group siblings. Hero only.
    if not hero_ep.youtube_url:
        return RecentOut(hero=hero_card, collection=None)

    siblings = (
        await db.execute(
            select(Episode)
            .where(Episode.youtube_url == hero_ep.youtube_url)
            .where(Episode.status == "published")
            .order_by(
                Episode.segment_index.is_(None),   # NULLs last
                Episode.segment_index.asc(),
                Episode.id.asc(),
            )
        )
    ).scalars().all()

    if len(siblings) <= 1:
        return RecentOut(hero=hero_card, collection=None)

    sibling_ids = [e.id for e in siblings]
    prog_rows = (
        await db.execute(
            select(Progress.episode_id, Progress.status)
            .where(Progress.user_id == user.id)
            .where(Progress.episode_id.in_(sibling_ids))
        )
    ).all()
    status_by_ep = {ep_id: st for ep_id, st in prog_rows}

    items = [
        RecentCollectionItem(
            id=ep.id,
            title=ep.title,
            segment_index=ep.segment_index,
            duration_sec=ep.duration_sec,
            thumbnail_url=EpisodeCard.model_validate(ep).thumbnail_url,
            progress_status=status_by_ep.get(ep.id, "not_started"),
            is_current=(ep.id == hero_ep.id),
        )
        for ep in siblings
    ]

    return RecentOut(
        hero=hero_card,
        collection=RecentCollection(
            youtube_url=hero_ep.youtube_url,
            items=items,
        ),
    )
