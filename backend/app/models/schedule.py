from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


class ImportSchedule(Base):
    """Admin-configured recurring import rule for a single creator/channel.

    Each row is one creator + one cron schedule. To pull from N creators,
    create N rows (each can have its own cron, count, segments). Per-row
    cron lets some creators run weekly while daily-uploaders run nightly.

    The runtime executor (services/scheduler.py):
      1. on api startup, loads enabled rows and schedules them via APScheduler
      2. when a job fires: yt-dlp flat-playlist on speaker.youtube_url
         → dedup against episodes.youtube_url → pick first videos_per_run
         that haven't been imported and are within max_video_duration
      3. for each pick, spawns the normal pipeline asyncio task with
         segments_count=segments_per_video; produces draft Episodes
         that admin reviews next morning via the ReviewQueue page.
    """

    __tablename__ = "import_schedules"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    # Which creator to pull from. ON DELETE CASCADE: removing the speaker
    # implicitly removes their schedule too — admin's expectation.
    speaker_id: Mapped[int] = mapped_column(
        ForeignKey("speakers.id", ondelete="CASCADE"), index=True
    )
    # 5-field cron in UTC. Examples: "0 14 * * *" = nightly 22:00 Asia/Shanghai.
    cron_expression: Mapped[str] = mapped_column(String(64))
    videos_per_run: Mapped[int] = mapped_column(Integer, default=1)
    segments_per_video: Mapped[int] = mapped_column(Integer, default=2)
    # Skip videos longer than this (yt-dlp metadata duration). Default 30 min;
    # 0 = no limit.
    max_video_duration_sec: Mapped[int] = mapped_column(Integer, default=1800)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Compact summary of what the last run did. Shape:
    # {"ok": int, "fail": int, "imported_urls": [...], "errors": [...]}
    last_run_summary: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    speaker: Mapped["Speaker | None"] = relationship(lazy="joined")  # type: ignore # noqa
