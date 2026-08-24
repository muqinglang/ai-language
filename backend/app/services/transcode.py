"""Single-flight AV1/VP9 → H.264 transcode queue for stored episodes.

Why single-flight: prod runs on a 200m-CPU Tokyo pod. libx264 on a
1080p clip there takes 3-5 min and pegs the core. Running two at once
would starve the API event loop and tank request latency, so the queue
processes exactly one file at a time, in the background, FIFO.

State is in-memory only (a dict + an asyncio.Queue). It is intentionally
NOT persisted: if the pod restarts mid-drain the queue is lost, but
`Episode.video_codec` is the durable source of truth — the admin just
re-runs "一键转码全部 AV1" and anything still av1 gets requeued. Keeping
it in-memory avoids a jobs table for what is a rare maintenance action.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from ..db import SessionLocal
from ..models import Episode
from .pipeline import MEDIA_DIR, probe_video_codec, transcode_in_place_to_h264

log = logging.getLogger("transcode")

# ep_id -> "queued" | "running" | "done" | "error"
_state: dict[int, str] = {}
# ep_id -> short error string (only set when state == "error")
_errors: dict[int, str] = {}
_queue: "asyncio.Queue[int]" = asyncio.Queue()
_worker_task: asyncio.Task | None = None
# ep_id currently being transcoded (None when idle), for the UI.
_active: int | None = None


def _media_path(video_url: str) -> Path | None:
    """Map a stored `/media/<name>` URL to its file under MEDIA_DIR.

    Returns None for empty / non-/media URLs (e.g. seed demo data).
    """
    if not video_url:
        return None
    name = video_url.rsplit("/", 1)[-1]
    if not name:
        return None
    return MEDIA_DIR / name


def status_snapshot() -> dict:
    """Snapshot for the admin UI: per-episode state + queue summary."""
    return {
        "active": _active,
        "queued": [eid for eid, st in _state.items() if st == "queued"],
        "states": dict(_state),
        "errors": dict(_errors),
    }


def episode_state(ep_id: int) -> str:
    """"" if this episode isn't in the queue/known to the transcoder."""
    return _state.get(ep_id, "")


def _ensure_worker() -> None:
    global _worker_task
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_worker_loop())


def enqueue(ep_id: int) -> str:
    """Queue an episode for transcode. Idempotent: re-queuing one that is
    already queued/running is a no-op. Returns the resulting state.
    """
    cur = _state.get(ep_id)
    if cur in ("queued", "running"):
        return cur
    _state[ep_id] = "queued"
    _errors.pop(ep_id, None)
    _queue.put_nowait(ep_id)
    _ensure_worker()
    return "queued"


async def _worker_loop() -> None:
    global _active
    while True:
        try:
            ep_id = await _queue.get()
        except Exception:  # pragma: no cover - queue never raises in practice
            return
        _active = ep_id
        _state[ep_id] = "running"
        try:
            await _transcode_one(ep_id)
            _state[ep_id] = "done"
            _errors.pop(ep_id, None)
        except Exception as e:
            log.exception("transcode failed for episode %s", ep_id)
            _state[ep_id] = "error"
            _errors[ep_id] = str(e)[:200]
        finally:
            _active = None
            _queue.task_done()


async def _transcode_one(ep_id: int) -> None:
    async with SessionLocal() as s:
        ep = await s.get(Episode, ep_id)
        if ep is None:
            raise RuntimeError("episode not found")
        path = _media_path(ep.video_url)
        if path is None or not path.exists():
            raise RuntimeError(f"media file missing: {ep.video_url!r}")

        before, _ = await asyncio.to_thread(probe_video_codec, str(path))
        if before in ("h264", "avc1"):
            # Already safe (maybe transcoded out-of-band) — just sync the
            # column and skip the multi-minute re-encode.
            ep.video_codec = "h264"
            await s.commit()
            return

        codec = await asyncio.to_thread(transcode_in_place_to_h264, str(path))
        if codec not in ("h264", "avc1"):
            raise RuntimeError(f"transcode did not yield H.264 (got {codec or 'unknown'!r})")
        ep.video_codec = "h264"
        await s.commit()
        log.info("episode %s transcoded %s -> h264 in place", ep_id, before)
