"""
Req 5: scheduled creator imports.

APScheduler running inside the api process. On startup we load all enabled
ImportSchedule rows and register one cron job per row. Each job:

  1. yt-dlp `--flat-playlist` on speaker.youtube_url to get latest videos
  2. dedup against episodes.youtube_url (skip already-imported)
  3. respect max_video_duration_sec (skip too-long)
  4. take first videos_per_run picks
  5. for each, spawn the normal pipeline run_pipeline() with
     segments_count=schedule.segments_per_video

Failure modes:
  - cookies invalid → first yt-dlp call fails → record error in
    last_run_summary, abort the run early (other videos would fail too)
  - LLM timeout / DeepSeek down → individual video fails, others continue
  - all videos already imported → records "no new videos" status

Pod restart resets in-memory APScheduler state. We re-register on startup
from DB. Acceptable: pod restarts are rare (only on deploy) and a missed
nightly run is recoverable next day.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select

from ..db import SessionLocal
from ..models import Episode, ImportSchedule, ImportTask, Speaker, User

log = logging.getLogger("scheduler")


async def _schedule_override(db):
    """Whose key a scheduled import spends.

    A cron job has no logged-in user, and the platform no longer keeps a key
    of its own, so someone's credentials have to be named explicitly. We use
    the lowest-id admin who has configured one — in practice this project has
    exactly one admin, and being wrong here is loud (the import fails with a
    message) rather than quiet (a surprise bill).

    Returns None when no admin has a key; the caller turns that into a failed
    run with an explanation instead of a stack trace.
    """
    from ..routers.user_llm import load_override  # circular at module load

    admins = (await db.execute(
        select(User).where(User.role == "admin").order_by(User.id)
    )).scalars().all()
    for admin in admins:
        override = await load_override(db, admin)
        if override is not None:
            log.info("scheduled import will use admin '%s' key", admin.username)
            return override
    return None

_scheduler: Optional[AsyncIOScheduler] = None
_FLAT_PLAYLIST_LIMIT = 100


def get_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = AsyncIOScheduler(timezone="UTC")
    return _scheduler


def _flat_playlist(channel_url: str, limit: int = _FLAT_PLAYLIST_LIMIT) -> list[dict]:
    """Pull recent N video metas from a YouTube channel URL via yt-dlp.
    Returns [{"id", "title", "duration"}]. Empty list on failure.

    Channel URLs without a tab suffix (.../channel/UCxxx or .../@handle)
    return the Home tab, which on a music-only channel can be empty of
    actual videos. Append /videos to force the Videos tab and get all
    uploads in upload-date order.
    """
    try:
        import yt_dlp  # type: ignore
    except ImportError:
        return []
    from .pipeline import _yt_cookiefile

    target_url = channel_url.rstrip("/")
    if not any(
        target_url.endswith(suffix)
        for suffix in ("/videos", "/streams", "/shorts")
    ):
        # Heuristic: if the URL is /channel/UCxxx or /@handle, append /videos.
        # If it's already a /watch?v=... link or a custom path, leave it alone.
        if "/channel/" in target_url or "/@" in target_url or "/c/" in target_url or "/user/" in target_url:
            target_url = f"{target_url}/videos"

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "noplaylist": False,
        "playlistend": limit,
    }
    cookiefile = _yt_cookiefile()
    if cookiefile:
        opts["cookiefile"] = cookiefile

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(target_url, download=False)
    except Exception as e:
        log.warning("flat-playlist fetch failed for %s: %s", target_url, e)
        return []

    out: list[dict] = []
    entries = (info or {}).get("entries") or []
    for e in entries:
        if not e:
            continue
        # yt-dlp on a /channel/UCxxx URL returns a mix of entries:
        # - actual videos (_type missing or "url"; ID is 11 chars)
        # - sub-tabs / playlists / channel rolls (_type = "playlist" or
        #   "channel"; ID starts with UC, PL, OL, etc.)
        # Only accept video-shaped IDs so we don't try to import a channel
        # as if it were a clip.
        e_type = e.get("_type") or ""
        if e_type in ("playlist", "channel", "url_transparent"):
            # url_transparent appears for channel sub-tabs (Videos / Shorts)
            continue
        vid = e.get("id") or ""
        # YouTube video IDs are exactly 11 chars (a-zA-Z0-9_-). Channel IDs
        # are 24 chars and start with UC. Playlist IDs are PL/UU/RD prefixed.
        if len(vid) != 11:
            continue
        out.append({
            "id": vid,
            "title": e.get("title", ""),
            "duration": int(e.get("duration") or 0),
        })
    return out


async def _pick_undimported_videos(
    speaker: Speaker, target_count: int, max_duration_sec: int
) -> list[str]:
    """Picks `target_count` YouTube URLs from this speaker's recent uploads
    that aren't already in episodes.youtube_url and aren't too long."""
    if not speaker.youtube_url:
        return []
    metas = await asyncio.to_thread(_flat_playlist, speaker.youtube_url)
    if not metas:
        return []

    async with SessionLocal() as db:
        # Cheaper to fetch the (small) full youtube_url set once than do N
        # SELECTs with LIKE. Compare on the video ID substring since the
        # stored URLs may have query params (?t=66s).
        rows = (await db.execute(select(Episode.youtube_url))).scalars().all()
    imported_ids: set[str] = set()
    for u in rows:
        if not u:
            continue
        # Extract `v=...` from the stored URL
        if "v=" in u:
            vid = u.split("v=", 1)[1].split("&", 1)[0]
            imported_ids.add(vid)

    picks: list[str] = []
    for m in metas:
        if m["id"] in imported_ids:
            continue
        if max_duration_sec and m["duration"] and m["duration"] > max_duration_sec:
            continue
        picks.append(f"https://www.youtube.com/watch?v={m['id']}")
        if len(picks) >= target_count:
            break
    return picks


async def _run_schedule_once(schedule_id: int) -> None:
    """Body of a single schedule run. Imports each picked video as a normal
    pipeline task; records a summary on the ImportSchedule row."""
    async with SessionLocal() as db:
        sched = await db.get(ImportSchedule, schedule_id)
        if sched is None or not sched.enabled:
            return
        speaker = sched.speaker
        if speaker is None:
            log.warning("schedule %d has no speaker; disabling", schedule_id)
            sched.enabled = False
            await db.commit()
            return
        videos_per_run = sched.videos_per_run
        segments_per_video = sched.segments_per_video
        max_dur = sched.max_video_duration_sec

    log.info(
        "schedule %d firing: speaker=%s videos_per_run=%d segments=%d",
        schedule_id, speaker.handle, videos_per_run, segments_per_video,
    )
    urls = await _pick_undimported_videos(speaker, videos_per_run, max_dur)

    summary = {"ok": 0, "fail": 0, "imported_urls": list(urls), "errors": []}
    if not urls:
        summary["note"] = "no new videos to import (all backlog already imported / too long)"
    else:
        # Spawn one pipeline task per picked URL. Run sequentially to be
        # nice to YouTube + LLM rate limits.
        from .pipeline import run_pipeline  # avoid circular at module load
        async with SessionLocal() as db:
            override = await _schedule_override(db)
        if override is None:
            msg = ("定时导入需要一个配了 API key 的 admin 账号："
                   "到「我的 → 设置 → 我的 API key」配置后才会运行")
            log.warning("schedule %d skipped: %s", schedule_id, msg)
            summary["fail"] = len(urls)
            summary["errors"].append(msg)
            urls = []
        for url in urls:
            try:
                async with SessionLocal() as db:
                    task = ImportTask(youtube_url=url, status="queued")
                    db.add(task)
                    await db.commit()
                    await db.refresh(task)
                    task_id = task.id
                # Run pipeline (uses its own session). difficulty/accent are
                # left undefined so stage 5 LLM auto-classify kicks in.
                async with SessionLocal() as db:
                    await run_pipeline(db, task_id, {
                        "llm_override": override,
                        "segments_count": segments_per_video,
                        # auto_approve = the schedule's reason for being:
                        # nightly cron should not stop at admin preview;
                        # admin reviews FINISHED draft episodes next morning
                        # via /admin/review-queue.
                        "auto_approve": True,
                    })
                summary["ok"] += 1
            except Exception as e:
                log.exception("schedule %d: import failed for %s", schedule_id, url)
                summary["fail"] += 1
                summary["errors"].append(f"{url}: {e}")

    async with SessionLocal() as db:
        sched = await db.get(ImportSchedule, schedule_id)
        if sched is not None:
            sched.last_run_at = datetime.now(timezone.utc)
            sched.last_run_summary = summary
            await db.commit()
    log.info("schedule %d done: %s", schedule_id, summary)


def _job_id(schedule_id: int) -> str:
    return f"import_schedule_{schedule_id}"


async def register_schedule(schedule: ImportSchedule) -> None:
    """Add or replace a single schedule's job in the running scheduler."""
    sched = get_scheduler()
    job_id = _job_id(schedule.id)
    # Replace any existing one (e.g. on update)
    if sched.get_job(job_id):
        sched.remove_job(job_id)
    if not schedule.enabled:
        return
    try:
        trigger = CronTrigger.from_crontab(schedule.cron_expression, timezone="UTC")
    except Exception as e:
        log.warning(
            "schedule %d has invalid cron %r: %s",
            schedule.id, schedule.cron_expression, e,
        )
        return
    sched.add_job(
        _run_schedule_once,
        trigger=trigger,
        args=[schedule.id],
        id=job_id,
        name=schedule.name,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=600,
    )
    log.info("registered schedule %d (%s) cron=%s", schedule.id, schedule.name, schedule.cron_expression)


async def unregister_schedule(schedule_id: int) -> None:
    sched = get_scheduler()
    job_id = _job_id(schedule_id)
    if sched.get_job(job_id):
        sched.remove_job(job_id)


async def init_scheduler() -> None:
    """Called from main.py startup. Loads enabled schedules + starts the
    APScheduler loop. Idempotent — safe to call once at startup."""
    sched = get_scheduler()
    if sched.running:
        return
    async with SessionLocal() as db:
        rows = (await db.execute(select(ImportSchedule))).scalars().all()
    for r in rows:
        await register_schedule(r)
    sched.start()
    log.info("scheduler started with %d schedules loaded", len(rows))


async def trigger_now(schedule_id: int) -> None:
    """Admin manual 'run now' button — fires the schedule body immediately
    in the background, doesn't wait for cron."""
    asyncio.create_task(_run_schedule_once(schedule_id))
