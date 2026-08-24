from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import Episode, User, UserAnchor
from ..services.topics import TOPICS

router = APIRouter(prefix="/api", tags=["anchors"])

_TOPIC_META = {t["slug"]: t for t in TOPICS}
_TOPIC_ORDER = {t["slug"]: i for i, t in enumerate(TOPICS)}


class TopicCard(BaseModel):
    slug: str
    name: str
    icon: str
    episode_count: int


class PathItem(BaseModel):
    episode_id: int
    title: str
    thumbnail_url: str
    duration_sec: int
    difficulty: int
    creator: str
    done: bool
    locked: bool      # true until the previous episode is done
    current: bool      # the one the learner is on now


class MyAnchorOut(BaseModel):
    topic: TopicCard
    day: int
    done_count: int
    total: int
    path: list[PathItem]
    # Pagination: `path` is a slice; total/done_count/current_page refer
    # to the whole-set view so the frontend can render Pager + auto-jump
    # to the page containing the current clip.
    page: int = 0
    page_size: int = 10
    current_page: int = 0


def _topic_card(slug: str, count: int) -> TopicCard:
    m = _TOPIC_META.get(slug, {"name": slug, "icon": "🌀"})
    return TopicCard(slug=slug, name=m["name"], icon=m["icon"], episode_count=count)


async def _published_in_topic(db: AsyncSession, topic: str) -> list[Episode]:
    """Topic path, narrow-listening order.

    Ordering, outer → inner:
      1. difficulty ascending — progressive challenge.
      2. subtopic clustered — cooking clips together, then shopping,
         etc. This is THE key narrow-listening signal inside a broad
         topic like "lifestyle"; vocab recurs within a subtopic streak
         far more than across one.
      3. same creator clustered inside the subtopic — voice/idiolect
         adaptation as a secondary gain.
      4. id ascending — stable tiebreak.

    Empty subtopic sorts last (high-NULL sentinel) so unlabeled clips
    don't break up a real cooking streak.
    """
    rows = (await db.execute(
        select(Episode)
        .where(Episode.topic == topic, Episode.status == "published")
        .order_by(
            Episode.difficulty.asc(),
            # PostgreSQL: empty string sorts before non-empty by default;
            # we want unlabeled to go LAST inside a difficulty band, so
            # flip via a case expression.
            (Episode.subtopic == "").asc(),
            Episode.subtopic.asc(),
            func.coalesce(Episode.speaker_id, 0).asc(),
            Episode.id.asc(),
        )
    )).scalars().all()
    return list(rows)


