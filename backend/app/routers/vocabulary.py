"""Word lookup + personal vocabulary book."""
import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from ..auth import current_user
from ..db import get_db
from ..models import Episode, Subtitle, User, Vocabulary
from ..schemas import Page
from ..services import llm
from .user_llm import load_override, note_byok_error, require_override
from ..services.dictionary import (
    free_dict_lookup,
    load_cached,
    save_cache,
    youdao_lookup,
)

router = APIRouter(prefix="/api", tags=["vocabulary"])

# SM-2-lite intervals (days) keyed by mastery AFTER review.
# Mastery 0-3.  3 = mastered (won't surface in review queue).
_REVIEW_INTERVALS_DAYS = {0: 0, 1: 1, 2: 3, 3: 7}


def _next_review_at(new_mastery: int) -> datetime | None:
    """Return when the word should next surface, or None if mastered."""
    if new_mastery >= 3:
        return None
    days = _REVIEW_INTERVALS_DAYS.get(new_mastery, 1)
    return datetime.now(timezone.utc) + timedelta(days=days)


class Sense(BaseModel):
    """One dictionary-style sense: part of speech + zh gloss + en def."""
    pos: str = ""
    zh: str = ""
    en: str = ""


# ============ Word lookup (uncached peek — not saved) ============
class WordLookupIn(BaseModel):
    word: str
    context: str = ""


class WordLookupOut(BaseModel):
    word: str
    ipa: str = ""
    ipa_uk: str = ""
    ipa_us: str = ""
    inflections: str = ""
    senses: list[Sense] = []
    definition_en: str
    definition_zh: str
    example: str
    # "llm" (preferred, context-aware Chinese + English) or "dict"
    # (Free Dictionary fallback when the LLM trio is unavailable;
    # English-only — frontend shows "中文释义待补" hint).
    source: str = "llm"


