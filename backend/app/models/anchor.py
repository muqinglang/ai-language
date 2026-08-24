from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class UserAnchor(Base):
    """The single TOPIC a user is currently committed to ("主线").

    Core method = narrow listening: stay on ONE topic (travel, cooking,
    …) for ~2 weeks so its vocabulary / collocations / discourse
    patterns recur until the learner can predict the next line. The
    binding axis is the topic, NOT a creator — speakers may vary within
    the path (same-creator clips are merely clustered when ordering).

    One row per user (unique) = "one topic at a time". Switching does
    not create a second row; it rebinds this one (topic changed,
    progress cleared), the product embodiment of friction-to-switch.

    The path itself is NOT stored — it is derived live from published
    episodes whose `topic` matches, ordered difficulty-asc with same
    creator clustered. Progress is tracked by episode id (stable even
    when new episodes are added to the topic), not by position.
    """
    __tablename__ = "user_anchor"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_user_anchor_one"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    # Episode.topic slug, e.g. "travel" / "food".
    topic: Mapped[str] = mapped_column(String(32), index=True)
    # Self-reported level at adopt time (1..4). Stored for future
    # level-aware ordering; not yet used to filter the path.
    level: Mapped[int] = mapped_column(Integer, default=2)
    # JSON int array of episode ids the user has "啃透" (Phase 1:
    # finished). The next episode unlocks only when the current one
    # is in here.
    done_episode_ids: Mapped[list] = mapped_column(JSON, default=list)
    adopted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
