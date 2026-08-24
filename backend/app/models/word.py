from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class FeaturedWord(Base):
    """LLM-selected "key word of the episode" for focused vocabulary study.

    Unlike Vocabulary (user-collected) or Chunk (multi-word phrase), a
    FeaturedWord is the app's recommendation — typically 6-10 CEFR B2+
    words per episode chosen by the LLM pipeline for being high-value to
    learn. Rendered as flashcards on the Learn page "推荐词" tab and the
    global /words page.
    """

    __tablename__ = "featured_words"
    __table_args__ = (UniqueConstraint("episode_id", "word", name="uq_fw_ep_word"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(
        ForeignKey("episodes.id", ondelete="CASCADE"), index=True
    )
    word: Mapped[str] = mapped_column(String(64), index=True)
    ipa: Mapped[str] = mapped_column(String(128), default="")
    # Part of speech: adj / n / v / adv / phrase
    pos: Mapped[str] = mapped_column(String(16), default="")
    # CEFR level A1–C2 — frontends sort/filter by this.
    cefr: Mapped[str] = mapped_column(String(8), default="")
    definition_en: Mapped[str] = mapped_column(Text, default="")
    definition_zh: Mapped[str] = mapped_column(Text, default="")
    example: Mapped[str] = mapped_column(Text, default="")
    # First subtitle this word appears in — powers "jump to context".
    context_subtitle_id: Mapped[int | None] = mapped_column(
        ForeignKey("subtitles.id", ondelete="SET NULL")
    )
    context_text: Mapped[str] = mapped_column(Text, default="")
    # 1–5 importance ranking from the LLM. 5 = "this is THE word of the clip".
    importance: Mapped[int] = mapped_column(Integer, default=3)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class DictionaryCache(Base):
    """Tiered fallback cache for /words/lookup.

    Primary path is still the context-aware LLM call. This table holds
    the last successful lookup result for a word (regardless of source)
    so we have something to return when the LLM trio (OpenAI / DeepSeek
    / Claude) all stall or rate-limit. `source` records who answered:
    "llm" (preferred, context-aware) or "dict" (Free Dictionary API,
    English-only, no zh translations).

    Cached by bare word — context is lost on cache hits, but a cached
    answer is always strictly better than "查询失败，请重试".
    """
    __tablename__ = "dictionary_cache"

    # Lowercase, alpha-only word. Single-word lookups only; phrases use
    # explain-in-context which is intentionally LLM-only (cache there
    # would just serve stale generic explanations).
    word: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Full WordLookupOut payload as JSON (ipa_uk/us, inflections, senses,
    # legacy mirrored fields, example).
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    # "llm" | "dict" — used to tag the response so the frontend can
    # show "中文释义待补" when an LLM-failed dict-fallback served.
    source: Mapped[str] = mapped_column(String(16), default="llm")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
