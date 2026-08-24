import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ValidationError
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_admin
from ..config import settings
from ..db import SessionLocal, get_db
from ..models import AIConversation, Category, Chunk, Episode, ImportTask, Speaker, Subtitle, User
from ..schemas import ImportCreate, ImportTaskOut, Page, StatsOut
from ..services import storage as storage_svc
from ..services import transcode as transcode_svc
from ..services.bundle import BundleManifest, persist_bundle
from .user_llm import require_override
from ..services.pipeline import _translate_to_zh, probe_video_codec, run_pipeline, run_pipeline_phase2

router = APIRouter(prefix="/api/admin", tags=["admin"])
log = logging.getLogger("admin")


@router.get("/stats", response_model=StatsOut)
async def stats(_: User = Depends(current_admin), db: AsyncSession = Depends(get_db)):
    async def count(model, **where):
        q = select(func.count()).select_from(model)
        for k, v in where.items():
            q = q.where(getattr(model, k) == v)
        return int((await db.execute(q)).scalar() or 0)

    return StatsOut(
        total_episodes=await count(Episode),
        published=await count(Episode, status="published"),
        reviewing=await count(Episode, status="reviewing"),
        draft=await count(Episode, status="draft"),
        total_users=await count(User),
        total_conversations=await count(AIConversation),
        total_chunks=await count(Chunk),
        pipeline_running=await count(ImportTask, status="running"),
    )