@router.post("/words/lookup", response_model=WordLookupOut)
async def word_lookup(
    body: WordLookupIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Word lookup with cost-optimised tiered fallback.

    Order:
      1. Cache — last-good answer, instant + free (no network).
      2. Youdao 英汉 — free, no key, domestic; Chinese senses + IPA +
         bilingual example. The primary, so the high-frequency quick
         lookup no longer hits the paid LLM.
      3. LLM — fallback for tokens Youdao doesn't know (rare / proper
         nouns), where context-aware sense-picking matters most anyway.
      4. Free Dictionary — English-only last resort.
      5. 502.

    Every non-cache success writes the cache. The deliberate, slower
    "在视频里详细解释" (ask-in-context) path is separate and still LLM.
    """
    word = re.sub(r"[^A-Za-z'-]", "", body.word).strip().lower()
    if not word:
        raise HTTPException(400, "empty word")

    # 1. Cache — last-good answer for this word (any prior source).
    cached = await load_cached(db, word)
    if cached:
        return WordLookupOut(**{k: v for k, v in cached.items() if k != "source"},
                             source=cached.get("source", "llm"))

    # 2. Youdao — free Chinese dictionary; the primary path now.
    youdao = await youdao_lookup(word)
    if youdao:
        await save_cache(db, word, youdao, "youdao")
        return WordLookupOut(**youdao, source="youdao")

    # 3. LLM — fallback (context-aware Chinese + idiomatic examples).
    #    ONLY on the learner's own key. Unlike the chat endpoints this one
    #    does not 428 when there isn't one: steps 2 and 4 are free
    #    dictionaries that answer the question at nobody's expense, and no
    #    model choice is being made on the learner's behalf. Refusing to
    #    look up a word because they haven't pasted an API key would be
    #    punishing them for a setting this path doesn't need.
    override = await load_override(db, user)
    if override is not None:
        try:
            result = await asyncio.to_thread(
                llm.lookup_word, word, body.context, user.role == "admin", override,
            )
        except llm.BYOKCallFailed as e:
            # Unlike the chat endpoints, this one has somewhere else to go:
            # step 4 is a free dictionary that costs nobody anything. Note
            # the failure for the settings page and keep walking the chain
            # rather than handing back an error for a single word.
            await note_byok_error(db, user.id, str(e))
            result = None
        if result:
            await save_cache(db, word, result, "llm")
            return WordLookupOut(**result, source="llm")

    # 4. Free Dictionary — English-only, no API key.
    dictionary = await free_dict_lookup(word)
    if dictionary:
        await save_cache(db, word, dictionary, "dict")
        return WordLookupOut(**dictionary, source="dict")

    # 5. Genuine miss — likely a misspelling or genuinely unknown token.
    raise HTTPException(502, "lookup failed")


# ============ Phrase / sentence explanation in episode context ============
class ExplainInContextIn(BaseModel):
    # Whatever the learner highlighted — could be a single word, a phrase,
    # or a whole sentence. We don't trim or canonicalise; the LLM handles it.
    query: str
    episode_id: int
    subtitle_id: int | None = None


class ExplainInContextOut(BaseModel):
    query: str
    markdown: str


@router.post("/words/explain-in-context", response_model=ExplainInContextOut)
async def explain_in_context(
    body: ExplainInContextIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rich, context-aware explanation of a word/phrase/sentence the learner
    asked about. Pulls the surrounding subtitles (±2) and episode metadata
    so the LLM can ground its explanation in what's actually being said
    rather than guessing in the abstract."""
    query = (body.query or "").strip()
    if not query:
        raise HTTPException(400, "empty query")
    if len(query) > 400:
        raise HTTPException(400, "query too long (max 400 chars)")

    ep = await db.get(Episode, body.episode_id)
    if not ep:
        raise HTTPException(404, "episode not found")

    # Surrounding subs: pull the asked-about line + 2 before + 2 after by seq.
    query_sub_text = ""
    context_subs: list[str] = []
    if body.subtitle_id:
        target = await db.get(Subtitle, body.subtitle_id)
        if target and target.episode_id == ep.id:
            query_sub_text = target.text_en
            window = (await db.execute(
                select(Subtitle)
                .where(
                    Subtitle.episode_id == ep.id,
                    Subtitle.seq.between(target.seq - 2, target.seq + 2),
                )
                .order_by(Subtitle.seq)
            )).scalars().all()
            context_subs = [s.text_en for s in window if s.id != target.id]

    # The learner's own key, or 428 — same rule as the AI chat, and for the
    # same reason. Unlike /words/lookup two functions up, this endpoint has no
    # free fallback to walk to: a dictionary cannot explain what a line means
    # in this video, so there is no answer to hand back at nobody's expense.
    # It is also squarely "a model answering this one learner's question",
    # which is exactly what BYOK exists to bill to that learner.
    override = await require_override(db, user)
    try:
        md = await asyncio.to_thread(
            llm.explain_in_context,
            query,
            ep.title or "",
            ep.summary or "",
            ep.topic or "",
            query_sub_text,
            context_subs,
            user.role == "admin",
            override,
        )
    except llm.BYOKCallFailed as e:
        await note_byok_error(db, user.id, str(e))
        raise HTTPException(502, str(e)) from e
    if not md:
        raise HTTPException(502, "explanation failed")
    return ExplainInContextOut(query=query, markdown=md)


# ============ Vocabulary CRUD ============
class VocabCreate(BaseModel):
    word: str
    ipa: str = ""
    ipa_uk: str = ""
    ipa_us: str = ""
    inflections: str = ""
    senses: list[Sense] = []
    definition_en: str = ""
    definition_zh: str = ""
    example: str = ""
    context_episode_id: int | None = None
    context_subtitle_id: int | None = None
    context_text: str = ""


class VocabOut(BaseModel):
    id: int
    word: str
    ipa: str = ""
    ipa_uk: str = ""
    ipa_us: str = ""
    inflections: str = ""
    senses: list[Sense] = []
    definition_en: str
    definition_zh: str
    example: str
    context_episode_id: int | None
    context_subtitle_id: int | None
    context_text: str
    mastery: int
    next_review_at: datetime | None = None
    last_reviewed_at: datetime | None = None
    review_count: int = 0


