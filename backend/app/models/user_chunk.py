from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class UserChunk(Base):
    """A phrase the learner highlighted themselves inside a subtitle line
    (the AI didn't pick it). Rendered like an AI chunk — colored span the
    user can tap to unmark. Matched back onto the subtitle by text, same
    as AI chunks, so we only need to store which line + the phrase."""

    __tablename__ = "user_chunks"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "subtitle_id", "text", name="uq_userchunk_user_sub_text"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    episode_id: Mapped[int] = mapped_column(
        ForeignKey("episodes.id", ondelete="CASCADE"), index=True
    )
    subtitle_id: Mapped[int] = mapped_column(
        ForeignKey("subtitles.id", ondelete="CASCADE"), index=True
    )
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
