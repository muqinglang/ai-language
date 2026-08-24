from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class Progress(Base):
    __tablename__ = "progress"
    __table_args__ = (UniqueConstraint("user_id", "episode_id", name="uq_progress_user_ep"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episodes.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="in_progress")  # in_progress | finished
    last_seq: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Favorite(Base):
    __tablename__ = "favorites"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(16))  # episode | subtitle | chunk
    target_id: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Note(Base):
    __tablename__ = "notes"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episodes.id", ondelete="CASCADE"), index=True)
    subtitle_id: Mapped[int | None] = mapped_column(ForeignKey("subtitles.id", ondelete="CASCADE"))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Vocabulary(Base):
    __tablename__ = "vocabulary"
    __table_args__ = (
        UniqueConstraint("user_id", "word", name="uq_vocab_user_word"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    word: Mapped[str] = mapped_column(String(64), index=True)
    # Short CEFR-friendly definition (English) + zh gloss + example sentence.
    # Stored verbatim from the LLM lookup so we don't re-pay per review.
    definition_en: Mapped[str] = mapped_column(Text, default="")
    definition_zh: Mapped[str] = mapped_column(Text, default="")
    example: Mapped[str] = mapped_column(Text, default="")
    # US General American IPA, e.g. /ˈkɝːəntli/.  Stored empty for words
    # saved before IPA support landed — user can re-look-up to backfill.
    # `ipa` is the legacy single field, mirrors `ipa_us` for old clients.
    ipa: Mapped[str] = mapped_column(String(128), default="")
    # Rich Eudic-style fields (backfilled lazily on first review for old rows).
    ipa_uk: Mapped[str] = mapped_column(String(128), default="")
    ipa_us: Mapped[str] = mapped_column(String(128), default="")
    inflections: Mapped[str] = mapped_column(String(160), default="")
    # [{pos, zh, en}] dictionary-style sense list, most relevant first.
    senses: Mapped[list] = mapped_column(JSON, default=list)
    # Where the user first tapped this word — lets the review page jump back
    # to the originating subtitle/episode for context recall.
    context_episode_id: Mapped[int | None] = mapped_column(ForeignKey("episodes.id", ondelete="SET NULL"))
    context_subtitle_id: Mapped[int | None] = mapped_column(ForeignKey("subtitles.id", ondelete="SET NULL"))
    context_text: Mapped[str] = mapped_column(Text, default="")
    # 0 = new, 1 = seen, 2 = learning, 3 = mastered
    mastery: Mapped[int] = mapped_column(Integer, default=0)
    # Spaced repetition (SM-2-lite).  next_review_at = when this word
    # comes due in the daily flashcard pile.  NULL means "not scheduled
    # yet" (treated as due immediately).
    next_review_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