class VocabUpdate(BaseModel):
    mastery: int | None = None


class VocabReviewIn(BaseModel):
    # Legacy binary signal (kept so older clients keep working).
    remembered: bool | None = None
    # New 3-level grade from the flashcard UI:
    #   "got"    → mastery +1   (knew it)
    #   "fuzzy"  → mastery same, re-surface ~1 day (half-knew it)
    #   "forgot" → mastery -1   (blanked)
    # When grade is given it wins; otherwise we fall back to `remembered`.
    grade: Literal["forgot", "fuzzy", "got"] | None = None


@router.post("/vocabulary", response_model=VocabOut)
async def add_vocabulary(
    body: VocabCreate,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    word = re.sub(r"[^A-Za-z'-]", "", body.word).strip().lower()
    if not word:
        raise HTTPException(400, "empty word")
    # If we have episode/subtitle refs, auto-fill context_text from the DB
    # when the caller didn't provide it — saves a round-trip.
    ctx_text = body.context_text
    if not ctx_text and body.context_subtitle_id:
        sub = await db.get(Subtitle, body.context_subtitle_id)
        if sub:
            ctx_text = sub.text_en
    row = Vocabulary(
        user_id=user.id, word=word,
        ipa=body.ipa or body.ipa_us,
        ipa_uk=body.ipa_uk, ipa_us=body.ipa_us or body.ipa,
        inflections=body.inflections,
        senses=[s.model_dump() for s in body.senses],
        definition_en=body.definition_en, definition_zh=body.definition_zh,
        example=body.example, context_episode_id=body.context_episode_id,
        context_subtitle_id=body.context_subtitle_id, context_text=ctx_text,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # Already in book — return the existing row so the frontend can still
        # reflect the "saved" state without noise.
        existing = (await db.execute(
            select(Vocabulary).where(
                Vocabulary.user_id == user.id, Vocabulary.word == word
            )
        )).scalar_one()
        return _serialise(existing)
    await db.refresh(row)
    return _serialise(row)


@router.get("/vocabulary", response_model=Page[VocabOut])
async def list_vocabulary(
    mastery: int | None = None,
    q: str | None = None,
    limit: int = 30,
    offset: int = 0,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """List the user's vocabulary, newest first.

    - `mastery`: 0-3 to filter by mastery bucket.
    - `q`: substring search on the word itself (case-insensitive).
    - `limit` / `offset`: pagination. Envelope carries total + has_more.
    """
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    where = [Vocabulary.user_id == user.id]
    if mastery is not None:
        where.append(Vocabulary.mastery == mastery)
    if q:
        where.append(Vocabulary.word.ilike(f"%{q}%"))
    total = int(await db.scalar(
        select(func.count(Vocabulary.id)).where(*where)
    ) or 0)
    rows = (await db.execute(
        select(Vocabulary).where(*where)
        .order_by(Vocabulary.created_at.desc())
        .limit(limit).offset(offset)
    )).scalars().all()
    items = [_serialise(r) for r in rows]
    return Page(items=items, total=total, has_more=offset + len(items) < total)


@router.patch("/vocabulary/{vocab_id}", response_model=VocabOut)
async def update_vocabulary(
    vocab_id: int,
    body: VocabUpdate,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Vocabulary, vocab_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "not found")
    if body.mastery is not None:
        row.mastery = max(0, min(3, body.mastery))
        # Manual mastery edits reschedule too — same SR interval table.
        row.next_review_at = _next_review_at(row.mastery)
    await db.commit()
    await db.refresh(row)
    return _serialise(row)


@router.delete("/vocabulary/{vocab_id}")
async def delete_vocabulary(
    vocab_id: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Vocabulary, vocab_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.get("/vocabulary/due", response_model=list[VocabOut])
async def list_due_vocabulary(
    limit: int = 20,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return words due for review (next_review_at <= now OR null)."""
    now = datetime.now(timezone.utc)
    q = (
        select(Vocabulary)
        .where(Vocabulary.user_id == user.id)
        .where(Vocabulary.mastery < 3)
        .where(
            (Vocabulary.next_review_at == None)  # noqa: E711  null = never reviewed
            | (Vocabulary.next_review_at <= now)
        )
        .order_by(Vocabulary.next_review_at.asc().nulls_first())
        .limit(limit)
    )
    rows = (await db.execute(q)).scalars().all()
    return [_serialise(r) for r in rows]


@router.post("/vocabulary/{vocab_id}/review", response_model=VocabOut)
async def review_vocabulary(
    vocab_id: int,
    body: VocabReviewIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Grade a flashcard (got / fuzzy / forgot). Adjusts mastery + schedule."""
    row = await db.get(Vocabulary, vocab_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "not found")

    # Resolve the effective grade. Prefer the explicit 3-level grade;
    # fall back to the legacy boolean for old clients.
    grade = body.grade
    if grade is None:
        grade = "got" if body.remembered else "forgot"

    if grade == "got":
        row.mastery = min(3, row.mastery + 1)
        row.next_review_at = _next_review_at(row.mastery)
    elif grade == "fuzzy":
        # Half-knew it: don't move mastery, but bring it back soon so the
        # shaky word gets another pass instead of disappearing for days.
        row.next_review_at = datetime.now(timezone.utc) + timedelta(days=1)
    else:  # forgot — drop a notch (never below 0) so it loops back sooner.
        row.mastery = max(0, row.mastery - 1)
        row.next_review_at = _next_review_at(row.mastery)

    row.review_count = (row.review_count or 0) + 1
    row.last_reviewed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return _serialise(row)


@router.post("/vocabulary/{vocab_id}/enrich", response_model=VocabOut)
async def enrich_vocabulary(
    vocab_id: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Lazily backfill Eudic-style rich fields (dual IPA / senses /
    inflections) for a word saved before rich-lookup landed. No-op if the
    row already has senses. Called by the flashcard when a card is flipped."""
    row = await db.get(Vocabulary, vocab_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "not found")
    if row.senses:  # already rich — nothing to do
        return _serialise(row)
    override = await load_override(db, user)
    if override is None:
        # Opportunistic enrichment on the learner's own key. No key, no
        # enrichment — the card renders fine without it, so this is not
        # worth a 428 in the middle of a flashcard session.
        return _serialise(row)
    try:
        result = await asyncio.to_thread(
            llm.lookup_word, row.word, row.context_text or "", user.role == "admin",
            override,
        )
    except llm.BYOKCallFailed as e:
        # Backfill is opportunistic — the card still renders without it.
        await note_byok_error(db, user.id, str(e))
        return _serialise(row)
    if result and result.get("senses"):
        row.ipa_uk = result.get("ipa_uk", "") or row.ipa_uk
        row.ipa_us = result.get("ipa_us", "") or row.ipa_us or row.ipa
        row.ipa = row.ipa or result.get("ipa", "")
        row.inflections = result.get("inflections", "") or row.inflections
        row.senses = result.get("senses", [])
        if not row.definition_en:
            row.definition_en = result.get("definition_en", "")
        if not row.definition_zh:
            row.definition_zh = result.get("definition_zh", "")
        if not row.example:
            row.example = result.get("example", "")
        await db.commit()
        await db.refresh(row)
    return _serialise(row)


def _serialise(v: Vocabulary) -> VocabOut:
    return VocabOut(
        id=v.id, word=v.word, ipa=v.ipa or "",
        ipa_uk=v.ipa_uk or "", ipa_us=v.ipa_us or (v.ipa or ""),
        inflections=v.inflections or "",
        senses=[Sense(**s) for s in (v.senses or []) if isinstance(s, dict)],
        definition_en=v.definition_en, definition_zh=v.definition_zh,
        example=v.example, context_episode_id=v.context_episode_id,
        context_subtitle_id=v.context_subtitle_id, context_text=v.context_text,
        mastery=v.mastery,
        next_review_at=v.next_review_at, last_reviewed_at=v.last_reviewed_at,
        review_count=v.review_count or 0,
    )
