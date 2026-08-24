"""Creator (YouTube channel) aggregation endpoints.

A "Creator" is stored in the legacy `speakers` table — the row represents
a single YouTube channel. Surfaced in the UI as a hub page: channel
avatar + description + all episodes + aggregate stats (chunks count,
featured words count, topics covered).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user as get_current_user
from ..db import get_db
from ..models import Chunk, Episode, FeaturedWord, Speaker, User
from ..schemas import Page

router = APIRouter(prefix="/api/creators", tags=["creators"])


class CreatorRow(BaseModel):
    id: int
    name: str
    handle: str
    avatar: str
    youtube_url: str
    description: str
    default_accent: str
    episode_count: int
    # Most-covered topic slug across this creator's episodes.
    top_topic: str | None = None

    model_config = {"from_attributes": True}


class CreatorDetail(CreatorRow):
    total_duration_sec: int
    total_chunks: int
    total_featured_words: int
    topics: list[str]  # list of topic slugs this creator has covered


class CreatorEpisodeOut(BaseModel):
    id: int
    title: str
    summary: str
    summary_zh: str
    thumbnail_url: str
    duration_sec: int
    chunks_count: int
    topic: str
    difficulty: int
    accent: str
    status: str

    model_config = {"from_attributes": True}


@router.get("", response_model=list[CreatorRow])
async def list_creators(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Aggregate episode_count per speaker_id at query time — cheaper than
    # denormalizing onto the speakers row (would need trigger upkeep).
    counts_q = (
        select(Episode.speaker_id, func.count(Episode.id).label("cnt"))
        .where(Episode.speaker_id.is_not(None))
        .where(Episode.status == "published")
        .group_by(Episode.speaker_id)
    )
    counts = {row.speaker_id: row.cnt for row in (await db.execute(counts_q)).all()}
    if not counts:
        return []

    speakers = (
        await db.execute(select(Speaker).where(Speaker.id.in_(counts.keys())))
    ).scalars().all()

    # Find top topic per creator (first pass via grouped query).
    topic_q = (
        select(Episode.speaker_id, Episode.topic, func.count(Episode.id).label("cnt"))
        .where(Episode.speaker_id.in_(counts.keys()))
        .where(Episode.status == "published")
        .group_by(Episode.speaker_id, Episode.topic)
        .order_by(func.count(Episode.id).desc())
    )
    top_topic: dict[int, str] = {}
    for row in (await db.execute(topic_q)).all():
        # First row per speaker wins because we ordered by count desc.
        top_topic.setdefault(row.speaker_id, row.topic)

    out = []
    for s in speakers:
        out.append(CreatorRow(
            id=s.id,
            name=s.name or "",
            handle=s.handle or "",
            avatar=s.avatar or "",
            youtube_url=s.youtube_url or "",
            description=s.description or "",
            default_accent=s.default_accent or "US",
            episode_count=counts.get(s.id, 0),
            top_topic=top_topic.get(s.id),
        ))
    out.sort(key=lambda c: (-c.episode_count, c.name))
    return out


@router.get("/{creator_id}", response_model=CreatorDetail)
async def get_creator(
    creator_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    speaker = (
        await db.execute(select(Speaker).where(Speaker.id == creator_id))
    ).scalar_one_or_none()
    if not speaker:
        raise HTTPException(404, "creator not found")

    eps = (
        await db.execute(
            select(Episode)
            .where(Episode.speaker_id == creator_id)
            .where(Episode.status == "published")
            .order_by(Episode.created_at.desc())
        )
    ).scalars().all()

    total_chunks = (
        await db.execute(
            select(func.count(Chunk.id)).where(
                Chunk.episode_id.in_([e.id for e in eps] or [-1])
            )
        )
    ).scalar() or 0
    total_words = (
        await db.execute(
            select(func.count(FeaturedWord.id)).where(
                FeaturedWord.episode_id.in_([e.id for e in eps] or [-1])
            )
        )
    ).scalar() or 0

    topics = sorted({e.topic for e in eps if e.topic})
    # Derive top_topic the same way the list endpoint does.
    topic_counts: dict[str, int] = {}
    for e in eps:
        topic_counts[e.topic] = topic_counts.get(e.topic, 0) + 1
    top = max(topic_counts.items(), key=lambda kv: kv[1])[0] if topic_counts else None

    return CreatorDetail(
        id=speaker.id,
        name=speaker.name or "",
        handle=speaker.handle or "",
        avatar=speaker.avatar or "",
        youtube_url=speaker.youtube_url or "",
        description=speaker.description or "",
        default_accent=speaker.default_accent or "US",
        episode_count=len(eps),
        top_topic=top,
        total_duration_sec=sum(e.duration_sec or 0 for e in eps),
        total_chunks=total_chunks,
        total_featured_words=total_words,
        topics=topics,
    )


@router.get("/{creator_id}/episodes", response_model=Page[CreatorEpisodeOut])
async def list_creator_episodes(
    creator_id: int,
    limit: int = 30,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    limit = max(1, min(100, limit))
    offset = max(0, offset)
    where = [Episode.speaker_id == creator_id, Episode.status == "published"]
    total = int(await db.scalar(
        select(func.count(Episode.id)).where(*where)
    ) or 0)
    eps = list((await db.execute(
        select(Episode).where(*where)
        .order_by(Episode.created_at.desc())
        .limit(limit).offset(offset)
    )).scalars().all())
    return Page(items=eps, total=total, has_more=offset + len(eps) < total)
