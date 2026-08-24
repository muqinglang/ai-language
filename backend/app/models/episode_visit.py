from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class EpisodeVisit(Base):
    """Records the most recent time a user opened an episode page.

    Source of truth for the home page's "继续学习" rail.  Replaces the
    older AIConversation-based heuristic, which only counted users who
    actually clicked the AI tab — that missed listeners who watched the
    video / read subtitles without ever chatting.

    Composite PK on (user_id, episode_id) keeps it one row per pair and
    makes the upsert a simple "get or update last_visited_at".  Rows
    cascade-delete with their user/episode parents.

    The frontend pings POST /api/episodes/{id}/visit after the learner
    has been on the page for ~5s, so accidental click-and-bounce visits
    don't pollute the rail.
    """

    __tablename__ = "episode_visits"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    episode_id: Mapped[int] = mapped_column(
        ForeignKey("episodes.id", ondelete="CASCADE"), primary_key=True
    )
    last_visited_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        index=True,
    )