async def _my_anchor_out(
    db: AsyncSession, ua: UserAnchor, page: int = 0, size: int = 10,
) -> MyAnchorOut:
    eps = await _published_in_topic(db, ua.topic)
    done = set(ua.done_episode_ids or [])
    # First not-done episode is "current"; everything after the first
    # not-done is locked (sequential gating).
    cur_idx = next((i for i, e in enumerate(eps) if e.id not in done), len(eps))
    full_path: list[PathItem] = []
    for i, e in enumerate(eps):
        is_done = e.id in done
        full_path.append(PathItem(
            episode_id=e.id,
            title=e.title,
            thumbnail_url=e.thumbnail_url,
            duration_sec=e.duration_sec,
            difficulty=e.difficulty,
            creator=(e.speaker.name if e.speaker else ""),
            done=is_done,
            locked=(i > cur_idx),
            current=(i == cur_idx),
        ))
    adopted = ua.adopted_at or datetime.now(timezone.utc)
    if adopted.tzinfo is None:
        adopted = adopted.replace(tzinfo=timezone.utc)
    day = (datetime.now(timezone.utc) - adopted).days + 1
    size = max(1, min(50, size))
    current_page = (cur_idx // size) if eps else 0
    # Sentinel page=-1 = "auto-jump to the page containing the current
    # clip". Used on first load so the learner doesn't always see the
    # beginning of a long path; subsequent Pager clicks pass an
    # explicit page number.
    if page < 0:
        page = current_page
    start = page * size
    page_slice = full_path[start:start + size]
    return MyAnchorOut(
        topic=_topic_card(ua.topic, len(eps)),
        day=max(1, day),
        done_count=len([e for e in eps if e.id in done]),
        total=len(eps),
        path=page_slice,
        page=page,
        page_size=size,
        current_page=current_page,
    )


@router.get("/anchor/topics", response_model=list[TopicCard])
async def list_topics(
    _: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Topics that actually have published content, for onboarding.

    Empty topics are hidden — you can't commit to a topic with nothing
    to listen to. Ordered by the curated topics.py order."""
    rows = (await db.execute(
        select(Episode.topic, func.count(Episode.id))
        .where(Episode.status == "published")
        .group_by(Episode.topic)
    )).all()
    # Prefer non-"other" topics; only include "other" if it's the only
    # topic with content (prod episodes imported before subtopic
    # classification can all sit in "other" — filtering it out then
    # leaves new users staring at an empty onboarding).
    real = [_topic_card(slug, n) for slug, n in rows if slug and n > 0 and slug != "other"]
    other = [_topic_card(slug, n) for slug, n in rows if slug == "other" and n > 0]
    cards = real if real else other
    cards.sort(key=lambda c: _TOPIC_ORDER.get(c.slug, 999))
    return cards


@router.get("/me/anchor", response_model=MyAnchorOut | None)
async def get_my_anchor(
    page: int = -1,
    size: int = 10,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """The user's committed topic + derived path. null = not onboarded.

    Path is paginated (size 10 by default) — frontend Home shows
    page-number navigation. Default page=-1 means "the page containing
    the current clip" so first load doesn't land on segment 1 when the
    learner is on segment 25.
    """
    ua = await db.scalar(select(UserAnchor).where(UserAnchor.user_id == user.id))
    if ua is None:
        return None
    return await _my_anchor_out(db, ua, page=page, size=size)


class AdoptIn(BaseModel):
    topic: str
    level: int = 2


@router.post("/me/anchor", response_model=MyAnchorOut)
async def adopt_anchor(
    body: AdoptIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bind to a topic (onboarding). 409 if one already exists — the
    client must go through /me/anchor/switch (friction screen)."""
    if body.topic not in _TOPIC_META:
        raise HTTPException(404, "unknown topic")
    existing = await db.scalar(select(UserAnchor).where(UserAnchor.user_id == user.id))
    if existing is not None:
        raise HTTPException(409, "already committed; use /me/anchor/switch")
    ua = UserAnchor(user_id=user.id, topic=body.topic, level=body.level, done_episode_ids=[])
    db.add(ua)
    await db.commit()
    await db.refresh(ua)
    return await _my_anchor_out(db, ua)


@router.post("/me/anchor/advance", response_model=MyAnchorOut)
async def advance_anchor(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark the current episode 啃透 (Phase 1: finished) → unlock next."""
    ua = await db.scalar(select(UserAnchor).where(UserAnchor.user_id == user.id))
    if ua is None:
        raise HTTPException(400, "no active topic")
    eps = await _published_in_topic(db, ua.topic)
    done = set(ua.done_episode_ids or [])
    cur = next((e for e in eps if e.id not in done), None)
    if cur is not None:
        done.add(cur.id)
        ua.done_episode_ids = sorted(done)
        await db.commit()
        await db.refresh(ua)
    return await _my_anchor_out(db, ua)


@router.post("/me/anchor/switch", response_model=MyAnchorOut)
async def switch_anchor(
    body: AdoptIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Friction-confirmed switch: reset progress + rebind to a topic.
    Re-selecting the same topic is a deliberate restart."""
    if body.topic not in _TOPIC_META:
        raise HTTPException(404, "unknown topic")
    ua = await db.scalar(select(UserAnchor).where(UserAnchor.user_id == user.id))
    if ua is None:
        ua = UserAnchor(user_id=user.id, topic=body.topic, level=body.level, done_episode_ids=[])
        db.add(ua)
    else:
        ua.topic = body.topic
        ua.level = body.level
        ua.done_episode_ids = []
        ua.adopted_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ua)
    return await _my_anchor_out(db, ua)