@router.post("/import", response_model=ImportTaskOut)
async def create_import(
    body: ImportCreate,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    # Dedup: if we already have an episode for this exact URL AND the admin
    # didn't pass `force=true`, refuse and point them at the existing one.
    # Also surface any in-flight import of the same URL so two admins don't
    # accidentally both queue it.
    if not body.force:
        existing_ep = (await db.execute(
            select(Episode).where(Episode.youtube_url == body.youtube_url).limit(1)
        )).scalar_one_or_none()
        if existing_ep:
            raise HTTPException(
                409,
                detail={
                    "kind": "episode_exists",
                    "episode_id": existing_ep.id,
                    "title": existing_ep.title,
                    "message": f"该 URL 已导入为 Episode #{existing_ep.id}（{existing_ep.title[:40]}）。加 force=true 可强制重新导入。",
                },
            )
        in_flight = (await db.execute(
            select(ImportTask).where(
                ImportTask.youtube_url == body.youtube_url,
                ImportTask.status.notin_(("reviewing", "published", "failed")),
            ).limit(1)
        )).scalar_one_or_none()
        if in_flight:
            raise HTTPException(
                409,
                detail={
                    "kind": "import_in_flight",
                    "task_id": in_flight.id,
                    "message": f"该 URL 正在导入中（task #{in_flight.id}，{in_flight.status}）。",
                },
            )

    task = ImportTask(
        youtube_url=body.youtube_url,
        status="queued",
        stage=0,
        progress=0,
        created_by=admin.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    # Schedule on the currently running event loop so the coroutine actually executes.
    # (FastAPI's BackgroundTasks runs sync callables in a threadpool, where
    # asyncio.get_event_loop().create_task silently does nothing.)
    # 导入烧的是触发它的这个 admin 自己的额度。平台不再有 key 兜底，
    # 所以没配就 428 —— 跟学员侧完全同一条规矩。
    params = body.model_dump()
    params["llm_override"] = await require_override(db, admin)
    asyncio.create_task(_run_pipeline_bg(task.id, params))
    return task


class ImportBundleOut(BaseModel):
    episode_ids: list[int]
    count: int
    video_urls: list[str]


# Hard ceiling on a single bundle upload (sum of all parts). A 5-segment
# 1080p H.264 bundle is ~400MB; 1GB leaves headroom without letting an
# accidental 4K long-lecture upload run away. nginx client_max_body_size
# must be set at least this high on the deploy.
_MAX_BUNDLE_BYTES = 1024 * 1024 * 1024
_SPOOL_CHUNK = 1024 * 1024


async def _spool_upload(uf: UploadFile, budget: list[int]) -> Path:
    """Stream an UploadFile to a temp file on disk, chunk by chunk, so a
    multi-hundred-MB video never lands wholesale in memory. ``budget`` is a
    1-element mutable total-bytes-remaining counter shared across all parts."""
    fd, tmp = tempfile.mkstemp(prefix="bundle-")
    os.close(fd)
    p = Path(tmp)
    with p.open("wb") as out:
        while True:
            chunk = await uf.read(_SPOOL_CHUNK)
            if not chunk:
                break
            budget[0] -= len(chunk)
            if budget[0] < 0:
                out.close()
                p.unlink(missing_ok=True)
                raise HTTPException(
                    413,
                    detail=f"bundle exceeds {_MAX_BUNDLE_BYTES // (1024*1024)}MB limit",
                )
            out.write(chunk)
    return p


@router.post("/import-bundle", response_model=ImportBundleOut)
async def import_bundle(
    manifest: str = Form(...),
    files: list[UploadFile] = File(default=[]),
    force: bool = Form(False),
    publish: bool = Form(False),
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Import a locally-computed bundle: a JSON manifest + its video/thumb
    files, uploaded as one multipart request. Stores media (OSS in prod,
    local disk in dev) and writes the DB rows — no yt-dlp / LLM runs here.

    Each uploaded file's ``filename`` must equal the ``video_file`` /
    ``thumb_file`` path referenced in the manifest, so the server can match
    bytes to segment. One bundle → N segments sharing youtube_url + speaker.
    """
    try:
        data = json.loads(manifest)
        mf = BundleManifest.model_validate(data)
    except (json.JSONDecodeError, ValidationError) as e:
        raise HTTPException(422, detail=f"invalid bundle manifest: {e}")

    if not mf.segments:
        raise HTTPException(422, detail="bundle has no segments")

    # Dedup on youtube_url. A bundle's N segments all share the URL.
    #   force=false → refuse if already present (409).
    #   force=true  → REPLACE: delete the existing same-URL episodes (+ their
    #     media) and re-insert, so re-pushing a collection updates it instead
    #     of creating duplicates. This is what the "推送生产" button uses, so
    #     pushing the same collection again (or fat-fingering a second segment)
    #     is idempotent, never a duplicate.
    old_media: list[str] = []
    if not force:
        existing = (await db.execute(
            select(Episode).where(Episode.youtube_url == mf.youtube_url).limit(1)
        )).scalar_one_or_none()
        if existing:
            raise HTTPException(
                409,
                detail={
                    "kind": "episode_exists",
                    "episode_id": existing.id,
                    "title": existing.title,
                    "message": f"该 URL 已导入为 Episode #{existing.id}（{existing.title[:40]}）。加 force=true 可强制重新导入。",
                },
            )
    else:
        old = (await db.execute(
            select(Episode.video_url, Episode.thumbnail_url)
            .where(Episode.youtube_url == mf.youtube_url)
        )).all()
        for vurl, turl in old:
            if vurl and vurl.startswith("/media/"):
                old_media.append(vurl)
            if turl and turl.startswith("/media/"):
                old_media.append(turl)
        if old:
            # DB-level delete cascades to chunks/subtitles/chapters/words.
            # Old media files are removed only AFTER the new rows commit, so a
            # failed re-push rolls back to the old episodes with media intact.
            await db.execute(delete(Episode).where(Episode.youtube_url == mf.youtube_url))
            await db.flush()

    # Stream every part to a temp file (chunked, memory-safe), keyed by the
    # client-supplied filename so the manifest can reference them.
    budget = [_MAX_BUNDLE_BYTES]
    file_map: dict[str, Path] = {}
    temp_paths: list[Path] = []
    try:
        for uf in files:
            tmp = await _spool_upload(uf, budget)
            temp_paths.append(tmp)
            if uf.filename:
                file_map[uf.filename] = tmp

        ep_ids, saved = await persist_bundle(db, mf, file_map)
        # publish=true → go live immediately (the manifest carries the local
        # status, usually "reviewing"; pushing means it's ready). The "推送生产"
        # button sends this so there's no second publish step on prod.
        if publish and ep_ids:
            await db.execute(
                update(Episode).where(Episode.id.in_(ep_ids))
                .values(status="published", published_at=datetime.now(timezone.utc))
            )
        await db.commit()
        # New rows are committed → now safe to drop the replaced collection's
        # old media (different keys from the new ones; no overlap to clobber).
        if old_media:
            await storage_svc.delete_media(old_media)
        log.info("bundle import ok: %d episode(s) %s", len(ep_ids), ep_ids)
    except HTTPException:
        await db.rollback()
        raise
    except Exception as e:  # noqa: BLE001
        await db.rollback()
        # Clean up any media already pushed before the failure.
        saved = getattr(e, "_bundle_saved_media", [])
        if saved:
            await storage_svc.delete_media(saved)
        log.exception("bundle import failed")
        raise HTTPException(500, detail=f"bundle import failed: {e}")
    finally:
        for tmp in temp_paths:
            tmp.unlink(missing_ok=True)

    # Re-read video_urls for the response (relative paths as stored).
    rows = (await db.execute(
        select(Episode.video_url).where(Episode.id.in_(ep_ids))
    )).scalars().all()
    return ImportBundleOut(episode_ids=ep_ids, count=len(ep_ids), video_urls=list(rows))


@router.get("/push-target")
async def push_target(_: User = Depends(current_admin)):
    """Tells the admin UI whether one-click "push to prod" is wired (the local
    dev stack has PUBLISH_TARGET_* set; the remote ECS doesn't → button hidden)."""
    return {"enabled": settings.publish_enabled, "target": settings.publish_target_api}


class PushReq(BaseModel):
    episode_id: int | None = None
    youtube_url: str | None = None
    force: bool = True


def _push_publish_sync(out_dir: Path, force: bool) -> dict:
    """Log in to the prod API and upload the bundle dir. Runs in a worker
    thread (httpx sync). Raises SystemExit on a handled failure (e.g. 409)."""
    from ..scripts.publish import _login, publish as publish_fn
    api = settings.publish_target_api
    token = _login(api, settings.publish_target_user, settings.publish_target_password)
    # "推送生产" = push AND publish: go live on prod immediately, no second step.
    return publish_fn(out_dir, api, token, force, publish=True)


@router.post("/push-to-prod")
async def push_to_prod(
    body: PushReq,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """One-click: export a locally-imported episode's collection to a bundle
    and publish it to the remote prod deploy — the export_bundle + publish CLIs
    behind a button. Pushes the whole youtube_url collection (all segments)."""
    if not settings.publish_enabled:
        raise HTTPException(
            400,
            detail="推送未配置：在本地 .env 设置 PUBLISH_TARGET_API / PUBLISH_TARGET_USER / PUBLISH_TARGET_PASSWORD",
        )
    youtube_url = body.youtube_url
    if not youtube_url and body.episode_id is not None:
        ep = await db.get(Episode, body.episode_id)
        if ep is None:
            raise HTTPException(404, "episode not found")
        youtube_url = ep.youtube_url
    if not youtube_url:
        raise HTTPException(422, "need episode_id or youtube_url")

    import tempfile

    from ..scripts.export_bundle import export as export_bundle_fn

    try:
        with tempfile.TemporaryDirectory(prefix="push-") as tmp:
            out_dir = await export_bundle_fn(youtube_url, Path(tmp))
            result = await asyncio.to_thread(_push_publish_sync, out_dir, body.force)
    except SystemExit as e:  # publish CLI signals handled failures this way
        raise HTTPException(400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("push-to-prod failed")
        raise HTTPException(500, detail=f"推送失败：{e}")
    log.info("push-to-prod ok: %s → %s", youtube_url, result)
    return {"ok": True, "target": settings.publish_target_api, **result}


@router.get("/import", response_model=Page[ImportTaskOut])
async def list_imports(
    limit: int = 50,
    offset: int = 0,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    limit = max(1, min(limit, 200))
    total = int(await db.scalar(select(func.count(ImportTask.id))) or 0)
    rows = (
        await db.execute(
            select(ImportTask).order_by(ImportTask.created_at.desc())
            .limit(limit).offset(offset)
        )
    ).scalars().all()
    return Page(
        items=[_with_download(r) for r in rows],
        total=total,
        has_more=offset + len(rows) < total,
    )


def _with_download(t: ImportTask) -> ImportTaskOut:
    """Attach live download stats to a task row.

    The numbers live in an in-process dict rather than on the row (see
    pipeline._DL_PROGRESS) — a download that moves 80 KiB/s would otherwise
    mean a DB write every 2 seconds purely so the admin page can render a
    number that is stale the moment it lands.
    """
    from ..services.pipeline import get_download_progress

    out = ImportTaskOut.model_validate(t)
    out.download = get_download_progress(t.id)
    return out


@router.get("/import/{tid}", response_model=ImportTaskOut)
async def get_import(tid: int, _: User = Depends(current_admin), db: AsyncSession = Depends(get_db)):
    t = await db.get(ImportTask, tid)
    if not t:
        raise HTTPException(404, "not found")
    return _with_download(t)


@router.delete("/import/{tid}", status_code=204)
async def delete_import(tid: int, _: User = Depends(current_admin), db: AsyncSession = Depends(get_db)):
    """Delete an import task record. Does NOT delete the linked episode —
    those have their own delete endpoint. Also wipes the cached raw VTT
    file persisted in phase 1 (used by phase 2 hybrid splitter)."""
    t = await db.get(ImportTask, tid)
    if not t:
        raise HTTPException(404, "not found")
    # pending_review is a PAUSED state — no background task is using it,
    # so cleaning up duplicate paused rows is safe. Block only states
    # where the pipeline is actively running and a delete might race a
    # background commit.
    if t.status not in ("reviewing", "published", "failed", "pending_review"):
        raise HTTPException(409, f"task is still {t.status}; wait for it to finish or fail first")
    from ..services.pipeline import cleanup_vtt_for_task
    cleanup_vtt_for_task(tid)
    await db.delete(t)
    await db.commit()


@router.post("/import/{tid}/cancel", response_model=ImportTaskOut)
async def cancel_import(
    tid: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Mark an in-flight import as failed so the row stops looking stuck
    and admin can retry. Does NOT actually kill the background coroutine
    (FastAPI background tasks can't be cleanly cancelled from here) — the
    yt-dlp call will eventually time out and exit on its own. But the
    task row is immediately released: status=failed, error set, log
    entry appended. Retry creates a fresh task; the orphan coroutine's
    later commit no-ops because it re-reads the now-failed status.

    Use case: yt-dlp silently hangs because YouTube cookies expired and
    its 3-attempt backoff (~10 min total) hasn't surfaced as a failure
    yet. Admin sees "X 分钟未更新" + 强制取消 → fresh retry after
    cookie refresh.
    """
    t = await db.get(ImportTask, tid)
    if not t:
        raise HTTPException(404, "not found")
    if t.status in ("reviewing", "published", "failed", "pending_review"):
        raise HTTPException(
            409, f"task is {t.status}; nothing to cancel (use delete instead)"
        )
    t.status = "failed"
    t.error = (t.error + " · ") if t.error else ""
    t.error += "admin cancelled (stuck task released)"
    t.log = list(t.log or []) + [{
        "stage": t.stage, "status": "cancelled", "ts": datetime.now(timezone.utc).timestamp(),
        "note": "admin force-cancel",
    }]
    await db.commit()
    await db.refresh(t)
    return t


class ApproveSegments(BaseModel):
    """Admin-approved segments, possibly ±15s adjusted from the AI picks."""
    segments: list[dict]


@router.post("/import/{tid}/approve")
async def approve_import(
    tid: int,
    body: ApproveSegments,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Approve the AI-picked segments (or adjusted ones) and continue the
    pipeline from stage 3 (download + process each segment)."""
    task = await db.get(ImportTask, tid)
    if not task:
        raise HTTPException(404, "not found")
    if task.status != "pending_review":
        raise HTTPException(409, f"task is {task.status}, not pending_review")
    if not body.segments:
        raise HTTPException(400, "at least one segment required")

    for seg in body.segments:
        if "source_start" not in seg or "source_end" not in seg:
            raise HTTPException(400, "each segment needs source_start and source_end")

    override = await require_override(db, admin)
    asyncio.create_task(_run_approve_bg(task.id, body.segments, override))
    return {"ok": True, "segments_count": len(body.segments)}


async def _run_approve_bg(task_id: int, segments: list[dict], override=None):
    try:
        async with SessionLocal() as s:
            await run_pipeline_phase2(s, task_id, segments, override)
    except Exception:
        log.exception("pipeline phase 2 (task %d) crashed", task_id)


@router.post("/import/{tid}/retry", response_model=ImportTaskOut)
async def retry_import(
    tid: int,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Re-queue a failed or finished import with the same URL. Creates a new
    task row (so the old one's log/error stays as history) and bypasses the
    dedup check — the admin explicitly asked to retry."""
    old = await db.get(ImportTask, tid)
    if not old:
        raise HTTPException(404, "not found")
    task = ImportTask(
        youtube_url=old.youtube_url,
        status="queued",
        stage=0,
        progress=0,
        created_by=admin.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    asyncio.create_task(_run_pipeline_bg(task.id, {
        "youtube_url": old.youtube_url,
        "accent": "US",
        "difficulty": 3,
        "llm_override": await require_override(db, admin),
    }))
    return task


async def _run_pipeline_bg(task_id: int, params: dict):
    """Run the pipeline on the app's event loop. Exceptions are logged, never raised
    (we'd lose them — the route already returned)."""
    try:
        async with SessionLocal() as s:
            await run_pipeline(s, task_id, params)
    except Exception:
        log.exception("pipeline task %d crashed", task_id)


# ============ Episode management (admin only) ============
class AdminEpisodeCard(BaseModel):
    id: int
    title: str
    summary: str
    thumbnail_url: str
    video_url: str
    # "h264" iPhone-safe | "av1"/"vp9" broken on iPhone 14- | "" not scanned
    video_codec: str
    # live transcode queue state: "" | queued | running | done | error
    transcode_state: str
    duration_sec: int
    difficulty: int
    accent: str
    chunks_count: int
    subtitles_count: int
    status: str
    category_id: int | None
    category_name: str | None
    topic: str            # admin-editable subject topic (orthogonal to category)
    subtopic: str         # free-text sub-tag inside the topic, clusters narrow-listening
    speaker_handle: str | None
    published_at: datetime | None
    created_at: datetime


class AdminEpisodeDetail(AdminEpisodeCard):
    youtube_url: str
    subtitles: list[dict]
    chunks: list[dict]
    ai_metadata: dict


class EpisodeUpdate(BaseModel):
    title: str | None = None
    summary: str | None = None
    youtube_url: str | None = None
    video_url: str | None = None
    thumbnail_url: str | None = None
    duration_sec: int | None = None
    category_id: int | None = None
    speaker_id: int | None = None
    accent: str | None = None
    difficulty: int | None = None
    topic: str | None = None
    subtopic: str | None = None


class SubtitleUpdate(BaseModel):
    text_en: str | None = None
    text_zh: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None


class ChunkUpdate(BaseModel):
    text: str | None = None
    chunk_type: str | None = None
    why_explanation: str | None = None
    usage_scenario: str | None = None
    difficulty: int | None = None
    similar_expressions: list | None = None
    common_collocations: list | None = None
    pronunciation_tip: str | None = None


class ChunkCreate(BaseModel):
    text: str
    chunk_type: str = "collocation"
    why_explanation: str = ""
    usage_scenario: str = ""
    difficulty: int = 3


def _ep_to_card(ep: Episode) -> dict:
    return {
        "id": ep.id,
        "title": ep.title,
        "summary": ep.summary,
        "thumbnail_url": ep.thumbnail_url,
        "video_url": ep.video_url,
        "video_codec": ep.video_codec or "",
        "transcode_state": transcode_svc.episode_state(ep.id),
        "duration_sec": ep.duration_sec,
        "difficulty": ep.difficulty,
        "accent": ep.accent,
        "chunks_count": ep.chunks_count,
        "subtitles_count": ep.subtitles_count,
        "status": ep.status,
        "category_id": ep.category_id,
        "category_name": ep.category.name if ep.category else None,
        "topic": ep.topic or "other",
        "subtopic": ep.subtopic or "",
        "speaker_handle": ep.speaker.handle if ep.speaker else None,
        "published_at": ep.published_at,
        "created_at": ep.created_at,
    }


@router.get("/episodes", response_model=Page[AdminEpisodeCard])
async def admin_list_episodes(
    status: str | None = None,
    category_id: int | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """List episodes (optional filters). Same-source segments are
    clustered + ascending by segment_index.

    Pagination note: clustering needs whole-dataset visibility (a
    multi-segment group must not split across a page), so we fetch all
    matching rows, cluster, THEN slice. Episode count is bounded by
    curation (hundreds, not millions) so this stays cheap; pagination
    here is about not rendering thousands of DOM rows, not DB load.
    """
    limit = max(1, min(limit, 200))
    query = select(Episode).order_by(Episode.created_at.desc())
    if status:
        query = query.where(Episode.status == status)
    if category_id:
        query = query.where(Episode.category_id == category_id)
    if q:
        pattern = f"%{q}%"
        query = query.where(or_(Episode.title.ilike(pattern), Episode.summary.ilike(pattern)))
    rows = list((await db.execute(query)).scalars().all())
    groups: dict[str, list[Episode]] = {}
    order: list[str] = []
    for r in rows:
        key = r.youtube_url or f"__solo__{r.id}"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(r)

    # segment_index is NULL on legacy multi-segment rows (the column
    # arrived later than the import path); fall back to parsing the
    # "(N/M) ..." prefix in the title so old data still sorts right.
    import re
    def _seg_key(e: Episode) -> int:
        if e.segment_index is not None:
            return e.segment_index
        m = re.match(r"^\((\d+)/\d+\)", e.title or "")
        return int(m.group(1)) if m else 9999

    clustered: list[Episode] = []
    for k in order:
        g = groups[k]
        if len(g) > 1:
            g.sort(key=_seg_key)
        clustered.extend(g)
    total = len(clustered)
    page = clustered[offset:offset + limit]
    return Page(
        items=[_ep_to_card(ep) for ep in page],
        total=total,
        has_more=offset + len(page) < total,
    )


@router.get("/episodes/{ep_id}", response_model=AdminEpisodeDetail)
async def admin_get_episode(
    ep_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    subs = (
        await db.execute(select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq))
    ).scalars().all()
    chunks = (
        await db.execute(select(Chunk).where(Chunk.episode_id == ep_id).order_by(Chunk.id))
    ).scalars().all()
    return {
        **_ep_to_card(ep),
        "youtube_url": ep.youtube_url,
        "ai_metadata": ep.ai_metadata or {},
        "subtitles": [
            {
                "id": s.id, "seq": s.seq, "start_ms": s.start_ms, "end_ms": s.end_ms,
                "text_en": s.text_en, "text_zh": s.text_zh,
            }
            for s in subs
        ],
        "chunks": [
            {
                "id": c.id, "text": c.text, "chunk_type": c.chunk_type,
                "why_explanation": c.why_explanation, "usage_scenario": c.usage_scenario,
                "similar_expressions": c.similar_expressions, "common_collocations": c.common_collocations,
                "pronunciation_tip": c.pronunciation_tip, "difficulty": c.difficulty,
            }
            for c in chunks
        ],
    }


@router.put("/episodes/{ep_id}")
async def admin_update_episode(
    ep_id: int,
    body: EpisodeUpdate,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    data = body.model_dump(exclude_unset=True)
    # Validate FKs if changed
    if "category_id" in data and data["category_id"]:
        if not await db.get(Category, data["category_id"]):
            raise HTTPException(400, "category_id not found")
    if "speaker_id" in data and data["speaker_id"]:
        if not await db.get(Speaker, data["speaker_id"]):
            raise HTTPException(400, "speaker_id not found")
    for k, v in data.items():
        setattr(ep, k, v)
    await db.commit()
    return {"ok": True, "id": ep.id}


@router.post("/episodes/{ep_id}/publish")
async def admin_publish_episode(
    ep_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    ep.status = "published"
    if not ep.published_at:
        ep.published_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "status": ep.status}


@router.post("/episodes/{ep_id}/unpublish")
async def admin_unpublish_episode(
    ep_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    ep.status = "reviewing"
    await db.commit()
    return {"ok": True, "status": ep.status}


@router.delete("/episodes/{ep_id}", status_code=204)
async def admin_delete_episode(
    ep_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    await db.delete(ep)  # cascade deletes subtitles + chunks via FK
    await db.commit()


# ---------- Video codec / iPhone-compat transcode ----------
_IPHONE_BROKEN_CODECS = ("av1", "vp9", "vp09")


@router.post("/episodes/scan-codecs")
async def admin_scan_codecs(
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """ffprobe every episode's stored file and backfill `video_codec`.

    On-demand (admin button), never on startup — probing 150+ files is
    slow. Only writes rows whose probed codec differs from the column.
    """
    rows = (await db.execute(select(Episode))).scalars().all()
    scanned = changed = 0
    counts: dict[str, int] = {}
    for ep in rows:
        path = transcode_svc._media_path(ep.video_url)
        if path is None or not path.exists():
            continue
        codec, _pix = await asyncio.to_thread(probe_video_codec, str(path))
        scanned += 1
        codec = codec or "unknown"
        counts[codec] = counts.get(codec, 0) + 1
        if codec != "unknown" and ep.video_codec != codec:
            ep.video_codec = codec
            changed += 1
    if changed:
        await db.commit()
    av1 = sum(v for k, v in counts.items() if k in _IPHONE_BROKEN_CODECS)
    return {"scanned": scanned, "updated": changed, "by_codec": counts, "iphone_broken": av1}


@router.post("/episodes/{ep_id}/transcode")
async def admin_transcode_episode(
    ep_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Queue one episode for in-place AV1/VP9 → H.264 re-encode."""
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    if (ep.video_codec or "") in ("h264", "avc1"):
        raise HTTPException(400, "episode is already H.264")
    if not ep.video_url:
        raise HTTPException(400, "episode has no stored video file")
    state = transcode_svc.enqueue(ep_id)
    return {"ok": True, "ep_id": ep_id, "state": state}


@router.post("/episodes/transcode-all-av1")
async def admin_transcode_all_av1(
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Queue every non-H.264 episode (FIFO, single-flight in the worker)."""
    rows = (await db.execute(
        select(Episode).where(Episode.video_codec.in_(_IPHONE_BROKEN_CODECS))
    )).scalars().all()
    queued = [transcode_svc.enqueue(ep.id) for ep in rows if ep.video_url]
    return {"ok": True, "queued": len(queued), "total_av1": len(rows)}


@router.get("/transcode-status")
async def admin_transcode_status(_: User = Depends(current_admin)):
    """Live queue snapshot for the admin UI to poll."""
    return transcode_svc.status_snapshot()


# ---------- Subtitle edits ----------
@router.put("/subtitles/{sub_id}")
async def admin_update_subtitle(
    sub_id: int,
    body: SubtitleUpdate,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(Subtitle, sub_id)
    if not sub:
        raise HTTPException(404, "subtitle not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(sub, k, v)
    await db.commit()
    return {"ok": True}


@router.delete("/subtitles/{sub_id}", status_code=204)
async def admin_delete_subtitle(
    sub_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(Subtitle, sub_id)
    if not sub:
        raise HTTPException(404, "subtitle not found")
    ep_id = sub.episode_id
    await db.delete(sub)
    # Refresh count on parent episode
    cnt = await db.scalar(select(func.count()).select_from(Subtitle).where(Subtitle.episode_id == ep_id))
    ep = await db.get(Episode, ep_id)
    if ep:
        ep.subtitles_count = int(cnt or 0)
    await db.commit()


# ---------- Chunk edits ----------
@router.post("/episodes/{ep_id}/chunks")
async def admin_add_chunk(
    ep_id: int,
    body: ChunkCreate,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    chunk = Chunk(
        episode_id=ep_id,
        text=body.text,
        chunk_type=body.chunk_type,
        why_explanation=body.why_explanation,
        usage_scenario=body.usage_scenario,
        difficulty=body.difficulty,
        similar_expressions=[],
        common_collocations=[],
        pronunciation_tip="",
        occurrences=[],
    )
    db.add(chunk)
    await db.flush()
    cnt = await db.scalar(select(func.count()).select_from(Chunk).where(Chunk.episode_id == ep_id))
    ep.chunks_count = int(cnt or 0)
    await db.commit()
    return {"ok": True, "id": chunk.id}


@router.put("/chunks/{chunk_id}")
async def admin_update_chunk(
    chunk_id: int,
    body: ChunkUpdate,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    chunk = await db.get(Chunk, chunk_id)
    if not chunk:
        raise HTTPException(404, "chunk not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(chunk, k, v)
    await db.commit()
    return {"ok": True}


@router.delete("/chunks/{chunk_id}", status_code=204)
async def admin_delete_chunk(
    chunk_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    chunk = await db.get(Chunk, chunk_id)
    if not chunk:
        raise HTTPException(404, "chunk not found")
    ep_id = chunk.episode_id
    await db.delete(chunk)
    if ep_id:
        cnt = await db.scalar(select(func.count()).select_from(Chunk).where(Chunk.episode_id == ep_id))
        ep = await db.get(Episode, ep_id)
        if ep:
            ep.chunks_count = int(cnt or 0)
    await db.commit()


# ---------- Regenerate LLM-produced fields from stored subtitles ----------
# These reuse the captions already in the DB, so admins can iterate on chunk /
# scenario quality without re-downloading the video or hitting YouTube again.
# Typical turnaround is 10-30 seconds (one DeepSeek call).
from ..services import llm as _llm_mod


@router.post("/episodes/{ep_id}/regenerate-chunks")
async def admin_regenerate_chunks(
    ep_id: int,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    subs = (await db.execute(
        select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq)
    )).scalars().all()
    if not subs:
        raise HTTPException(400, "episode has no subtitles to extract chunks from")

    full_en = " ".join(s.text_en for s in subs)
    # admin 按的按钮 = admin 自己的 key。平台不再有 key 兜底。
    with _llm_mod.use_override(await require_override(db, admin)):
        chunk_data = await asyncio.to_thread(_llm_mod.extract_chunks, full_en)
    if not chunk_data:
        raise HTTPException(502, "LLM returned no chunks")

    await db.execute(delete(Chunk).where(Chunk.episode_id == ep_id))
    chunk_objs: list[Chunk] = []
    for c in chunk_data:
        obj = Chunk(episode_id=ep_id, **c)
        db.add(obj)
        chunk_objs.append(obj)
    await db.flush()

    # Back-fill chunk_refs on existing subtitles so the "文中例句" lookup
    # can also work from the backend, not just via frontend text matching.
    for s in subs:
        en_lower = s.text_en.lower()
        s.chunk_refs = [co.id for co in chunk_objs if co.text.lower() in en_lower]
    ep.chunks_count = len(chunk_data)
    await db.commit()
    return {"ok": True, "chunks_count": len(chunk_data)}


@router.post("/episodes/{ep_id}/regenerate-scenario")
async def admin_regenerate_scenario(
    ep_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    chunks = (await db.execute(
        select(Chunk).where(Chunk.episode_id == ep_id).order_by(Chunk.id)
    )).scalars().all()

    scenario, _opening = await asyncio.to_thread(
        _llm_mod.design_scenario,
        ep.title,
        ep.summary,
        [c.text for c in chunks],
    )
    # Merge into ai_metadata so the rest of the structure (segment etc.) stays.
    meta = dict(ep.ai_metadata or {})
    meta["scenario"] = scenario
    ep.ai_metadata = meta
    await db.commit()
    return {"ok": True, "scenario": scenario}


@router.post("/episodes/{ep_id}/regenerate-summary-zh")
async def admin_regenerate_summary_zh(
    ep_id: int,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Re-generate the casual Chinese intro from the clip transcript.

    Earlier versions of this endpoint just translated ep.summary (the
    English summary) to Chinese verbatim, which read like a press
    release.  After the casual-intro rewrite, the Chinese intro is
    actually a freshly authored friend-recommending-friend blurb based
    on the full transcript + creator name + title — translating
    ep.summary alone wouldn't have the same flavor.  We now re-call
    summarize_clip with the same inputs the pipeline would, falling back
    to translation only if there's no transcript on disk."""
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")

    subs = (await db.execute(
        select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq)
    )).scalars().all()
    transcript = " ".join(s.text_en for s in subs).strip()

    creator_name = ep.speaker.name if ep.speaker else ""
    title = ep.title or ""

    en = ""
    zh = ""
    if transcript:
        en, zh = await asyncio.to_thread(
            _llm_mod.summarize_clip, transcript, creator_name, title,
        )
    if not zh and ep.summary:
        # Fallback path for episodes whose subtitles were wiped — still
        # better to have *some* Chinese intro than blank.
        zh = await asyncio.to_thread(_llm_mod.translate_to_zh, ep.summary)
    if not zh:
        raise HTTPException(502, "LLM returned empty translation")

    meta = dict(ep.ai_metadata or {})
    meta["summary_zh"] = zh
    ep.ai_metadata = meta
    if en and not ep.summary:
        ep.summary = en
    await db.commit()
    return {"ok": True, "summary_zh": zh}


@router.post("/episodes/{ep_id}/regenerate-lesson-brief")
async def admin_regenerate_lesson_brief(
    ep_id: int,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Re-run llm.generate_lesson_brief and persist into
    ai_metadata.lesson_brief.  Used both for the first-time backfill of
    pre-feature episodes and to refresh a brief that read poorly on the
    first try.  No-ops on an episode with no chunks or no subtitles."""
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")

    subs = (await db.execute(
        select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq)
    )).scalars().all()
    if not subs:
        raise HTTPException(400, "episode has no subtitles to read")

    chunks = (await db.execute(
        select(Chunk).where(Chunk.episode_id == ep_id).order_by(Chunk.id)
    )).scalars().all()
    if not chunks:
        raise HTTPException(400, "episode has no chunks; extract chunks first")

    transcript = " ".join(s.text_en for s in subs)
    creator_name = ep.speaker.name if ep.speaker else ""
    with _llm_mod.use_override(await require_override(db, admin)):
        brief = await asyncio.to_thread(
            _llm_mod.generate_lesson_brief,
            transcript,
            [c.text for c in chunks],
            creator_name,
            ep.title or "",
        )
    if not brief:
        raise HTTPException(502, "LLM returned no brief")

    meta = dict(ep.ai_metadata or {})
    meta["lesson_brief"] = brief
    ep.ai_metadata = meta
    await db.commit()
    return {"ok": True, "lesson_brief": brief}


@router.post("/episodes/{ep_id}/retranslate-subtitles")
async def admin_retranslate_subtitles(
    ep_id: int,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Re-run the batch subtitle translator on this episode and overwrite
    every row's text_zh.

    Useful for older episodes whose translations were generated before the
    prompt was hardened against implicit relative clauses, run-on sentences
    and subject-object inversion (e.g. "I was one of the few creators they
    told me about it" was translating to "他们是少数几个告诉我的创作者" —
    subject inverted). Re-running with the current prompt produces the
    correct subject alignment without re-importing the video.

    Idempotent: running it twice on the same episode just produces the same
    result. Doesn't touch text_en, word_timings, chunk_refs."""
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    subs = (await db.execute(
        select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq)
    )).scalars().all()
    if not subs:
        raise HTTPException(400, "episode has no subtitles to translate")

    rows = [(s.start_ms, s.end_ms, s.text_en, s.text_zh or "") for s in subs]
    with _llm_mod.use_override(await require_override(db, admin)):
        translated = await asyncio.to_thread(_translate_to_zh, rows)

    updated = 0
    for sub, (_s, _e, _en, zh) in zip(subs, translated):
        if zh and zh != sub.text_zh:
            sub.text_zh = zh
            updated += 1
    await db.commit()
    return {"ok": True, "updated": updated, "total": len(subs)}


