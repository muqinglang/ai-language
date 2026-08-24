"""Stage 6 — export a locally-imported episode (or collection) to a bundle.

Design: the local Mac runs the existing pipeline normally (``POST /import``),
which writes Episode/Chunk/Subtitle/Speaker rows to the LOCAL dev DB and the
media to the local ``/app/media`` volume. This script reads those rows back
OUT and serializes them into a portable bundle directory:

    out/<yt_id>/
      manifest.json              # BundleManifest (see services/bundle.py)
      segments/1/video.mp4        # copied from the media volume
      segments/1/thumb.jpg
      segments/2/...

Because the bundle is a faithful serialization of a real DB row, uploading it
to the remote ECS via ``scripts.publish`` reproduces byte-identical rows there
— no yt-dlp / LLM re-run, no drift. ``chunk_refs`` is deliberately NOT exported
(the importer recomputes it against the freshly-inserted chunk IDs).

Run inside the api container where the DB + media volume are visible:

    docker exec justspeak-api python -m app.scripts.export_bundle \\
        "https://www.youtube.com/watch?v=XXXX" [--out /app/out]

Known phase-1 simplification: ``category_id`` is NOT carried (category IDs
differ across DBs). ``topic`` — the field that actually drives the UI — is
carried. Wire category by slug later if needed.
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from sqlalchemy import select

from ..db import SessionLocal
from ..models import Chunk, Episode, EpisodeChapter, FeaturedWord, Speaker, Subtitle
from ..services import storage
from ..services.bundle import (
    BundleChapter,
    BundleChunk,
    BundleFeaturedWord,
    BundleManifest,
    BundleSegment,
    BundleSpeaker,
    BundleSubtitle,
)


def _yt_id(url: str) -> str:
    """Best-effort YouTube video id for the output folder name."""
    u = urlparse(url)
    if u.hostname and "youtu.be" in u.hostname:
        return u.path.lstrip("/") or "bundle"
    qs = parse_qs(u.query)
    if "v" in qs and qs["v"]:
        return qs["v"][0]
    return (u.path.rsplit("/", 1)[-1] or "bundle")


def _copy_media(rel_url: str, dest: Path) -> bool:
    """Copy a /media/... file out of the volume into the bundle. Returns
    False if the source isn't a local media path (e.g. external thumb URL)."""
    if not rel_url or not rel_url.startswith("/media/"):
        return False
    src = storage._rel_to_disk(rel_url)
    if not src.exists():
        raise FileNotFoundError(f"media file missing on disk: {src} (for {rel_url})")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    return True


