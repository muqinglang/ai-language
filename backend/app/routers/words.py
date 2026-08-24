"""Featured words API — per-episode LLM-recommended key words.

Backfill-on-demand: if an episode has no FeaturedWord rows yet, calling
`GET /episodes/:id/featured_words` generates them once (transcript →
LLM → insert) then returns them. Future calls hit the cached rows.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user as get_current_user
from ..db import get_db
from ..models import Episode, FeaturedWord, Subtitle, User
from ..services import llm
from ..services.text_norm import normalize_proper_nouns
from .user_llm import note_byok_error, require_override

router = APIRouter(prefix="/api", tags=["words"])


class FeaturedWordOut(BaseModel):
    id: int
    word: str
    ipa: str
    pos: str
    cefr: str
    definition_en: str
    definition_zh: str
    example: str
    context_subtitle_id: int | None
    context_text: str
    importance: int

    model_config = {"from_attributes": True}


async def _extract_and_save(
    db: AsyncSession, episode: Episode, override=None,
) -> list[FeaturedWord]:
    """Ask the LLM for 6–10 featured words then persist them.

    `override` is the learner's own credentials on the reader-triggered
    path; the admin regenerate button and the import pipeline pass None and
    run on the platform key, which is admin work either way."""
    subs = (
        await db.execute(
            select(Subtitle)
            .where(Subtitle.episode_id == episode.id)
            .order_by(Subtitle.seq.asc())
        )
    ).scalars().all()
    transcript = "\n".join(s.text_en for s in subs if s.text_en)
    items = llm.featured_words(
        episode.title or "", episode.summary or "", transcript, override,
    )
    saved: list[FeaturedWord] = []
    lower_text = [(s.id, s.text_en.lower(), s.text_en) for s in subs]
    for it in items:
        # Find the first subtitle that contains this word for "jump to context".
        ctx_id: int | None = None
        ctx_text = ""
        for sid, low, orig in lower_text:
            if it["word"] in low.split():
                ctx_id = sid
                ctx_text = orig
                break
        fw = FeaturedWord(
            episode_id=episode.id,
            word=normalize_proper_nouns(it["word"]),
            ipa=it["ipa"],
            pos=it["pos"],
            cefr=it["cefr"],
            definition_en=normalize_proper_nouns(it["definition_en"]),
            definition_zh=it["definition_zh"],
            example=normalize_proper_nouns(it["example"]),
            context_subtitle_id=ctx_id,
            context_text=ctx_text,
            importance=it["importance"],
        )
        db.add(fw)
        saved.append(fw)
    await db.commit()
    for fw in saved:
        await db.refresh(fw)
    return saved


@router.get("/episodes/{episode_id}/featured_words", response_model=list[FeaturedWordOut])
async def list_episode_featured_words(
    episode_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ep = (
        await db.execute(select(Episode).where(Episode.id == episode_id))
    ).scalar_one_or_none()
    if not ep:
        raise HTTPException(404, "episode not found")

    existing = (
        await db.execute(
            select(FeaturedWord)
            .where(FeaturedWord.episode_id == episode_id)
            .order_by(FeaturedWord.importance.desc(), FeaturedWord.id.asc())
        )
    ).scalars().all()
    if existing:
        # Already generated (by the import pipeline, or by whoever opened
        # this tab first). Reading the cache calls no model, so it needs no
        # key — most learners never hit the branch below at all.
        return existing

    # Backfill path — an older episode whose words were never generated.
    # Generating is a model call this learner is triggering, so it runs on
    # their key and 428s without one, exactly like the AI tab.
    override = await require_override(db, user)
    try:
        saved = await _extract_and_save(db, ep, override)
    except llm.BYOKCallFailed as e:
        await note_byok_error(db, user.id, str(e))
        raise HTTPException(502, str(e)) from e
    saved.sort(key=lambda w: (-w.importance, w.id))
    return saved


@router.post("/admin/episodes/{episode_id}/featured_words/regenerate", response_model=list[FeaturedWordOut])
async def regenerate_featured_words(
    episode_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Admin-only: wipe + regenerate featured words for an episode."""
    if user.role != "admin":
        raise HTTPException(403, "admin only")
    ep = (
        await db.execute(select(Episode).where(Episode.id == episode_id))
    ).scalar_one_or_none()
    if not ep:
        raise HTTPException(404, "episode not found")
    await db.execute(delete(FeaturedWord).where(FeaturedWord.episode_id == episode_id))
    await db.commit()
    # admin 按的按钮 = admin 自己的 key，跟导入一致。
    saved = await _extract_and_save(db, ep, await require_override(db, user))
    saved.sort(key=lambda w: (-w.importance, w.id))
    return saved


class GlobalFeaturedWord(BaseModel):
    word: str
    ipa: str
    pos: str
    cefr: str
    definition_en: str
    definition_zh: str
    example: str
    episode_count: int
    top_episode_id: int


@router.get("/featured_words", response_model=list[GlobalFeaturedWord])
async def list_global_featured_words(
    cefr: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cross-episode aggregate — the same word may appear in multiple
    episodes; return one row per word with episode_count."""
    q = select(FeaturedWord).order_by(FeaturedWord.importance.desc(), FeaturedWord.id.asc())
    if cefr:
        q = q.where(FeaturedWord.cefr == cefr)
    rows = (await db.execute(q)).scalars().all()
    agg: dict[str, dict] = {}
    for r in rows:
        key = r.word
        if key not in agg:
            agg[key] = {
                "word": r.word,
                "ipa": r.ipa,
                "pos": r.pos,
                "cefr": r.cefr,
                "definition_en": r.definition_en,
                "definition_zh": r.definition_zh,
                "example": r.example,
                "episode_count": 0,
                "top_episode_id": r.episode_id,
            }
        agg[key]["episode_count"] += 1
    out = list(agg.values())
    out.sort(key=lambda w: (-w["episode_count"], w["word"]))
    return out[:limit]
