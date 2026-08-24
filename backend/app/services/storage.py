"""Media storage abstraction — Aliyun OSS in prod, local disk in dev.

The DB always stores media as a relative path like ``/media/videos/x.mp4``
(unchanged from the original disk-only design). ``settings.media_base_url``
(the CDN domain on the mainland deploy) absolutizes it at serve time via
``schemas._absolutize_relative_media``.

This module decides WHERE the bytes physically land:

* **OSS configured** (``settings.oss_enabled``) → upload to the bucket under
  the key derived from the relative path (``/media/videos/x.mp4`` →
  object key ``media/videos/x.mp4``). The CDN origin is the bucket root, so
  ``media_base_url + "/media/videos/x.mp4"`` resolves to that object.
* **OSS not configured** (local dev) → write to the local ``/app/media``
  volume that nginx already serves. The whole import → playback flow then
  works E2E with zero Aliyun credentials, which is exactly what phase-1
  local verification needs.

oss2 is a synchronous SDK; uploads run in a worker thread so the async event
loop is never blocked. Files >100MB use resumable (multipart) upload.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

import anyio

from ..config import settings

log = logging.getLogger("storage")

# Matches pipeline.py: MEDIA_DIR = <repo>/media, mounted at /app/media and
# served by nginx at /media. Keep this in lockstep with pipeline.MEDIA_DIR.
MEDIA_DIR = Path(__file__).resolve().parents[2] / "media"

# oss2 switches to multipart upload above this size (bytes). Multipart is
# more resilient on flaky cross-region links and supports resume.
_RESUMABLE_THRESHOLD = 100 * 1024 * 1024


def _rel_to_key(rel_path: str) -> str:
    """``/media/videos/x.mp4`` → ``media/videos/x.mp4`` (OSS object key)."""
    return rel_path.lstrip("/")


def _rel_to_disk(rel_path: str) -> Path:
    """``/media/videos/x.mp4`` → ``<MEDIA_DIR>/videos/x.mp4`` (local file)."""
    sub = rel_path.lstrip("/")
    if sub.startswith("media/"):
        sub = sub[len("media/"):]
    return MEDIA_DIR / sub


def _put_oss_sync(rel_path: str, src_file: Path, content_type: str) -> None:
    import oss2  # imported lazily so dev installs without the SDK still boot

    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
    key = _rel_to_key(rel_path)
    headers = {"Content-Type": content_type} if content_type else None
    size = src_file.stat().st_size
    if size >= _RESUMABLE_THRESHOLD:
        oss2.resumable_upload(
            bucket, key, str(src_file),
            headers=headers, num_threads=3,
        )
    else:
        with src_file.open("rb") as f:
            bucket.put_object(key, f, headers=headers)
    log.info("oss put %s (%d bytes) → %s/%s", rel_path, size, settings.oss_bucket, key)


async def save_media(rel_path: str, src_file: Path, content_type: str = "") -> str:
    """Persist ``src_file`` (a temp file already on disk) to its final home.

    ``rel_path`` is the relative URL path that will be stored in the DB
    (e.g. ``/media/videos/x.mp4``). Returns it unchanged so callers can
    write it straight onto the model.

    Streaming-friendly: the caller is expected to have streamed the upload
    into ``src_file`` chunk-by-chunk, so nothing here loads the whole video
    into memory.
    """
    if settings.oss_enabled:
        await anyio.to_thread.run_sync(_put_oss_sync, rel_path, src_file, content_type)
    else:
        dest = _rel_to_disk(rel_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Move when possible (same filesystem), else copy. Run off-loop.
        await anyio.to_thread.run_sync(_local_place_sync, src_file, dest)
        log.info("local media write %s → %s", rel_path, dest)
    return rel_path


def _local_place_sync(src_file: Path, dest: Path) -> None:
    try:
        shutil.move(str(src_file), str(dest))
    except OSError:
        shutil.copyfile(str(src_file), str(dest))
    # The temp file came from mkstemp (0600, root). The web container's nginx
    # worker runs as a non-root user and serves this volume read-only, so it
    # must be world-readable or every /media request 403s. Match the 0644 that
    # yt-dlp/ffmpeg-written media already has.
    import os as _os
    _os.chmod(dest, 0o644)


async def delete_media(rel_paths: list[str]) -> None:
    """Best-effort cleanup of already-stored objects (used on import rollback).

    Never raises — rollback must not be derailed by a cleanup failure.
    """
    for rel in rel_paths:
        try:
            if settings.oss_enabled:
                await anyio.to_thread.run_sync(_delete_oss_sync, rel)
            else:
                disk = _rel_to_disk(rel)
                if disk.exists():
                    disk.unlink()
        except Exception as e:  # noqa: BLE001 — best-effort, log & continue
            log.warning("media cleanup failed for %s: %s", rel, e)


def _delete_oss_sync(rel_path: str) -> None:
    import oss2

    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
    bucket.delete_object(_rel_to_key(rel_path))
