"""Bundle import — persist a pre-computed episode bundle to the DB.

A "bundle" is everything the pipeline would have produced for one YouTube
URL, computed on a local Mac (yt-dlp + LLM) and shipped to the server as a
JSON manifest + video/thumbnail files. The server does NO yt-dlp / LLM work
— it just stores the media and writes the DB rows, replicating exactly what
``pipeline._process_segment`` stage-5b does.

One bundle → N segments (Episodes) that share ``youtube_url`` and the
``speaker`` (get-or-created once). This mirrors the multi-segment "full"
collection mode without re-running the split.

Text in the manifest is already normalized by the local pipeline export, so
this module writes it verbatim and only recomputes ``chunk_refs`` (the
case-insensitive substring match of chunk text against each subtitle) — the
one derived field that depends on freshly-assigned chunk IDs.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Chunk, Episode, Speaker, Subtitle
from ..models.episode import EpisodeChapter
from ..models.word import FeaturedWord
from . import storage

log = logging.getLogger("bundle")


# ── Manifest schema ────────────────────────────────────────────────────────
# Field names mirror the model columns so the local exporter and this importer
# stay obviously in sync. Everything optional has a model-matching default.

class BundleSpeaker(BaseModel):
    name: str = ""
    handle: str = ""
    channel_id: str = ""
    youtube_url: str = ""
    default_accent: str = "US"


class BundleChunk(BaseModel):
    text: str
    chunk_type: str = "collocation"
    why_explanation: str = ""
    usage_scenario: str = ""
    similar_expressions: list = Field(default_factory=list)
    common_collocations: list = Field(default_factory=list)
    pronunciation_tip: str = ""
    difficulty: int = 3


class BundleSubtitle(BaseModel):
    seq: int
    start_ms: int
    end_ms: int
    text_en: str
    text_zh: str = ""
    word_timings: list = Field(default_factory=list)
    # chunk_refs is intentionally NOT accepted from the manifest — it's
    # recomputed server-side against the freshly-inserted chunk IDs.


class BundleChapter(BaseModel):
    order_idx: int
    start_ms: int
    end_ms: int
    title_en: str = ""
    title_zh: str = ""
    summary_zh: str = ""


class BundleFeaturedWord(BaseModel):
    word: str
    ipa: str = ""
    pos: str = ""
    cefr: str = ""
    definition_en: str = ""
    definition_zh: str = ""
    example: str = ""
    context_text: str = ""
    # 1-based subtitle seq this word first appears in; mapped to the real
    # subtitle.id after subtitles are flushed. None → no jump-to-context.
    context_seq: int | None = None
    importance: int = 3


class BundleSegment(BaseModel):
    title: str
    summary: str = ""
    # Relative paths into the bundle archive; matched against uploaded files
    # by filename. thumb_file optional — if absent, thumbnail_url (an external
    # YouTube URL) is used as-is.
    video_file: str
    thumb_file: str | None = None
    thumbnail_url: str = ""
    video_codec: str = ""
    duration_sec: int = 0
    topic: str = "other"
    subtopic: str = ""
    accent: str = "US"
    difficulty: int = 3
    category_id: int | None = None
    status: str = "published"
    import_mode: str = "segment"
    collection_kind: str | None = None
    segment_index: int | None = None
    ai_metadata: dict = Field(default_factory=dict)
    chunks: list[BundleChunk] = Field(default_factory=list)
    subtitles: list[BundleSubtitle] = Field(default_factory=list)
    chapters: list[BundleChapter] = Field(default_factory=list)
    featured_words: list[BundleFeaturedWord] = Field(default_factory=list)


class BundleManifest(BaseModel):
    youtube_url: str
    speaker: BundleSpeaker | None = None
    # Echoed for provenance/debugging; not persisted directly.
    yt_id: str = ""
    segments: list[BundleSegment]


# ── Persistence ────────────────────────────────────────────────────────────

async def _get_or_create_speaker(
    db: AsyncSession, sp: BundleSpeaker | None
) -> int | None:
    """Mirror of pipeline's Creator auto-bind: match by channel_id, then by
    name; create if neither matches; backfill channel_id on an old name-only
    row. Returns speaker.id or None when the bundle carries no speaker."""
    if sp is None:
        return None
    ch_id = (sp.channel_id or "").strip()
    ch_name = (sp.name or "").strip()
    handle = (sp.handle or "").strip()
    if not (ch_id or ch_name or handle):
        return None

    row: Speaker | None = None
    if ch_id:
        row = (await db.execute(
            select(Speaker).where(Speaker.channel_id == ch_id)
        )).scalar_one_or_none()
    if row is None and ch_name:
        row = (await db.execute(
            select(Speaker).where(Speaker.name == ch_name)
        )).scalar_one_or_none()

    if row is None:
        if handle and not handle.startswith("@"):
            handle = "@" + handle
        row = Speaker(
            name=ch_name or (handle.lstrip("@") if handle else "Unknown"),
            handle=handle or "",
            channel_id=ch_id,
            youtube_url=(sp.youtube_url or "").strip(),
            default_accent=sp.default_accent or "US",
        )
        db.add(row)
        await db.flush()
    elif ch_id and not row.channel_id:
        row.channel_id = ch_id
        await db.flush()
    return row.id


async def _store_segment_media(
    seg: BundleSegment, file_map: dict[str, Path], saved: list[str]
) -> tuple[str, str]:
    """Upload this segment's video (+ optional thumb) and return
    (video_url, thumbnail_url) as relative /media paths. Appends every
    stored relative path to ``saved`` for rollback cleanup."""
    token = uuid.uuid4().hex[:12]

    src_video = file_map.get(seg.video_file)
    if src_video is None:
        raise ValueError(f"video file missing from upload: {seg.video_file}")
    video_rel = f"/media/videos/{token}.mp4"
    await storage.save_media(video_rel, src_video, "video/mp4")
    saved.append(video_rel)

    thumb_url = seg.thumbnail_url or ""
    if seg.thumb_file:
        src_thumb = file_map.get(seg.thumb_file)
        if src_thumb is not None:
            thumb_rel = f"/media/thumbs/{token}.jpg"
            await storage.save_media(thumb_rel, src_thumb, "image/jpeg")
            saved.append(thumb_rel)
            thumb_url = thumb_rel
    return video_rel, thumb_url


async def _persist_segment(
    db: AsyncSession,
    manifest: BundleManifest,
    seg: BundleSegment,
    sp_id: int | None,
    file_map: dict[str, Path],
    saved: list[str],
) -> Episode:
    video_url, thumbnail_url = await _store_segment_media(seg, file_map, saved)

    ep = Episode(
        title=seg.title,
        summary=seg.summary,
        youtube_url=manifest.youtube_url,
        video_url=video_url,
        video_codec=seg.video_codec,
        thumbnail_url=thumbnail_url,
        duration_sec=seg.duration_sec,
        category_id=seg.category_id,
        speaker_id=sp_id,
        topic=seg.topic or "other",
        subtopic=seg.subtopic or "",
        accent=seg.accent or "US",
        difficulty=seg.difficulty,
        subtitles_count=len(seg.subtitles),
        chunks_count=len(seg.chunks),
        status=seg.status or "published",
        published_at=datetime.now(timezone.utc),
        collection_kind=seg.collection_kind,
        segment_index=seg.segment_index,
        import_mode=seg.import_mode or "segment",
        ai_metadata=seg.ai_metadata or {},
    )
    db.add(ep)
    await db.flush()  # assigns ep.id

    # Chunks first — we need their IDs to backfill subtitle.chunk_refs.
    chunk_objs: list[Chunk] = []
    for c in seg.chunks:
        obj = Chunk(episode_id=ep.id, **c.model_dump())
        db.add(obj)
        chunk_objs.append(obj)
    await db.flush()  # assigns chunk IDs

    # Subtitles + chunk_refs backfill (same substring match as the pipeline).
    sub_by_seq: dict[int, Subtitle] = {}
    for s in seg.subtitles:
        en_lower = s.text_en.lower()
        refs = [co.id for co in chunk_objs if co.text.lower() in en_lower]
        sub = Subtitle(
            episode_id=ep.id,
            seq=s.seq,
            start_ms=s.start_ms,
            end_ms=s.end_ms,
            text_en=s.text_en,
            text_zh=s.text_zh,
            chunk_refs=refs,
            word_timings=s.word_timings,
        )
        db.add(sub)
        sub_by_seq[s.seq] = sub
    await db.flush()  # assigns subtitle IDs (needed for featured-word context)

    for ch in seg.chapters:
        db.add(EpisodeChapter(
            episode_id=ep.id,
            order_idx=ch.order_idx,
            start_ms=ch.start_ms,
            end_ms=ch.end_ms,
            title_en=ch.title_en[:255],
            title_zh=ch.title_zh[:255],
            summary_zh=ch.summary_zh,
        ))

    for fw in seg.featured_words:
        ctx_sub = sub_by_seq.get(fw.context_seq) if fw.context_seq else None
        db.add(FeaturedWord(
            episode_id=ep.id,
            word=fw.word,
            ipa=fw.ipa,
            pos=fw.pos,
            cefr=fw.cefr,
            definition_en=fw.definition_en,
            definition_zh=fw.definition_zh,
            example=fw.example,
            context_subtitle_id=ctx_sub.id if ctx_sub else None,
            context_text=fw.context_text,
            importance=fw.importance,
        ))

    return ep


async def persist_bundle(
    db: AsyncSession,
    manifest: BundleManifest,
    file_map: dict[str, Path],
) -> tuple[list[int], list[str]]:
    """Write the whole bundle in one transaction-ish unit. The caller owns the
    DB session (commit/rollback) so it can pair a rollback with media cleanup.

    Returns (episode_ids, saved_media_paths). On any error the exception
    propagates with ``saved_media_paths`` already populated via the passed-in
    accumulator pattern is NOT used here; instead the caller should catch and
    call ``storage.delete_media`` on the returned/accumulated paths — see the
    router. To make that possible even on failure, we attach the accumulator
    to the exception.
    """
    saved: list[str] = []
    try:
        sp_id = await _get_or_create_speaker(db, manifest.speaker)
        ep_ids: list[int] = []
        for seg in manifest.segments:
            ep = await _persist_segment(db, manifest, seg, sp_id, file_map, saved)
            ep_ids.append(ep.id)
        return ep_ids, saved
    except Exception as e:  # noqa: BLE001 — re-raise with cleanup hints attached
        e._bundle_saved_media = saved  # type: ignore[attr-defined]
        raise
