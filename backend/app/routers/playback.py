"""Play queue — what plays after this clip ends.

Built for one scenario: the learner is on a commute, phone in a pocket,
screen locked. Nobody is going to tap "next". So the client needs to know
the whole running order up front, because once the screen is off it can't
fetch a page and re-render to find out.

Which order? Whichever of these fits first:

1. **The collection** this clip belongs to — a long video split into N
   segments. If you're listening to part 3, part 4 is unambiguously next.
2. **The topic mainline** (`/me/anchor`) — the learner's own curriculum,
   already ordered for narrow listening (difficulty → subtopic → creator).
   This is the common case: most imports are single-segment, so without it
   auto-advance would stop after every clip.
3. **Everything published**, newest first — for learners in 自由模式 who
   never adopted a topic.

The queue deliberately ignores the mainline's `locked` gating. That gate
exists to stop someone skipping ahead in *study* mode; passive listening
isn't studying, and a queue that stops at the first unlocked clip would
end about ten seconds after it started.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import Episode, User, UserAnchor
from ..schemas import _absolutize_relative_media
from .anchors import _published_in_topic

router = APIRouter(prefix="/api/me", tags=["playback"])

# One clip is ~2-3 minutes, so 60 is roughly three hours of listening —
# past any commute, and small enough to ship in one response.
_MAX_QUEUE = 60


class QueueItem(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    title: str
    video_url: str
    thumbnail_url: str = ""
    duration_sec: int = 0
    creator: str = ""

    @field_validator("video_url", "thumbnail_url", mode="after")
    @classmethod
    def _absolutize(cls, v: str) -> str:
        # Same rewrite as EpisodeDetail.video_url — the queue hands the
        # player real srcs, so they must point at the same media host.
        return _absolutize_relative_media(v)


class PlayQueueOut(BaseModel):
    # Which rule produced this order — the UI names it ("合集顺序播" vs
    # "话题主线连播") so the learner knows what they're about to hear.
    source: str
    topic: str = ""
    current_index: int
    items: list[QueueItem]


def _yt_id(url: str) -> str:
    m = re.search(r"[A-Za-z0-9_-]{11}", url or "")
    return m.group(0) if m else ""


def _to_item(ep: Episode) -> QueueItem:
    return QueueItem(
        id=ep.id,
        title=ep.title or "",
        video_url=ep.video_url or "",
        thumbnail_url=ep.thumbnail_url or "",
        duration_sec=ep.duration_sec or 0,
        creator=(ep.speaker.name if ep.speaker else ""),
    )


@router.get("/play-queue", response_model=PlayQueueOut)
async def play_queue(
    from_episode: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    current = await db.get(Episode, from_episode)
    if not current:
        raise HTTPException(404, "episode not found")

    published = (await db.execute(
        select(Episode).where(Episode.status == "published")
    )).scalars().all()

    # 1. Collection — segments of the same source video.
    yt = _yt_id(current.youtube_url or "")
    if yt:
        siblings = [e for e in published if _yt_id(e.youtube_url or "") == yt]
        if len(siblings) > 1:
            siblings.sort(key=lambda e: (e.segment_index or 0, e.id))
            items = [_to_item(e) for e in siblings if e.video_url]
            idx = next((i for i, e in enumerate(items) if e.id == current.id), 0)
            return PlayQueueOut(source="collection", current_index=idx, items=items)

    # 2. Topic mainline.
    anchor = await db.scalar(select(UserAnchor).where(UserAnchor.user_id == user.id))
    if anchor and anchor.topic:
        eps = await _published_in_topic(db, anchor.topic)
        items = [_to_item(e) for e in eps if e.video_url]
        idx = next((i for i, e in enumerate(items) if e.id == current.id), -1)
        if idx >= 0 and len(items) > 1:
            return PlayQueueOut(
                source="anchor", topic=anchor.topic,
                current_index=idx, items=items[:_MAX_QUEUE],
            )

    # 3. Everything, newest first. Also the fallback when the current clip
    #    isn't in the learner's topic at all (they opened it from Discover).
    rest = sorted(
        [e for e in published if e.video_url], key=lambda e: e.id, reverse=True,
    )
    items = [_to_item(e) for e in rest]
    idx = next((i for i, e in enumerate(items) if e.id == current.id), 0)
    # Keep the current clip inside the window we return.
    start = max(0, idx - 5)
    window = items[start:start + _MAX_QUEUE]
    return PlayQueueOut(
        source="all",
        current_index=next((i for i, e in enumerate(window) if e.id == current.id), 0),
        items=window,
    )
