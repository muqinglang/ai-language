"""Req 5: CRUD + run-now endpoints for the import scheduler.

Mounted under /api/admin/schedules. All endpoints require admin auth.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_admin
from ..db import get_db
from ..schemas import Page
from ..models import ImportSchedule, Speaker, User
from ..services import scheduler as sched_service

router = APIRouter(prefix="/api/admin/schedules", tags=["admin-schedules"])


# ---------- Pydantic shapes ----------
class ScheduleOut(BaseModel):
    id: int
    name: str
    speaker_id: int
    speaker_handle: str | None
    speaker_name: str | None
    cron_expression: str
    videos_per_run: int
    segments_per_video: int
    max_video_duration_sec: int
    enabled: bool
    last_run_at: datetime | None
    last_run_summary: dict
    created_at: datetime


class ScheduleCreate(BaseModel):
    name: str
    speaker_id: int
    cron_expression: str
    videos_per_run: int = 1
    segments_per_video: int = 2
    max_video_duration_sec: int = 1800
    enabled: bool = True


class ScheduleUpdate(BaseModel):
    name: str | None = None
    speaker_id: int | None = None
    cron_expression: str | None = None
    videos_per_run: int | None = None
    segments_per_video: int | None = None
    max_video_duration_sec: int | None = None
    enabled: bool | None = None


def _to_out(s: ImportSchedule) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "speaker_id": s.speaker_id,
        "speaker_handle": s.speaker.handle if s.speaker else None,
        "speaker_name": s.speaker.name if s.speaker else None,
        "cron_expression": s.cron_expression,
        "videos_per_run": s.videos_per_run,
        "segments_per_video": s.segments_per_video,
        "max_video_duration_sec": s.max_video_duration_sec,
        "enabled": s.enabled,
        "last_run_at": s.last_run_at,
        "last_run_summary": s.last_run_summary or {},
        "created_at": s.created_at,
    }


# ---------- Endpoints ----------
@router.get("", response_model=list[ScheduleOut])
async def list_schedules(
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(select(ImportSchedule).order_by(ImportSchedule.id))).scalars().all()
    return [_to_out(r) for r in rows]


@router.post("", response_model=ScheduleOut)
async def create_schedule(
    body: ScheduleCreate,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    sp = await db.get(Speaker, body.speaker_id)
    if not sp:
        raise HTTPException(400, "speaker not found")
    # Sanity-check cron syntax up front so the API rejects bad input rather
    # than silently failing inside the scheduler thread.
    try:
        from apscheduler.triggers.cron import CronTrigger  # type: ignore
        CronTrigger.from_crontab(body.cron_expression, timezone="UTC")
    except Exception as e:
        raise HTTPException(400, f"invalid cron expression: {e}")

    s = ImportSchedule(
        name=body.name,
        speaker_id=body.speaker_id,
        cron_expression=body.cron_expression,
        videos_per_run=body.videos_per_run,
        segments_per_video=body.segments_per_video,
        max_video_duration_sec=body.max_video_duration_sec,
        enabled=body.enabled,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    # Re-fetch with speaker joined so the response includes handle/name.
    s = (await db.execute(
        select(ImportSchedule).where(ImportSchedule.id == s.id)
    )).scalar_one()
    await sched_service.register_schedule(s)
    return _to_out(s)


@router.put("/{sid}", response_model=ScheduleOut)
async def update_schedule(
    sid: int,
    body: ScheduleUpdate,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    s = await db.get(ImportSchedule, sid)
    if not s:
        raise HTTPException(404, "schedule not found")
    data = body.model_dump(exclude_unset=True)
    if "speaker_id" in data and data["speaker_id"]:
        if not await db.get(Speaker, data["speaker_id"]):
            raise HTTPException(400, "speaker_id not found")
    if "cron_expression" in data and data["cron_expression"]:
        try:
            from apscheduler.triggers.cron import CronTrigger  # type: ignore
            CronTrigger.from_crontab(data["cron_expression"], timezone="UTC")
        except Exception as e:
            raise HTTPException(400, f"invalid cron expression: {e}")
    for k, v in data.items():
        setattr(s, k, v)
    await db.commit()
    await db.refresh(s)
    s = (await db.execute(
        select(ImportSchedule).where(ImportSchedule.id == sid)
    )).scalar_one()
    await sched_service.register_schedule(s)
    return _to_out(s)


@router.delete("/{sid}", status_code=204)
async def delete_schedule(
    sid: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    s = await db.get(ImportSchedule, sid)
    if not s:
        raise HTTPException(404, "schedule not found")
    await sched_service.unregister_schedule(sid)
    await db.delete(s)
    await db.commit()


@router.post("/{sid}/run-now")
async def run_now(
    sid: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Fire the schedule body immediately, don't wait for cron."""
    s = await db.get(ImportSchedule, sid)
    if not s:
        raise HTTPException(404, "schedule not found")
    await sched_service.trigger_now(sid)
    return {"ok": True, "id": sid}


# ---------- Speaker list (for the New Schedule form's dropdown) ----------
class SpeakerOut(BaseModel):
    id: int
    handle: str
    name: str
    youtube_url: str


@router.get("/speakers/all", response_model=list[SpeakerOut])
async def list_all_speakers(
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Lighter than /admin/episodes — just (id, handle, name, youtube_url)."""
    rows = (await db.execute(select(Speaker).order_by(Speaker.name))).scalars().all()
    return [
        SpeakerOut(id=s.id, handle=s.handle, name=s.name, youtube_url=s.youtube_url)
        for s in rows
    ]


# ---------- Review queue: today's draft/reviewing episodes from auto-imports ----------
class ReviewQueueItem(BaseModel):
    id: int
    title: str
    thumbnail_url: str
    duration_sec: int
    chunks_count: int
    subtitles_count: int
    status: str
    speaker_handle: str | None
    speaker_name: str | None
    category_name: str | None
    topic: str
    difficulty: int
    accent: str
    created_at: datetime
    schedule_name: str | None  # which schedule produced it (best-effort)


@router.get("/review-queue", response_model=Page[ReviewQueueItem])
async def review_queue(
    limit: int = 50,
    offset: int = 0,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """All draft / reviewing episodes that haven't been published yet.

    The mockup calls this "📥 今日新导入 · 等待审核". We don't actually filter
    by today — admins might leave items overnight. Anything not yet
    published is fair game.
    """
    from ..models import Episode
    limit = max(1, min(limit, 200))
    total = int(await db.scalar(
        select(func.count(Episode.id)).where(Episode.status.in_(["draft", "reviewing"]))
    ) or 0)
    rows = (
        await db.execute(
            select(Episode)
            .where(Episode.status.in_(["draft", "reviewing"]))
            .order_by(Episode.created_at.desc())
            .limit(limit).offset(offset)
        )
    ).scalars().all()
    items = [
        ReviewQueueItem(
            id=e.id,
            title=e.title,
            thumbnail_url=e.thumbnail_url,
            duration_sec=e.duration_sec,
            chunks_count=e.chunks_count,
            subtitles_count=e.subtitles_count,
            status=e.status,
            speaker_handle=e.speaker.handle if e.speaker else None,
            speaker_name=e.speaker.name if e.speaker else None,
            category_name=e.category.name if e.category else None,
            topic=e.topic or "other",
            difficulty=e.difficulty,
            accent=e.accent,
            created_at=e.created_at,
            schedule_name=None,  # we don't track this link yet; fold in later
        )
        for e in rows
    ]
    return Page(items=items, total=total, has_more=offset + len(items) < total)