async def export(youtube_url: str, out_root: Path) -> Path:
    async with SessionLocal() as db:
        eps = (await db.execute(
            select(Episode)
            .where(Episode.youtube_url == youtube_url)
            .order_by(Episode.segment_index.nulls_first(), Episode.id)
        )).scalars().all()
        if not eps:
            raise SystemExit(f"no episodes found for {youtube_url!r} in local DB")

        # Speaker is shared across the collection — take it from the first ep.
        speaker_block: BundleSpeaker | None = None
        sp_id = eps[0].speaker_id
        if sp_id:
            sp = await db.get(Speaker, sp_id)
            if sp:
                speaker_block = BundleSpeaker(
                    name=sp.name, handle=sp.handle, channel_id=sp.channel_id,
                    youtube_url=sp.youtube_url, default_accent=sp.default_accent,
                )

        yt_id = _yt_id(youtube_url)
        out_dir = out_root / yt_id
        if out_dir.exists():
            shutil.rmtree(out_dir)
        (out_dir / "segments").mkdir(parents=True)

        segments: list[BundleSegment] = []
        for idx, ep in enumerate(eps, start=1):
            seg_dir = f"segments/{idx}"

            video_rel = f"{seg_dir}/video.mp4"
            _copy_media(ep.video_url, out_dir / video_rel)

            thumb_rel: str | None = None
            thumb_url = ""
            if ep.thumbnail_url.startswith("/media/"):
                thumb_rel = f"{seg_dir}/thumb.jpg"
                _copy_media(ep.thumbnail_url, out_dir / thumb_rel)
            else:
                thumb_url = ep.thumbnail_url  # external (YouTube) URL — keep as-is

            chunks = (await db.execute(
                select(Chunk).where(Chunk.episode_id == ep.id).order_by(Chunk.id)
            )).scalars().all()
            subs = (await db.execute(
                select(Subtitle).where(Subtitle.episode_id == ep.id).order_by(Subtitle.seq)
            )).scalars().all()
            chapters = (await db.execute(
                select(EpisodeChapter).where(EpisodeChapter.episode_id == ep.id)
                .order_by(EpisodeChapter.order_idx)
            )).scalars().all()
            fwords = (await db.execute(
                select(FeaturedWord).where(FeaturedWord.episode_id == ep.id)
                .order_by(FeaturedWord.id)
            )).scalars().all()

            sub_id_to_seq = {s.id: s.seq for s in subs}

            segments.append(BundleSegment(
                title=ep.title,
                summary=ep.summary,
                video_file=video_rel,
                thumb_file=thumb_rel,
                thumbnail_url=thumb_url,
                video_codec=ep.video_codec,
                duration_sec=ep.duration_sec,
                topic=ep.topic,
                subtopic=ep.subtopic,
                accent=ep.accent,
                difficulty=ep.difficulty,
                status=ep.status,
                import_mode=ep.import_mode,
                collection_kind=ep.collection_kind,
                segment_index=ep.segment_index,
                ai_metadata=ep.ai_metadata or {},
                chunks=[BundleChunk(
                    text=c.text, chunk_type=c.chunk_type,
                    why_explanation=c.why_explanation, usage_scenario=c.usage_scenario,
                    similar_expressions=c.similar_expressions or [],
                    common_collocations=c.common_collocations or [],
                    pronunciation_tip=c.pronunciation_tip, difficulty=c.difficulty,
                ) for c in chunks],
                subtitles=[BundleSubtitle(
                    seq=s.seq, start_ms=s.start_ms, end_ms=s.end_ms,
                    text_en=s.text_en, text_zh=s.text_zh,
                    word_timings=s.word_timings or [],
                ) for s in subs],
                chapters=[BundleChapter(
                    order_idx=ch.order_idx, start_ms=ch.start_ms, end_ms=ch.end_ms,
                    title_en=ch.title_en, title_zh=ch.title_zh, summary_zh=ch.summary_zh,
                ) for ch in chapters],
                featured_words=[BundleFeaturedWord(
                    word=w.word, ipa=w.ipa, pos=w.pos, cefr=w.cefr,
                    definition_en=w.definition_en, definition_zh=w.definition_zh,
                    example=w.example, context_text=w.context_text,
                    context_seq=sub_id_to_seq.get(w.context_subtitle_id),
                    importance=w.importance,
                ) for w in fwords],
            ))

        manifest = BundleManifest(
            youtube_url=youtube_url, yt_id=yt_id,
            speaker=speaker_block, segments=segments,
        )
        (out_dir / "manifest.json").write_text(
            manifest.model_dump_json(indent=2), encoding="utf-8"
        )

        total_subs = sum(len(s.subtitles) for s in segments)
        total_chunks = sum(len(s.chunks) for s in segments)
        print(
            f"✓ exported {len(segments)} segment(s) → {out_dir}\n"
            f"  speaker: {speaker_block.name if speaker_block else '(none)'}\n"
            f"  subtitles: {total_subs}  chunks: {total_chunks}"
        )
        return out_dir


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Export a locally-imported episode to a bundle.")
    ap.add_argument("youtube_url")
    ap.add_argument("--out", default="/app/out", help="output root dir (default /app/out)")
    args = ap.parse_args(argv)
    asyncio.run(export(args.youtube_url, Path(args.out)))


if __name__ == "__main__":
    main(sys.argv[1:])
