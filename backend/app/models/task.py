from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class ImportTask(Base):
    __tablename__ = "import_tasks"
    id: Mapped[int] = mapped_column(primary_key=True)
    youtube_url: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(32), default="queued")
    # queued | downloading | transcribing | chunking | dialoging | reviewing | published | failed
    stage: Mapped[int] = mapped_column(Integer, default=0)
    progress: Mapped[int] = mapped_column(Integer, default=0)  # 0-100
    log: Mapped[list] = mapped_column(JSON, default=list)  # [{stage, status, duration, error?}]
    ai_segments: Mapped[list] = mapped_column(JSON, default=list)
    selected_segment: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    # ON DELETE SET NULL: deleting an episode keeps the audit trail of the
    # original import (URL, log, timestamps) but unlinks the now-gone episode.
    # Without this the FK NO ACTION default makes admin episode deletion fail.
    episode_id: Mapped[int | None] = mapped_column(
        ForeignKey("episodes.id", ondelete="SET NULL")
    )
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
