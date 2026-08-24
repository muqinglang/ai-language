from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


class Category(Base):
    __tablename__ = "categories"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    icon: Mapped[str] = mapped_column(String(8), default="")
    sort: Mapped[int] = mapped_column(Integer, default=0)


class Speaker(Base):
    """The YouTube creator / channel an episode belongs to.

    Exposed as "Creator" in the UI — a single Speaker row aggregates all
    episodes from the same YouTube channel, enabling channel-level study
    paths ("all Nika Erculj episodes") alongside topic/category paths.
    """

    __tablename__ = "speakers"
    id: Mapped[int] = mapped_column(primary_key=True)
    handle: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(128))
    avatar: Mapped[str] = mapped_column(String(512), default="")
    youtube_url: Mapped[str] = mapped_column(String(512), default="")
    # YouTube channel_id (UCXXX) — stable across handle changes. Populated
    # by pipeline stage 1 from yt-dlp metadata. Old rows stay empty until
    # the episode is re-imported.
    channel_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    # 1-2 sentence editorial description shown on the creator hub page.
    description: Mapped[str] = mapped_column(Text, default="")
    default_accent: Mapped[str] = mapped_column(String(16), default="US")
    default_gender: Mapped[str] = mapped_column(String(8), default="male")


class Episode(Base):
    __tablename__ = "episodes"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    summary: Mapped[str] = mapped_column(Text, default="")

    youtube_url: Mapped[str] = mapped_column(String(512), default="")
    video_url: Mapped[str] = mapped_column(String(512), default="")
    # Video stream codec of the stored file: "h264" (iPhone-safe),
    # "av1"/"vp9" (broken on iPhone 14 and earlier), or "" (not yet
    # probed — legacy rows). Filled by the admin "扫描编码" scan and
    # set to "h264" after a successful transcode. New imports record it
    # at pipeline ingest time.
    video_codec: Mapped[str] = mapped_column(String(16), default="")
    thumbnail_url: Mapped[str] = mapped_column(String(512), default="")
    duration_sec: Mapped[int] = mapped_column(Integer, default=0)

    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    speaker_id: Mapped[int | None] = mapped_column(ForeignKey("speakers.id"))
    # Subject topic — orthogonal to category (which is video FORMAT).
    # Single slug from a fixed enum (see services/topics.py).  Used for
    # narrow-listening study paths so vocabulary repeats across episodes.
    topic: Mapped[str] = mapped_column(String(32), default="other", index=True)
    # Free-text sub-tag inside the topic (e.g. "cooking" / "interview-prep"
    # / "gpt-prompts"). Empty when LLM can't tell or admin hasn't set it.
    # Used as a clustering key in topic-anchor path ordering so a learner
    # naturally hears all cooking clips before all shopping clips within
    # the "lifestyle" topic — narrow listening at the sub-domain level.
    subtopic: Mapped[str] = mapped_column(String(64), default="", index=True)

    accent: Mapped[str] = mapped_column(String(16), default="US")
    difficulty: Mapped[int] = mapped_column(Integer, default=3)  # 1–5
    chunks_count: Mapped[int] = mapped_column(Integer, default=0)
    subtitles_count: Mapped[int] = mapped_column(Integer, default=0)

    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft/reviewing/published/archived
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Collection grouping. When a long YouTube video is imported in "full"
    # mode, the pipeline splits it into N coherent 2-3 min segments and
    # creates one Episode per segment, all sharing `youtube_url`.
    # collection_kind:
    #   "full"      — part of an end-to-end split of the whole video
    #   "highlight" — current 1-or-N hand-picked highlight mode
    #   None        — legacy / unspecified
    # segment_index: 1-based position within the collection (NULL for
    # single-segment / legacy episodes).
    collection_kind: Mapped[str | None] = mapped_column(String(16), default=None, index=True)
    segment_index: Mapped[int | None] = mapped_column(Integer, default=None)

    # Import strategy chosen by the admin at create time:
    #   "segment"  — classic 2-3 min highlight clip (default, back-compat)
    #   "chapters" — full video imported as-is, with AI-generated chapter
    #                markers in the episode_chapters table for navigation.
    # `collection_kind="full"` (the legacy Collection-mode multi-episode split)
    # remains queryable on old data but is no longer offered for new imports.
    import_mode: Mapped[str] = mapped_column(String(16), default="segment", index=True)

    ai_metadata: Mapped[dict] = mapped_column(JSON, default=dict)

    category: Mapped["Category | None"] = relationship(lazy="joined")
    speaker: Mapped["Speaker | None"] = relationship(lazy="joined")

    @property
    def summary_zh(self) -> str:
        """Chinese clip summary, generated at pipeline stage 5 and stashed
        in ai_metadata.  Exposed as a plain attribute so Pydantic's
        `from_attributes` serialisation picks it up without extra glue."""
        meta = self.ai_metadata or {}
        if isinstance(meta, dict):
            return str(meta.get("summary_zh") or "").strip()
        return ""

    @property
    def lesson_brief(self) -> dict | None:
        """Pre-generated structured "Lesson Brief" shown above the AI chat:
        core_points / target_chunks_hint / speaking_prompts / discussion_question.
        Generated once at pipeline stage 5 (or via admin regenerate) and
        stashed in ai_metadata.lesson_brief.  Returns None for episodes
        imported before this feature shipped — the frontend hides the card
        in that case (back-compat path)."""
        meta = self.ai_metadata or {}
        if isinstance(meta, dict):
            v = meta.get("lesson_brief")
            if isinstance(v, dict):
                return v
        return None


class Subtitle(Base):
    __tablename__ = "subtitles"
    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episodes.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    text_en: Mapped[str] = mapped_column(Text)
    text_zh: Mapped[str] = mapped_column(Text, default="")
    # chunk ids referenced by this subtitle
    chunk_refs: Mapped[list] = mapped_column(JSON, default=list)
    # [[word, start_ms], ...] for karaoke-style per-word highlighting.
    # Extracted from YouTube VTT <c> tags. Empty for whisper-transcribed rows.
    word_timings: Mapped[list] = mapped_column(JSON, default=list)


class EpisodeChapter(Base):
    """AI-generated chapter marker inside a full-video Episode.

    Only populated when Episode.import_mode == "chapters".  Pure navigation:
    clicking a chapter in the Learn page seeks the video and scrolls the
    subtitle list — it does NOT scope the AI conversation or chunks (those
    remain whole-episode).
    """

    __tablename__ = "episode_chapters"
    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(
        ForeignKey("episodes.id", ondelete="CASCADE"), index=True
    )
    # 1-based position; lets the UI render "#3 · Chapter title" without an
    # extra count query.
    order_idx: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    title_en: Mapped[str] = mapped_column(String(255))
    title_zh: Mapped[str] = mapped_column(String(255), default="")
    summary_zh: Mapped[str] = mapped_column(Text, default="")
