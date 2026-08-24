from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import Chunk, Episode, Subtitle

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
async def search(
    q: str = Query(..., min_length=1),
    type: str = Query("all", pattern="^(all|subtitle|chunk|episode)$"),
    limit: int = 30,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """Global search across episodes, subtitles and chunks.

    type="all" is a preview (top N of each, no load-more). A specific
    type supports limit/offset paging: `has_more[type]` tells the
    frontend whether a "load more" button should show. has_more is
    computed with the limit+1 trick — fetch one extra row, trim it,
    skip a separate count query.
    """
    limit = max(1, min(100, limit))
    offset = max(0, offset)
    pattern = f"%{q}%"
    result: dict[str, list] = {"episodes": [], "subtitles": [], "chunks": []}
    has_more = {"episodes": False, "subtitles": False, "chunks": False}
    probe = limit + 1  # fetch one extra to detect "more"

    if type in ("all", "episode"):
        eps = (await db.execute(
            select(Episode)
            .where(
                Episode.status == "published",
                or_(Episode.title.ilike(pattern), Episode.summary.ilike(pattern)),
            )
            .order_by(Episode.published_at.desc().nulls_last())
            .limit(probe).offset(offset)
        )).scalars().all()
        has_more["episodes"] = len(eps) > limit
        result["episodes"] = [
            {
                "id": e.id, "title": e.title, "summary": e.summary,
                "thumbnail_url": e.thumbnail_url, "duration_sec": e.duration_sec,
                "difficulty": e.difficulty, "accent": e.accent,
            }
            for e in eps[:limit]
        ]

    if type in ("all", "subtitle"):
        subs = (await db.execute(
            select(Subtitle, Episode)
            .join(Episode, Subtitle.episode_id == Episode.id)
            .where(
                Episode.status == "published",
                or_(Subtitle.text_en.ilike(pattern), Subtitle.text_zh.ilike(pattern)),
            )
            .limit(probe).offset(offset)
        )).all()
        has_more["subtitles"] = len(subs) > limit
        result["subtitles"] = [
            {
                "id": s.id, "episode_id": s.episode_id, "episode_title": e.title,
                "seq": s.seq, "start_ms": s.start_ms,
                "text_en": s.text_en, "text_zh": s.text_zh,
            }
            for s, e in subs[:limit]
        ]

    if type in ("all", "chunk"):
        chunks = (await db.execute(
            select(Chunk, Episode)
            .join(Episode, Chunk.episode_id == Episode.id)
            .where(
                Episode.status == "published",
                or_(
                    Chunk.text.ilike(pattern),
                    Chunk.why_explanation.ilike(pattern),
                    Chunk.usage_scenario.ilike(pattern),
                ),
            )
            .limit(probe).offset(offset)
        )).all()
        has_more["chunks"] = len(chunks) > limit
        result["chunks"] = [
            {
                "id": c.id, "episode_id": c.episode_id, "episode_title": e.title,
                "text": c.text, "chunk_type": c.chunk_type,
                "why_explanation": c.why_explanation,
            }
            for c, e in chunks[:limit]
        ]

    result["has_more"] = has_more
    return result
