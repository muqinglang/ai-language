"""
AI pipeline runner with graceful fallback.

Stages:
    1. download      yt-dlp (real)  → hard-fails if segment download fails
    2. transcribe    whisper (real) → hard-fails if both YouTube caps + whisper return nothing
    3. extract       llm.extract_chunks (Claude when key set, else stub)
    4. dialog        llm.design_scenario (same)
    5. qa            local validation

Run order: each stage updates the ImportTask row, persists to DB, yields control.
If a dependency is missing, the stage logs a warning and uses the canned fallback.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from bisect import bisect_left
from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal
from ..models import Category, Chunk, Episode, EpisodeChapter, ImportTask, Subtitle
from . import llm
from .text_norm import normalize_list, normalize_proper_nouns

# Target learning clip length. The LLM picks the exact window from the full
# transcript; this is only the fallback size when we don't have captions to
# choose from (e.g. no YouTube subs and we need to pick blind).
SEGMENT_LENGTH_SEC = 150
# Hard floor + ceiling for AI-picked windows. DeepSeek occasionally returns
# 30-90s segments by greedy density-of-good-content; learners need 2-3 min
# of context to actually practice. We post-process to clip into this range:
# below MIN we extend asymmetrically (1/3 back, 2/3 forward); above MAX we
# clamp by truncating the tail.
MIN_SEGMENT_LENGTH_SEC = 120
MAX_SEGMENT_LENGTH_SEC = 180
# Start padding = 0: clip starts exactly at the AI-selected time so audio
# and the first subtitle appear together.  Non-zero start padding creates a
# gap where audio plays before any subtitle shows (the pre-padding VTT rows
# get filtered out, leaving silence-with-no-subtitle at the clip head).
# End padding = 2: small buffer so yt-dlp / codec cuts don't clip the last
# spoken word.
SEGMENT_START_PADDING_SEC = 0
# 4s instead of 2s: the prior 2s wasn't enough when the AI's chosen end_ms
# landed mid-sentence and the speaker's tail extended ~3-5s past it. Combined
# with _extend_segment_end_to_sentence (which snaps forward to the next .!?
# when one is reachable within 8s), 4s of padding is a defensive backstop
# for the cases where no clean sentence boundary exists.
SEGMENT_END_PADDING_SEC = 4

# yt-dlp format selector that prefers H.264/AVC video. iPhone 14 and
# earlier (~90% of iPhones) cannot hardware-decode AV1; YouTube serves
# av01 inside .mp4 too, so a plain [ext=mp4] filter is not enough — the
# selector must constrain vcodec. Chain: AVC+m4a → AVC+any-audio →
# any mp4 → any 1080p → anything. _finalize_mp4 transcodes whatever
# still comes back as av1/vp9, so this is best-effort, not load-bearing.
_H264_FORMAT = (
    "bv*[vcodec^=avc][height<=1080]+ba[ext=m4a]/"
    "bv*[vcodec^=avc][height<=1080]+ba/"
    "bv*[height<=1080][ext=mp4]+ba/"
    "b[height<=1080]/best"
)


# A beat on each side of a detected sponsor read: the LLM marks the words,
# but the jingle and the "…anyway, where were we" both bleed past them.
_AD_MARGIN_SEC = 2
# Below this a window is too short to practice with, so a segment that can
# only be salvaged by shrinking past it gets dropped instead.
_MIN_SALVAGE_SEC = 90


async def _recover_session(db: AsyncSession, task: ImportTask) -> None:
    """Make `db` and `task` usable again after a segment blew up.

    Rolling back is not enough on its own: it expires every attribute on
    `task`, and the next mark() reads `task.log` — a lazy refresh, which in
    async SQLAlchemy raises MissingGreenlet rather than quietly reloading.
    Refreshing here keeps a failed segment from taking down the segments
    after it via a second, more confusing error.
    """
    try:
        await db.rollback()
        await db.refresh(task)
    except Exception as e:
        log.warning("session recovery failed: %s", e)


def _clean_intervals(
    ad_spans: list[dict], full_duration: int
) -> list[tuple[int, int]]:
    """The timeline minus the ad spans (each widened by _AD_MARGIN_SEC)."""
    if not full_duration:
        return []
    blocked: list[tuple[int, int]] = sorted(
        (max(0, int(a["start"]) - _AD_MARGIN_SEC),
         min(full_duration, int(a["end"]) + _AD_MARGIN_SEC))
        for a in ad_spans
    )
    clean: list[tuple[int, int]] = []
    cursor = 0
    for lo, hi in blocked:
        if lo > cursor:
            clean.append((cursor, min(lo, full_duration)))
        cursor = max(cursor, hi)
    if cursor < full_duration:
        clean.append((cursor, full_duration))
    return [(lo, hi) for lo, hi in clean if hi > lo]


def _relocate_out_of_ads(
    seg: dict, ad_spans: list[dict], full_duration: int, *, trim_only: bool = False
) -> bool:
    """Move `seg` out of any advertisement it overlaps. Mutates seg.

    Returns False when the segment cannot be salvaged and should be dropped.

    The prompts have always told the picker to skip sponsor reads and it
    picks them anyway — an ad read is fluent, idiomatic, well-articulated
    English, so it scores well on every criterion the picker actually
    optimizes. This is the part that does not depend on the model
    cooperating: whatever comes back gets moved into a clean interval.

    trim_only=True (full-video mode, where segments tile the whole video)
    trims the edges and drops mostly-ad segments but never relocates —
    relocating would make neighbouring segments overlap.
    """
    if not ad_spans:
        return True
    start, end = int(seg.get("start", 0)), int(seg.get("end", 0))
    if end <= start:
        return False
    clean = _clean_intervals(ad_spans, full_duration or end)
    if not clean:
        return False

    def overlap(a: tuple[int, int], b: tuple[int, int]) -> int:
        return max(0, min(a[1], b[1]) - max(a[0], b[0]))

    if not any(overlap((start, end), (int(a["start"]), int(a["end"]))) for a in ad_spans):
        return True

    def distance(c: tuple[int, int]) -> int:
        """0 when the window touches this interval, else the gap to it."""
        if c[1] <= start:
            return start - c[1]
        if c[0] >= end:
            return c[0] - end
        return 0

    # Home in on a clean interval: the one holding most of the window, then
    # the nearest, then the longest. When the window sits ENTIRELY inside an
    # ad every overlap is 0, which is exactly when proximity has to decide —
    # ranking on overlap alone silently picks whichever interval sorts first.
    # Fragments too short to hold a full window are excluded unless nothing
    # else is left (never in trim_only mode, which must not relocate).
    candidates = clean
    if not trim_only:
        candidates = [
            c for c in clean if c[1] - c[0] >= MIN_SEGMENT_LENGTH_SEC
        ] or clean
    host = max(
        candidates,
        key=lambda c: (overlap((start, end), c), -distance(c), c[1] - c[0]),
    )
    new_start, new_end = max(start, host[0]), min(end, host[1])

    if new_end <= new_start and not trim_only:
        # The window and its host don't intersect at all (window was buried
        # in an ad). Anchor to the host edge nearest the original pick.
        # Not in trim_only mode: moving a tiling segment somewhere else
        # would overlap its neighbours, so it falls through to the drop
        # below instead.
        if host[0] >= end:
            new_start = host[0]
            new_end = min(host[1], new_start + SEGMENT_LENGTH_SEC)
        else:
            new_end = host[1]
            new_start = max(host[0], new_end - SEGMENT_LENGTH_SEC)

    if not trim_only and new_end - new_start < MIN_SEGMENT_LENGTH_SEC:
        # Grow inside the host interval — forward first, the same bias
        # _enforce_segment_bounds uses.
        want = MIN_SEGMENT_LENGTH_SEC - (new_end - new_start)
        grow_fwd = min(want, host[1] - new_end)
        new_end += grow_fwd
        want -= grow_fwd
        new_start = max(host[0], new_start - want)

    if new_end - new_start < _MIN_SALVAGE_SEC:
        if trim_only:
            log.info(
                "dropping segment %s-%s: mostly advertisement", start, end,
            )
            return False
        # Last resort: the longest ad-free stretch anywhere in the video.
        best = max(clean, key=lambda c: c[1] - c[0])
        if best[1] - best[0] < _MIN_SALVAGE_SEC:
            log.warning("no ad-free interval long enough; keeping %s-%s", start, end)
            return True
        new_start = best[0]
        new_end = min(best[1], new_start + SEGMENT_LENGTH_SEC)

    if (new_start, new_end) != (start, end):
        log.info(
            "segment %s-%s overlapped an ad → %s-%s", start, end, new_start, new_end,
        )
        seg["start"], seg["end"] = new_start, new_end
        seg["ad_adjusted"] = True
    return True


def _enforce_segment_bounds(seg: dict, full_duration: int) -> dict:
    """Clamp seg["start"]/["end"] into [MIN, MAX] seconds. Mutates seg."""
    start = max(0, int(seg.get("start", 0)))
    end = max(start, int(seg.get("end", start + SEGMENT_LENGTH_SEC)))
    cur = end - start
    if cur > MAX_SEGMENT_LENGTH_SEC:
        end = start + MAX_SEGMENT_LENGTH_SEC
    elif cur < MIN_SEGMENT_LENGTH_SEC:
        deficit = MIN_SEGMENT_LENGTH_SEC - cur
        # Extend 1/3 backward (open-ended chats often drift back to start
        # of thought) and 2/3 forward (more "fresh" speech ahead).
        extend_back = min(deficit // 3, start)
        extend_fwd = deficit - extend_back
        start = max(0, start - extend_back)
        end = end + extend_fwd
        if full_duration:
            end = min(end, full_duration)
            # Re-extend back if we hit the right wall.
            still_short = MIN_SEGMENT_LENGTH_SEC - (end - start)
            if still_short > 0:
                start = max(0, start - still_short)
    seg["start"] = start
    seg["end"] = end
    return seg

log = logging.getLogger("pipeline")

MEDIA_DIR = Path(__file__).resolve().parents[2] / "media"
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

# VTT raw text (200KB+ for 1h video) is too large for the JSON column
# task.selected_segment, but phase 2 needs it to run the hybrid sentence
# splitter on each approved multi-segment. Stash on disk keyed by task id;
# admin import-delete also wipes the file.
VTT_CACHE_DIR = MEDIA_DIR / "vtt-cache"
VTT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Local thumbnails for the home/catalog cards.  YouTube's i.ytimg.com
# CDN is GFW-blocked for mainland CN users, so episode cards rendered
# straight from the YouTube URL come up blank.  Pipeline copies the
# maxres jpg here once at import time; Episode.thumbnail_url is then
# stored as a relative /media/thumbs/<id>.jpg path.  EpisodeCard's
# field validator prepends settings.media_base_url at serialization
# so it goes out the media bypass subdomain (DNS-only, direct Tokyo).
THUMBS_DIR = MEDIA_DIR / "thumbs"
THUMBS_DIR.mkdir(parents=True, exist_ok=True)


def _caps_cache_paths(task_id: int) -> list[Path]:
    """Cache file, newest naming first. The `.vtt` name is still read so
    tasks captured before the json3 switch stay resumable; only `.caps`
    is ever written now, because the contents may be either format."""
    return [VTT_CACHE_DIR / f"{task_id}.caps", VTT_CACHE_DIR / f"{task_id}.vtt"]


def _persist_vtt_for_task(task_id: int, raw_caps: str) -> None:
    if not raw_caps:
        return
    try:
        _caps_cache_paths(task_id)[0].write_text(raw_caps, encoding="utf-8")
    except OSError as e:
        log.warning("failed to persist caption cache for task %d: %s", task_id, e)


def _load_vtt_for_task(task_id: int) -> str:
    for p in _caps_cache_paths(task_id):
        if not p.exists():
            continue
        try:
            return p.read_text(encoding="utf-8")
        except OSError as e:
            log.warning("failed to read caption cache for task %d: %s", task_id, e)
    return ""


def cleanup_vtt_for_task(task_id: int) -> None:
    """Called from admin.py when an import_task is deleted."""
    for p in _caps_cache_paths(task_id):
        if p.exists():
            try:
                p.unlink()
            except OSError as e:
                log.warning("failed to delete caption cache for task %d: %s", task_id, e)

# YouTube bot-challenges DC IPs with "Sign in to confirm you're not a bot".
# Workaround: pass a cookies.txt exported from a logged-in browser session.
# Path is overridable via env; default matches the k8s secret mount point.
YT_COOKIES_PATH = os.getenv("YT_COOKIES_PATH", "/app/secrets/yt-cookies.txt")
# yt-dlp opens cookiefile read/write so it can persist refreshed session
# tokens between calls. K8s Secret mounts are read-only tmpfs, so we copy
# the cookies to a writable path under /tmp on first use (and on rotate —
# checked via mtime). Returns None when the source is absent so local dev
# runs unchanged.
_YT_COOKIES_WRITABLE = "/tmp/yt-cookies.txt"


def _yt_cookiefile() -> str | None:
    src = YT_COOKIES_PATH
    if not os.path.exists(src):
        return None
    dst = _YT_COOKIES_WRITABLE
    if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
        shutil.copy2(src, dst)
    return dst


CANNED_SUBS = [
    (0, 4000, "So the question everybody keeps asking me is: are developers gonna be out of a job in five years?",
     "所以大家一直在问我：五年后开发者是不是就没工作了？"),
    (4000, 8000, "And my honest answer is, it depends on what kind of developer you are.",
     "我的真实回答是，这取决于你是哪种开发者。"),
    (8000, 13000, "If your whole job is knocking out CRUD endpoints from a spec, yeah, I think you'll end up doing a lot less of that.",
     "如果你的全部工作就是按文档敲 CRUD 接口，你会越来越少做这种事。"),
    (13000, 19000, "But the way I see it, real engineering is sort of like taste. It's knowing what not to build.",
     "但在我看来，真正的工程更像是品味——是知道什么东西不该做。"),
    (19000, 24000, "A junior engineer will build the thing you asked for. A senior engineer will go, wait a sec, should we even be building this?",
     "初级工程师会直接做你要的东西，而资深工程师会停下来问：我们真的应该做这个吗？"),
    (24000, 29000, "And that question, the way I see it, is still really hard for a model to ask.",
     "在我看来，这个问题对模型来说还是很难主动提出的。"),
    (29000, 33000, "Lex: that's kind of like saying it's about judgment, not output.",
     "Lex：你这话差不多就是说——重要的是判断力，而不是产出。"),
    (33000, 38000, "Exactly. And judgment comes from a decade of seeing things blow up in your face.",
     "没错。判断力是你被各种事情炸脸炸了十年才攒出来的。"),
]


# ============ Stage 1: yt-dlp download ============
def _parse_youtube_timestamp(url: str) -> int:
    """Extract the `t=` query param (seconds) from a YouTube URL. 0 if missing."""
    try:
        q = parse_qs(urlparse(url).query)
        t = q.get("t", ["0"])[0]
        m = re.match(r"^(?:(\d+)h)?(?:(\d+)m)?(\d+)s?$", t) or re.match(r"^(\d+)$", t)
        if not m:
            return 0
        groups = m.groups() if len(m.groups()) > 1 else (None, None, m.group(1))
        h = int(groups[0] or 0)
        mn = int(groups[1] or 0)
        s = int(groups[2] or 0)
        return h * 3600 + mn * 60 + s
    except Exception:
        return 0


def _vtt_ts_to_ms(ts: str) -> int:
    """'HH:MM:SS.mmm' or 'MM:SS.mmm' → milliseconds."""
    parts = ts.strip().split(":")
    h, m, s = 0, 0, 0.0
    if len(parts) == 3:
        h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
    elif len(parts) == 2:
        m, s = int(parts[0]), float(parts[1])
    return int((h * 3600 + m * 60 + s) * 1000)


# ---------- caption formats: json3 (preferred) → VTT (fallback) ----------
#
# YouTube serves the same auto-caption track in several formats. We ask for
# json3, because it is the only one that survives a round-trip without
# guesswork:
#
#   VTT   — the rolling-window format. Each cue repeats the tail of the
#           previous one, per-word timings live in inline <ts> tags that are
#           MISSING on the "one new word" cues, and a speaker change is a
#           bare ">>" glued into the text. Rebuilding sentences from it takes
#           three layers of heuristics and still lost 92 of 11372 words on a
#           62-minute podcast (measured on QXMkkAcWask) — every one of them
#           sentence-final, which is exactly why clips looked like they
#           started and ended mid-sentence.
#   json3 — one event per caption line; every word carries an explicit
#           tOffsetMs; the scroll repeats are isolated in `aAppend` events
#           whose only content is "\n"; and a speaker change is a real
#           `isSpeakerChange` flag on the segment that opens the new turn.
#
# The VTT parser below is kept for tracks that offer no json3 (manually
# uploaded subtitle files) and for import tasks whose captions were cached
# before this change.
_SPEAKER_MARK_RE = re.compile(r">>+\s*")
# How many previous cues the untagged-cue branch of _extract_word_timings
# checks before accepting a line as new. YouTube's rolling window shows the
# same line across ~3 cues; 12 is comfortably past that without reaching so
# far back that a genuinely repeated short line ("Yeah.") gets swallowed.
_VTT_DEDUP_WINDOW = 12


def _norm_cue_text(line: str) -> str:
    """A cue line reduced to comparable plain text: tags out, entities
    decoded, speaker markers dropped, whitespace collapsed.

    Both branches of _extract_word_timings record what they emitted in this
    form. Storing the raw tagged text instead does not work — a tagged line
    never compares equal to the untagged copy the next cue shows, so every
    line ends up counted twice."""
    line = re.sub(r"<[^>]*>", "", line)
    line = html.unescape(line)
    line = _SPEAKER_MARK_RE.sub("", line)
    return re.sub(r"\s+", " ", line).strip()


def _is_json3(raw: str) -> bool:
    """Cheap format sniff — json3 is a JSON object, VTT never starts with {."""
    return raw.lstrip()[:1] == "{"


def _parse_json3(
    raw: str,
) -> tuple[list[tuple[int, int, str, str]], list[tuple[str, int]], list[int]]:
    """Parse a YouTube json3 caption track.

    Returns (cue_rows, word_times, turn_starts_ms):
      cue_rows       [(start_ms, end_ms, text_en, text_zh)] — one row per
                     caption line with ">>" markers removed. Same shape as
                     _parse_vtt(), so callers are interchangeable.
      word_times     [(word, abs_start_ms)] — for karaoke highlighting and
                     sentence splitting. Same shape as _extract_word_timings().
      turn_starts_ms absolute times where a new speaker takes over.

    Malformed input degrades to three empty lists; the caller then falls
    back to VTT or Whisper rather than importing an episode with no subs.
    """
    try:
        doc = json.loads(raw)
    except Exception as e:
        log.warning("json3 parse failed: %s", e)
        return [], [], []

    rows: list[tuple[int, int, str, str]] = []
    words: list[tuple[str, int]] = []
    turns: list[int] = []
    for ev in doc.get("events") or []:
        segs = ev.get("segs") or []
        if not segs:
            continue  # header event (window/style definitions), no text
        base = int(ev.get("tStartMs") or 0)
        line: list[str] = []
        for s in segs:
            txt = s.get("utf8") or ""
            if not txt.strip():
                continue  # the "\n" scroll fillers carried by aAppend events
            t = base + int(s.get("tOffsetMs") or 0)
            if s.get("isSpeakerChange"):
                turns.append(t)
            for w in txt.split():
                w = _SPEAKER_MARK_RE.sub("", w)
                if not w:
                    continue  # the ">>" token itself — the flag already has it
                words.append((w, t))
                line.append(w)
        if not line:
            continue
        rows.append((base, base + int(ev.get("dDurationMs") or 0), " ".join(line), ""))

    # A scrolling track gives each line a duration that runs into the next
    # one; clamp so display rows don't stack on top of each other.
    for i in range(len(rows) - 1):
        s, e, text, zh = rows[i]
        rows[i] = (s, min(e, rows[i + 1][0]), text, zh)

    words.sort(key=lambda wt: wt[1])
    turns.sort()
    return rows, words, turns


def _parse_captions(raw: str) -> list[tuple[int, int, str, str]]:
    """Cue rows from whichever caption format we were handed."""
    if not raw:
        return []
    return _parse_json3(raw)[0] if _is_json3(raw) else _parse_vtt(raw)


def _caption_word_timings(raw: str) -> tuple[list[tuple[str, int]], list[int]]:
    """(word_times, turn_starts_ms) from whichever caption format we have.

    On the VTT path the turn starts are recovered from the ">>" tokens that
    _extract_word_timings deliberately keeps: they are the only speaker
    signal that format carries, and dropping them at parse time is what
    used to leave two people's speech merged into one subtitle row.
    """
    if not raw:
        return [], []
    if _is_json3(raw):
        _rows, words, turns = _parse_json3(raw)
        return words, turns
    tagged = _extract_word_timings(raw)
    turns = [t for (w, t) in tagged if w == ">>"]
    return [(w, t) for (w, t) in tagged if w != ">>"], turns


def _extract_word_timings(raw: str) -> list[tuple[str, int]]:
    """Parse YouTube VTT <c>-tagged lines into a flat [(word, start_ms), ...].

    Each cue's word-timing line looks like::

        But<00:01:16.000><c> since</c><00:01:16.240><c> December</c>...

    - The first word ('But' here) starts at the cue start_ms.
    - Each subsequent word starts at the <timestamp> that precedes it.

    Returned word times are ABSOLUTE (source-video times, in ms) and are
    deduplicated across cues because YouTube's rolling-window repeats each
    word across ~3 cues — the dedup keeps the earliest-seen time.

    Speaker changes are emitted as their own ">>" token so the turn survives
    parsing; _caption_word_timings() splits them back out. See the note above
    _parse_json3 for why this format needs so much care — prefer json3 when
    the track offers it."""
    out: list[tuple[str, int]] = []
    seen: dict[tuple[int, str], bool] = {}
    # Normalised text of the last few cues, for the untagged-cue branch below.
    recent: list[str] = []

    def _add(word: str, t_ms: int):
        word = word.strip()
        if not word:
            return
        key = (t_ms, word)
        if key in seen:
            return
        seen[key] = True
        out.append((word, t_ms))

    ts_pat = re.compile(r"<(\d{2}:\d{2}:\d{2}\.\d{3})>")
    for block in re.split(r"\n\s*\n", raw):
        lines = [l for l in block.splitlines() if l.strip()]
        ts_line = next((l for l in lines if "-->" in l), None)
        if not ts_line:
            continue
        try:
            cue_start_ms = _vtt_ts_to_ms(ts_line.split("-->")[0].split()[-1])
        except Exception:
            continue
        body = [l for l in lines if "-->" not in l and not l.strip().isdigit()]
        # pick the line carrying word-timing tags
        text_lines = [l for l in body if "<" in l]
        if not text_lines:
            # A cue with no inline timestamps at all. YouTube emits one every
            # time the rolling window advances by a single word: the new word
            # sits alone on the LAST line with no <ts> tag of its own. The old
            # code dropped the whole cue, which cost 87 sentence-final words
            # on a 35-minute video (ep48) — and since sentence boundaries are
            # detected from ".!?" on those very words, it also destroyed the
            # boundary table the segment snapper runs on.
            if not body:
                continue
            tail = _norm_cue_text(body[-1])
            if not tail or tail in recent:
                continue
            for w in tail.split():
                _add(w, cue_start_ms)
            recent.append(tail)
            del recent[:-_VTT_DEDUP_WINDOW]
            continue
        line = " ".join(text_lines)
        # Strip all decorative tags (<c>, </c>, <b>, </b>, <i>, </i>,
        # <v Speaker>, etc.) but PRESERVE the inline timestamp tags
        # <HH:MM:SS.mmm> which we split on below to recover word timings.
        # Old code only stripped <c> tags, so bold/italic markers from
        # manually-uploaded VTTs leaked into the word list as fake "words"
        # like "<b>" or "since</b>", which then surfaced verbatim in the
        # rendered subtitles ("This right</b> <b>here is where..."). The
        # tag we keep starts with a digit; any letter-prefixed tag is
        # decorative and goes.
        line = re.sub(r"</?[a-zA-Z][^>]*>", "", line)
        line = html.unescape(line)
        # Speaker markers arrive as "&gt;&gt;" and only become ">>" after the
        # unescape above — hence the ordering. Space them out so they tokenise
        # on their own instead of gluing onto the next word (">>Well,").
        line = _SPEAKER_MARK_RE.sub(" >> ", line)
        recent.append(_norm_cue_text(line))
        del recent[:-_VTT_DEDUP_WINDOW]
        # Split on the <HH:MM:SS.mmm> timestamps; text before the first
        # timestamp belongs to cue_start_ms, text between timestamps[i]
        # and timestamps[i+1] starts at timestamps[i].
        parts = ts_pat.split(line)
        # parts = [text0, ts1, text1, ts2, text2, ...]
        for w in parts[0].split():
            _add(w, cue_start_ms)
        i = 1
        while i + 1 < len(parts):
            ts_ms = _vtt_ts_to_ms(parts[i])
            for w in parts[i + 1].split():
                _add(w, ts_ms)
            i += 2

    out.sort(key=lambda wt: wt[1])
    return out


def _sentence_boundaries_ms(
    word_timings: list[tuple[str, int]],
    turn_starts_ms: Iterable[int] = (),
) -> list[int]:
    """Return sorted timestamps (ms) where a new sentence begins in the
    word-timed transcript. A boundary = the start of any word whose
    predecessor token ends in .!?, plus the very first word, plus every
    speaker change.

    Speaker changes count because ".!?" alone is not enough on interview
    content: YouTube's ASR routinely runs a question and its answer together
    with no punctuation between them, and the start of a new turn is both a
    real boundary and the single best place to open a clip.

    Used by _snap_segment_to_sentence; lives next to _extract_word_timings
    because it consumes the same shape."""
    if not word_timings:
        return []
    bounds = [word_timings[0][1]]
    for i in range(1, len(word_timings)):
        prev = word_timings[i - 1][0]
        if prev and prev[-1] in ".!?":
            bounds.append(word_timings[i][1])
    bounds.extend(t for t in turn_starts_ms)
    return sorted(set(bounds))


def _record_boundary(seg: dict, boundary_ms: int) -> None:
    """Remember the exact ms a snap aimed at, so the subtitle window can be
    tighter than the clip.

    Clip bounds are whole seconds all the way down to yt-dlp, and flooring a
    boundary of, say, 3680ms to 3s pulls the previous speaker's last word into
    the audio. Nothing can be done about that at second granularity — but the
    SUBTITLE rows can start at the real boundary, so the learner doesn't get a
    row reading "that." before the clip's actual first sentence."""
    seg["start_boundary_ms"] = int(boundary_ms)


def _snap_segment_to_sentence(
    seg: dict,
    boundaries_ms: list[int],
    full_duration_sec: int,
    max_drift_sec: float = 15.0,
) -> None:
    """Nudge seg['start'] to the nearest sentence boundary within
    ±max_drift_sec, preserving the AI-chosen segment LENGTH by shifting
    seg['end'] by the same delta. Mutates seg in-place; no-op when
    boundaries_ms is empty or no boundary lies inside the drift window.

    Why preserve length: _enforce_segment_bounds extends short segments
    by 1/3 backward + 2/3 forward, which would un-do a forward snap by
    pulling start back through the boundary we just aligned to. Keeping
    length unchanged means _enforce_segment_bounds is a no-op on segments
    the LLM already sized correctly.

    Why ±15s: matches the admin UI's manual ±15s nudge buttons. Snaps
    larger than that would change the clip's content meaningfully — beyond
    just fixing a boundary — and shouldn't happen automatically."""
    if not boundaries_ms:
        return
    start_ms = int(seg.get("start", 0)) * 1000
    drift_ms = int(max_drift_sec * 1000)
    nearest = min(boundaries_ms, key=lambda b: abs(b - start_ms))
    if abs(nearest - start_ms) > drift_ms:
        return
    delta_ms = nearest - start_ms
    new_start = max(0, nearest // 1000)
    new_end = (int(seg.get("end", 0)) * 1000 + delta_ms) // 1000
    if new_end <= new_start:
        return  # defensive: refuse to invert the segment
    if full_duration_sec:
        new_end = min(new_end, full_duration_sec)
    seg["start"] = new_start
    seg["end"] = new_end
    _record_boundary(seg, nearest)


def _extend_segment_end_to_sentence(
    seg: dict,
    boundaries_ms: list[int],
    full_duration_sec: int,
    max_extend_sec: float = 8.0,
) -> None:
    """If seg['end'] lands inside a sentence, push it FORWARD to the next
    sentence boundary, capped at +max_extend_sec. No-op when end is already
    on a boundary, when no boundary lies in the look-ahead window, or when
    extending would overflow the source video.

    Why this exists: the AI segment selector chooses end_ms purely from
    transcript content, with no awareness of where words actually end.
    A clean cut at the AI's preferred end_ms can chop off the speaker's
    trailing 3-5s of a thought ("...so I can test this out" was missing
    in observed clips because end_ms hit before "test this out"). Snapping
    end forward to the next .!? guarantees the clip ends on a complete
    sentence whenever one is available within the look-ahead window;
    SEGMENT_END_PADDING_SEC is the backstop when it isn't.

    Why +8s and not unbounded: a sentence boundary further than 8s past
    the AI's choice usually means a paragraph break or topic shift, and
    pulling that in changes the clip's content rather than fixing it.
    Matches the admin's manual ±15s control's lower-end cadence.

    Symmetric counterpart to _snap_segment_to_sentence which aligns START.
    Both are independent: snap-start happens BEFORE extend-end so the
    end is measured against the post-snap position."""
    if not boundaries_ms:
        return
    end_ms = int(seg.get("end", 0)) * 1000
    look_ahead_ms = int(max_extend_sec * 1000)
    # Pick the smallest boundary strictly greater than end_ms but within window.
    candidates = [b for b in boundaries_ms if b > end_ms and b - end_ms <= look_ahead_ms]
    if not candidates:
        return
    new_end_ms = min(candidates)
    new_end_sec = new_end_ms // 1000
    if full_duration_sec:
        new_end_sec = min(new_end_sec, full_duration_sec)
    if new_end_sec <= int(seg.get("end", 0)):
        return  # defensive: nothing to do
    seg["end"] = new_end_sec


def _pull_segment_start_to_boundary(
    seg: dict,
    boundaries_ms: list[int],
    max_pull_sec: float = 8.0,
) -> None:
    """Move seg['start'] FORWARD to the next sentence/turn boundary within
    max_pull_sec, leaving seg['end'] alone. Mutates in place.

    The forward-only direction is the whole point: this runs after
    _enforce_segment_bounds has padded the window out to the minimum length,
    and moving the start backward again is exactly what put it mid-sentence.
    Shortening the clip by a few seconds is the cheaper trade — a learner
    notices a clip that opens on half a word long before they notice it is
    114 seconds instead of 120.

    Capped at 8s for the same reason as _extend_segment_end_to_sentence:
    a boundary further out is a different thought, not a cleaner edge."""
    if not boundaries_ms:
        return
    start_ms = int(seg.get("start", 0)) * 1000
    end_sec = int(seg.get("end", 0))
    window_ms = int(max_pull_sec * 1000)
    # Segment bounds are whole seconds, boundaries are ms — anything landing
    # inside the same second is already aligned and must not be nudged on.
    # Re-record it anyway: bounds enforcement may have moved `start` since the
    # first snap, which leaves the stored boundary stale (and _process_segment
    # then discards it as out of range, losing the sub-second precision).
    aligned = next((b for b in boundaries_ms if start_ms <= b < start_ms + 1000), None)
    if aligned is not None:
        _record_boundary(seg, aligned)
        return
    candidates = [b for b in boundaries_ms if start_ms < b <= start_ms + window_ms]
    if not candidates:
        return
    boundary = min(candidates)
    new_start = boundary // 1000
    if new_start >= end_sec:
        return  # defensive: never invert or empty the segment
    seg["start"] = new_start
    _record_boundary(seg, boundary)


def _word_timings_for_row(
    all_word_times: list[tuple[str, int]],
    text_en: str,
    row_start_ms: int,
    row_end_ms: int,
    offset_ms: int,
) -> list[list]:
    """Pick words falling inside [row_start_ms, row_end_ms) and rebase.

    `all_word_times` holds absolute timestamps.  `offset_ms` is the clip's
    seg_start_ms; the returned timestamps are relative to clip t=0 so they
    line up with the <video> element's currentTime.

    Returns [[word, start_ms], ...] ordered by time.  Strips any leading
    punctuation that wouldn't match the text_en tokenisation."""
    abs_start = row_start_ms + offset_ms
    abs_end = row_end_ms + offset_ms
    picked = [(w, t - offset_ms) for (w, t) in all_word_times
              if abs_start <= t < abs_end]
    return [[w, t] for (w, t) in picked]


def _parse_vtt(raw: str) -> list[tuple[int, int, str, str]]:
    """Parse a WebVTT string into our subtitle row format.

    YouTube auto-captions use a rolling-window pattern where each cue
    extends the previous by a few words:
        Cue 1 (0:00-0:02): "Hello how are"
        Cue 2 (0:00-0:04): "Hello how are you today"
        Cue 3 (0:02-0:04): "you today"
    The dedup phase handles exact matches, prefix-extends, and tail
    fragments to collapse these into one clean row.
    """
    rows: list[tuple[int, int, str, str]] = []
    for block in re.split(r"\n\s*\n", raw):
        lines = [l for l in block.splitlines() if l.strip()]
        ts_line = next((l for l in lines if "-->" in l), None)
        if not ts_line:
            continue
        try:
            left, right = ts_line.split("-->", 1)
            start_ms = _vtt_ts_to_ms(left.split()[0])
            end_ms = _vtt_ts_to_ms(right.split()[0])
        except Exception:
            continue
        text_parts = [l for l in lines if "-->" not in l and not l.strip().isdigit()]
        # YouTube rolling-window VTT: each cue has TWO text lines —
        # line 1 = previous context (no word-timing <c> tags)
        # line 2 = new words being spoken NOW (has <c> tags)
        # Including both lines puts future speech into the current subtitle,
        # so the displayed text runs ahead of the audio.  Use only the
        # tagged line(s) when present; fall back to all lines for plain VTTs.
        if len(text_parts) > 1:
            tagged = [l for l in text_parts if "<" in l]
            if tagged:
                text_parts = tagged
        text = " ".join(text_parts)
        text = re.sub(r"<[^>]+>", "", text)
        text = html.unescape(text)
        # Strip YouTube speaker-change markers (">> "). After unescaping
        # they appear as literal ">>" which is never real speech content.
        text = re.sub(r">>\s*", "", text)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            rows.append((start_ms, end_ms, text, ""))

    dedup: list[tuple[int, int, str, str]] = []
    for r in rows:
        text = r[2]
        if not dedup:
            dedup.append(r)
            continue
        prev = dedup[-1]
        prev_text = prev[2]

        if text == prev_text:
            dedup[-1] = (prev[0], r[1], prev_text, prev[3])
            continue
        # Current extends previous: "Hello how are" → "Hello how are you"
        if text.startswith(prev_text):
            dedup[-1] = (prev[0], r[1], text, prev[3])
            continue
        # Current is a prefix of previous: skip
        if prev_text.startswith(text):
            dedup[-1] = (prev[0], max(prev[1], r[1]), prev_text, prev[3])
            continue
        # Tail fragment: "you today" is the end of "Hello how are you today"
        if len(text) > 3 and prev_text.endswith(text):
            dedup[-1] = (prev[0], max(prev[1], r[1]), prev_text, prev[3])
            continue
        # Rolling-window overlap: "A B C" → "B C D"
        # YouTube auto-captions scroll by repeating the tail of the
        # previous cue at the head of the next.  Strip the repeated
        # prefix so each word appears in exactly one subtitle row.
        prev_words = prev_text.split()
        curr_words = text.split()
        overlap_k = 0
        for k in range(min(len(prev_words), len(curr_words)), 0, -1):
            if prev_words[-k:] == curr_words[:k]:
                overlap_k = k
                break
        if overlap_k:
            new_words = curr_words[overlap_k:]
            if not new_words:
                # Entire current is overlap — extend time only
                dedup[-1] = (prev[0], max(prev[1], r[1]), prev_text, prev[3])
            else:
                new_text = " ".join(new_words)
                # Always start a new row; never merge here.
                # Sentence-fragment merging happens in _merge_sentence_fragments
                # AFTER segment filtering, where we know cues don't straddle
                # the clip boundary.
                dedup.append((prev[1], r[1], new_text, r[3]))
            continue
        dedup.append(r)
    return dedup


_MAX_WORDS_PER_ROW = 30          # triggers the safety-valve split
_MIN_SPLIT_PRE_WORDS = 10         # don't strand a tiny pre-split row
_MAX_UNPUNCTUATED_TAIL = 20       # longest clip-cut tail we're willing to drop
_TAIL_CUT_TOLERANCE_MS = 2000     # "still talking when the clip ended" window
_SENTENCE_END_RE = re.compile(r'[.!?]+[\"”)\]]*$')
# Words that make a reasonable clause-break point when there are no commas
# in a long run-on sentence. Order matters — we try these in priority.
_SOFT_BREAK_CONJUNCTIONS = ("because", "where", "which", "that", "but", "and", "so")


def _ends_sentence(word: str) -> bool:
    """True when a word token ends in sentence-final punctuation."""
    return bool(_SENTENCE_END_RE.search(word))


def _find_split_index(buf: list[tuple[str, int]]) -> int:
    """Choose where to break an over-long buffer.  Returns index into buf
    such that buf[:idx+1] is the pre-split row and buf[idx+1:] continues.

    Priority:
      1. Most recent comma where the pre-split row has ≥ _MIN_SPLIT_PRE_WORDS.
      2. Most recent soft-break conjunction at the same word-count threshold
         (break BEFORE the conjunction, i.e. idx = conjunction_pos - 1, so
         the conjunction starts the next row: '...speech. || where it has...').
      3. Fallback: last index meeting the word-count threshold.
    """
    # Scan backwards from second-to-last position so post-split has >= 1 word.
    # (1) Commas first.
    for j in range(len(buf) - 2, _MIN_SPLIT_PRE_WORDS - 1, -1):
        if buf[j][0].endswith(","):
            return j
    # (2) Soft-break conjunctions. Break before them so they lead the next row.
    for j in range(len(buf) - 2, _MIN_SPLIT_PRE_WORDS, -1):
        if buf[j][0].strip(",.;:").lower() in _SOFT_BREAK_CONJUNCTIONS:
            return j - 1  # split BEFORE conjunction
    # (3) Hard split at the threshold (never produces a sub-10-word pre).
    return max(_MIN_SPLIT_PRE_WORDS, len(buf) - 1)


def _split_into_sentences(
    word_times: list[tuple[str, int]],
    clip_end_ms: int,
    turn_starts_ms: Iterable[int] = (),
) -> list[tuple[int, int, str, list[list]]]:
    """Group word timings into sentence-level rows.

    Returns list of (start_ms, end_ms, text_en, word_timings) where:
    - start_ms / end_ms are relative to clip t=0 (already rebased by caller)
    - text_en is the joined sentence
    - word_timings is [[word, start_ms], ...] for per-phrase highlighting

    Primary rule: emit a row every time a word ends in .!?.
    Speaker rule: also emit when a new speaker takes over, even mid-sentence.
    Without it an unpunctuated hand-off merges both people into one row —
    "Was that more of an inbound or was it Every single one of my work
    opportunities is now inbound." was two speakers and read as nonsense.
    turn_starts_ms must be rebased to clip t=0 by the caller, like word_times.
    Over-long rule: if we accumulate > _MAX_WORDS_PER_ROW with no sentence
    end in sight, break via _find_split_index (comma > conjunction > hard).

    Short-trailer absorption: if the FINAL row is under 4 words and the
    sentence clearly didn't end cleanly, glue it to the previous row so we
    don't emit a dangling "Something" or "And this..." as its own line.
    """
    out: list[tuple[int, int, str, list[list]]] = []
    buf: list[tuple[str, int]] = []
    buf_start: int | None = None
    turns = set(turn_starts_ms)
    # A hand-off fires once, on the first word carrying its timestamp. Several
    # words routinely share one timestamp (a VTT cue's pre-tag text, a json3
    # segment holding ">> So, it's"), and firing per word would strand each of
    # them on its own line.
    fired_turns: set[int] = set()

    def flush(end_ms: int):
        nonlocal buf, buf_start
        if not buf:
            return
        text = " ".join(w for w, _ in buf)
        wt = [[w, t] for (w, t) in buf]
        out.append((buf_start if buf_start is not None else buf[0][1], end_ms, text, wt))
        buf = []
        buf_start = None

    for i, (w, t) in enumerate(word_times):
        # New speaker: close whatever the previous one left open first.
        if t in turns and t not in fired_turns:
            fired_turns.add(t)
            if buf:
                flush(t)
        if buf_start is None:
            buf_start = t
        buf.append((w, t))

        if _ends_sentence(w):
            next_t = word_times[i + 1][1] if i + 1 < len(word_times) else min(t + 400, clip_end_ms)
            flush(next_t)
        elif len(buf) > _MAX_WORDS_PER_ROW:
            split_j = _find_split_index(buf)
            pre_words = buf[: split_j + 1]
            post_words = buf[split_j + 1:]
            if not post_words:
                continue  # degenerate — keep accumulating
            pre_text = " ".join(w for w, _ in pre_words)
            pre_wt = [[w, tt] for (w, tt) in pre_words]
            pre_end = post_words[0][1]
            out.append((buf_start, pre_end, pre_text, pre_wt))
            buf = post_words
            buf_start = post_words[0][1]

    # Trailing buffer: whatever is left after the last .!? is, on a clip cut
    # out of a longer video, the sentence the clip boundary chopped in half.
    # Showing it is what produces the dangling last row a reader trips on
    # ("Like, it's it takes time, it takes work, but you can"), so drop it —
    # the same trade the head makes in _record_boundary, a second or two of
    # audio with no row beats a row that isn't a sentence.
    #
    # What tells the two apart is where the leftover STOPS: a sentence the
    # boundary cut runs right up against the clip end, while a real sentence
    # that YouTube's ASR just never punctuated finishes somewhere in the
    # middle and is followed by more speech. Length alone can't distinguish
    # them, so it only serves as a cap on how much we're willing to drop.
    if buf:
        cut_by_clip_end = buf[-1][1] >= clip_end_ms - _TAIL_CUT_TOLERANCE_MS
        droppable = (
            out
            and cut_by_clip_end
            and len(buf) <= _MAX_UNPUNCTUATED_TAIL
            and not _ends_sentence(buf[-1][0])
        )
        if not droppable:
            flush(min(buf[-1][1] + 400, clip_end_ms))

    return out


def _merge_yt_cues_into_sentences(
    cues: list[tuple[int, int, str]],
) -> list[tuple[int, int, str, list]]:
    """Group plain VTT cues (start_ms, end_ms, text) into sentence-level
    rows by accumulating text until we hit .!? and emitting.

    Returns rows shaped like _split_into_sentences() so callers can mix
    them transparently — but the word_timings list is always [] because
    plain cues don't carry per-word timestamps.

    This is the fallback path for clips whose source VTT lost <c> tags
    partway through (see _hybrid_subtitle_split below)."""
    rows: list[tuple[int, int, str, list]] = []
    buf_text: list[str] = []
    buf_start: int | None = None
    last_end: int = 0
    for (s, e, text) in cues:
        text = text.strip()
        if not text:
            continue
        if buf_start is None:
            buf_start = s
        buf_text.append(text)
        last_end = e
        # Flush at sentence end so each row is one natural unit, just
        # like the word-timing path.
        if _SENTENCE_END_RE.search(text):
            joined = " ".join(buf_text).strip()
            rows.append((buf_start, e, joined, []))
            buf_text = []
            buf_start = None
    if buf_text:
        joined = " ".join(buf_text).strip()
        rows.append((buf_start if buf_start is not None else last_end,
                     last_end, joined, []))
    return rows


def _hybrid_subtitle_split(
    word_times: list[tuple[str, int]],   # already clip-relative
    yt_cues_clip: list[tuple[int, int, str]],  # already clip-relative
    clip_end_ms: int,
    coverage_threshold: float = 0.85,
    turn_starts_ms: Iterable[int] = (),  # already clip-relative
) -> tuple[list[tuple[int, int, str, list]], float]:
    """Combine the two subtitle sources so every clip is fully covered.

    Strategy:
      1. Run sentence-split on word_times → primary rows (high quality:
         per-word timing, clean sentence boundaries).
      2. Compute how far primary covers; if it's at least coverage_threshold
         of the clip, return primary as-is.
      3. Otherwise, take yt_cues that start AFTER primary's last end_ms
         and merge them into sentences — these are the "tail rows" that
         fill the uncovered remainder.  They lack word_timings but do
         match the audio.
      4. Concatenate primary + tail and return.

    The yt_cues list must already be filtered to the clip window AND
    rebased to clip t=0 (so start_ms = 0 means audio start).

    Returns (rows, coverage_ratio).  Caller can log/warn on low coverage."""
    primary = _split_into_sentences(word_times, clip_end_ms, turn_starts_ms)
    primary_end_ms = primary[-1][1] if primary else 0
    coverage = (primary_end_ms / clip_end_ms) if clip_end_ms > 0 else 0.0

    if coverage >= coverage_threshold or not yt_cues_clip:
        return primary, coverage

    # Pad the boundary by 500ms so we don't drop a cue that overlaps the
    # last primary sentence by a hair.
    boundary_ms = max(0, primary_end_ms - 500)
    tail_cues = [c for c in yt_cues_clip if c[0] >= boundary_ms]
    if not tail_cues:
        return primary, coverage

    tail_rows = _merge_yt_cues_into_sentences(tail_cues)
    return primary + tail_rows, coverage


def _extract_subs_from_info(
    info: dict,
) -> tuple[list[tuple[int, int, str, str]], str]:
    """Pick an English caption track out of a yt-dlp info dict and fetch+parse it.

    Returns (rows, raw_captions).  The raw text is kept so we can later
    extract per-word timestamps for karaoke highlighting — parsing is lossy.

    json3 is requested first and VTT only as a fallback: see the note above
    _parse_json3 for the measurements behind that preference."""
    import urllib.request

    candidates: list[dict] = []
    for key in ("subtitles", "automatic_captions"):
        tracks = info.get(key) or {}
        for lang in ("en", "en-US", "en-GB", "en-orig", "en-auto"):
            if lang in tracks and tracks[lang]:
                candidates = tracks[lang]
                break
        if candidates:
            break
    if not candidates:
        return [], ""

    # Try formats in preference order and keep the first that parses into
    # actual rows — a track can advertise json3 and still hand back
    # something unusable, and silently importing an episode with no
    # subtitles is far worse than spending one more HTTP request here.
    for ext in ("json3", "vtt"):
        track = next((f for f in candidates if f.get("ext") == ext), None)
        url = track.get("url") if track else None
        if not url:
            continue
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                raw = resp.read().decode("utf-8", errors="ignore")
        except Exception as e:
            log.warning("caption fetch failed (%s): %s", ext, e)
            continue
        rows = _parse_captions(raw)
        if rows:
            log.info("captions: %s track, %d rows", ext, len(rows))
            return rows, raw
        log.warning("captions: %s track parsed to 0 rows, trying next format", ext)
    return [], ""


def _try_fetch_metadata_and_captions(url: str) -> dict | None:
    """Fast first pass: pull metadata + YouTube captions, no video download.

    Returns {'title','duration','thumbnail','channel','description','subs'} or None.
    `subs` may be [] if no English track is available — the caller will then
    fall through to Whisper on the downloaded clip.
    """
    try:
        import yt_dlp  # type: ignore
    except ImportError:
        log.info("yt-dlp not installed")
        return None

    try:
        opts = {
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en", "en-US", "en-GB", "en-orig"],
            # We fetch the track ourselves from info["automatic_captions"],
            # so this only nudges yt-dlp's own preference; the actual choice
            # is _extract_subs_from_info's json3-then-vtt walk.
            "subtitlesformat": "json3/vtt",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "retries": 2,
            # Without this, yt-dlp + deno can't fetch the EJS solver script
            # for YouTube's "n signature" challenge, and only storyboard
            # images show up as "available formats".
            "remote_components": {"ejs:github"},
        }
        cookiefile = _yt_cookiefile()
        if cookiefile:
            opts["cookiefile"] = cookiefile
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                return None
            subs, raw_vtt = _extract_subs_from_info(info)
            log.info(
                "metadata: duration=%ss, subs=%d lines (source=%s)",
                info.get("duration"), len(subs),
                "youtube" if subs else "none",
            )
            return {
                "title": info.get("title", "Untitled"),
                "duration": int(info.get("duration") or 0),
                "thumbnail": info.get("thumbnail", "") or "",
                "channel": info.get("channel") or info.get("uploader") or "",
                # Channel-level identifiers — used downstream to get-or-create
                # the Speaker/Creator row so newly imported videos surface in
                # /catalog?creator=… and /creators automatically.
                "channel_id": info.get("channel_id") or "",
                "channel_url": info.get("channel_url") or info.get("uploader_url") or "",
                "uploader_handle": info.get("uploader_id") or "",
                "description": (info.get("description") or "")[:800],
                "subs": subs,
                "vtt_raw": raw_vtt,
            }
    except Exception as e:
        log.warning("metadata/caption fetch failed: %s", e)
        return None


# 600s, not 300s: `download_ranges` makes yt-dlp fetch the slice through
# ffmpeg's HTTP client, which YouTube throttles hard (~80 KiB/s measured from
# the local Mac, vs ~1.4 MB/s for yt-dlp's native downloader on the same
# proxy). A 160s 1080p clip lands at 3-5 min, so a 300s budget was tripping
# on the good path, not just the stuck one.
_YTDLP_ATTEMPT_TIMEOUT_SEC = 600


def _classify_ytdlp_error(err: str) -> str:
    """Turn a raw yt-dlp error string into a Chinese, actionable message
    that an admin can read straight off the import history table.

    Order matters: the first matching keyword wins, so put the more
    specific (cookies / signature / region) ahead of the generic 403."""
    if not err:
        return "下载失败（未知原因，请查看后端日志）"
    e = err.lower()
    # Age check BEFORE the generic bot check — "Sign in to confirm your age"
    # also contains "sign in to confirm" but means something different.
    if "age" in e and ("restrict" in e or "confirm your age" in e):
        return "视频有年龄限制，需要登录账号 cookies。"
    if "sign in to confirm" in e or "not a bot" in e:
        return (
            "YouTube 反机器人触发，cookies 可能过期。"
            "在本机运行 scripts/refresh-yt-cookies.sh 后重试。"
        )
    if "n signature" in e or "nsig" in e or "ejs" in e:
        return (
            "YouTube 签名挑战失败（n-sig）。yt-dlp 可能需要升级，"
            "或 deno/EJS solver 不可用。"
        )
    if "video unavailable" in e or "is private" in e or "private video" in e or "has been removed" in e:
        return "视频无法访问（已删除/设为私密）。"
    if "geo" in e and ("restrict" in e or "block" in e):
        return "视频地区限制，当前出口 IP 无法访问。"
    if "http error 403" in e or "forbidden" in e:
        return "下载被拒（HTTP 403）。可能 cookies 过期或视频受限。"
    if "http error 429" in e or "too many requests" in e:
        return "请求过频被限流（HTTP 429）。等几分钟再试。"
    if "timed out" in e or "timeout" in e or "timed-out" in e:
        return "下载超时。视频较大或网络慢。"
    # ffmpeg does the transfer for ranged downloads; when YouTube throttles
    # to zero and then drops the socket, ffmpeg dies with "End of file"
    # (exit 187) rather than anything resembling a network error.
    if "ffmpeg exited" in e or "end of file" in e:
        return (
            "下载中途被 YouTube 掐断（ffmpeg 报 End of file）。"
            "长视频取片段时常见 —— 直接重试通常就好；反复失败就挂代理。"
        )
    if "unable to extract" in e or "no video formats" in e:
        return "无法解析视频流。yt-dlp 可能需升级。"
    return "下载失败（未识别错误，请查看后端日志）"


# ============ Real download progress ============
# yt-dlp's `progress_hooks` are useless on the segment path: `download_ranges`
# hands the actual transfer to ffmpeg (FFmpegFD), which reports nothing back
# until it exits. So the honest source of truth is the file growing on disk.
# A watcher thread samples it; the admin page renders measured bytes/rate
# instead of a hard-coded stage weight and a "X 分钟未更新" guess.
#
# In-process dict, deliberately not a DB column: the pipeline runs as a
# background task inside the same uvicorn process that serves
# /api/admin/import/{id}, so a plain dict is visible to the poller without
# writing a row every 2 seconds. It dies with the process — so does the
# download it describes, so there is nothing to persist.
_DL_SAMPLE_SEC = 2.0
_DL_PROGRESS: dict[int, dict] = {}
_DL_LOCK = threading.Lock()


def get_download_progress(task_id: int) -> dict | None:
    """Latest measured download stats for a task, or None when nothing is
    downloading. Read by the admin import endpoints."""
    with _DL_LOCK:
        p = _DL_PROGRESS.get(task_id)
        return dict(p) if p else None


def _dir_bytes(out_dir: Path, prefix: str, since: float) -> int:
    """Bytes on disk for this attempt's output files.

    yt-dlp writes one `.part` per stream (video and audio are separate
    downloads) and renames on completion, so there is no single filename to
    watch — sum every file that starts with the video id and was touched
    after the attempt began. The prefix keeps concurrent imports from
    counting each other's bytes.
    """
    total = 0
    try:
        for f in out_dir.iterdir():
            if prefix and not f.name.startswith(prefix):
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            # -2s slack: the file is created a moment before its first write.
            if st.st_mtime >= since - 2:
                total += st.st_size
    except OSError:
        pass
    return total


def _start_download_watcher(
    task_id: int | None,
    out_dir: Path,
    *,
    prefix: str,
    label: str,
    deadline_sec: int,
) -> Callable[[], None]:
    """Publish measured download progress for `task_id` every ~2s.

    Returns a `stop()` that ends the thread and clears the entry, so the
    admin page shows the block only while bytes are actually moving.
    """
    if task_id is None:
        return lambda: None

    stop_evt = threading.Event()
    started = time.time()

    def _run() -> None:
        prev_bytes = 0
        prev_ts = started
        last_change_ts = started
        rate = 0.0
        while not stop_evt.is_set():
            now = time.time()
            cur = _dir_bytes(out_dir, prefix, started)
            dt = max(now - prev_ts, 0.001)
            if cur != prev_bytes:
                # EWMA: one slow sample shouldn't make the number jump around,
                # but a real stall must decay toward 0 within a few samples.
                inst = (cur - prev_bytes) / dt
                rate = inst if rate == 0 else 0.6 * inst + 0.4 * rate
                last_change_ts = now
            elif now - last_change_ts > _DL_SAMPLE_SEC * 2:
                rate = 0.0
            prev_bytes, prev_ts = cur, now
            elapsed = now - started
            with _DL_LOCK:
                _DL_PROGRESS[task_id] = {
                    "label": label,
                    "bytes": cur,
                    "rate_bps": max(rate, 0.0),
                    "elapsed_sec": int(elapsed),
                    "stalled_sec": int(now - last_change_ts),
                    # Per-attempt wall clock, so the page can show how long
                    # this attempt has before it is abandoned.
                    "deadline_sec": deadline_sec,
                    "remaining_sec": max(0, int(deadline_sec - elapsed)),
                }
            stop_evt.wait(_DL_SAMPLE_SEC)

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    def _stop() -> None:
        stop_evt.set()
        with _DL_LOCK:
            _DL_PROGRESS.pop(task_id, None)

    return _stop


def _reap_ffmpeg(match: str) -> int:
    """SIGKILL our descendant ffmpeg processes whose command line contains
    `match`. Returns how many were killed.

    A timed-out attempt abandons the *thread*, which Python can't kill — but
    the thread is only blocked because the ffmpeg child it spawned is blocked,
    and that child we can kill. Without this the ffmpeg outlives the attempt
    that owned it: one was found still wedged on an ESTABLISHED socket twelve
    minutes after its 600s timeout "failed" the attempt, still holding its
    .part file open. Killing it also unblocks yt-dlp inside the orphan thread,
    so the thread retires instead of lingering for the life of the process.

    `match` is the YouTube id, which appears in both the media URL ffmpeg
    reads and the output path it writes — the same filter the download
    watcher uses, so a concurrent import of a different video is never hit.

    Linux-only (walks /proc); any surprise degrades to killing nothing,
    because leaking a process is much better than killing the wrong one.
    """
    if not match:
        return 0
    killed = 0
    try:
        me = os.getpid()
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == me:
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    cmdline = fh.read().replace(b"\0", b" ").decode(errors="replace")
            except OSError:
                continue  # process exited, or not ours to read
            if "ffmpeg" not in cmdline or match not in cmdline:
                continue
            if not _is_descendant(pid, me):
                continue
            try:
                os.kill(pid, signal.SIGKILL)
                killed += 1
                log.warning("reaped orphan ffmpeg pid=%s (match=%s)", pid, match)
            except OSError:
                pass
    except Exception:  # pragma: no cover - never let cleanup break the import
        log.warning("ffmpeg reap failed", exc_info=True)
    return killed


def _is_descendant(pid: int, ancestor: int, *, max_depth: int = 12) -> bool:
    """Walk /proc ppid links up from `pid` looking for `ancestor`.

    Depth-bounded so a /proc read racing with process teardown (a recycled
    pid could in principle point back down) can't spin forever.
    """
    cur = pid
    for _ in range(max_depth):
        try:
            with open(f"/proc/{cur}/stat", "rb") as fh:
                stat = fh.read().decode(errors="replace")
        except OSError:
            return False
        # The comm field is parenthesised and may itself contain spaces, so
        # split after the last ')' — ppid is the 2nd field of what's left.
        tail = stat.rpartition(")")[2].split()
        if len(tail) < 2:
            return False
        ppid = int(tail[1])
        if ppid == ancestor:
            return True
        if ppid <= 1:
            return False
        cur = ppid
    return False


def _try_ytdlp_download_segment(
    url: str, out_dir: Path, start: int, end: int, task_id: int | None = None
) -> tuple[str | None, str | None]:
    """Download only [start, end] seconds of the video as a 1080p mp4. Returns
    `(path, None)` on success or `(None, error_summary)` on failure. The output
    file's timeline is 0-based.

    Tries a loose keyframe-snapped cut first (fast, no re-encode); if that
    fails, retries once with frame-exact cutting. Each attempt has its own
    300s wall clock — a hung loose pass can no longer eat the exact pass's
    budget the way a single shared timeout used to.
    """
    try:
        import yt_dlp  # type: ignore
        from yt_dlp.utils import download_range_func  # type: ignore
    except ImportError:
        log.warning("yt-dlp not installed")
        return None, "yt-dlp 未安装"

    out_template = str(out_dir / "%(id)s_%(epoch)s.%(ext)s")
    base_opts = {
        # Prefer H.264/AVC: iPhone 14 and earlier (~90% of iPhones) have no
        # AV1 hardware decode and show ⃠ on av01 files. YouTube ships AV1
        # inside an .mp4 container too, so [ext=mp4] alone does NOT exclude
        # it — we must filter on vcodec. Fall back through generic mp4 then
        # anything; whatever slips through gets transcoded by _finalize_mp4.
        "format": _H264_FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": out_template,
        "noprogress": True,
        # quiet/no_warnings used to be True; flipped so yt-dlp's own
        # progress + error lines reach our logs and the classifier
        # has more context to work with.
        "quiet": False,
        "no_warnings": False,
        "noplaylist": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 60,
        "download_ranges": download_range_func(None, [(start, end)]),
        # Ranged downloads are performed by ffmpeg, whose HTTP client gives
        # up the moment YouTube drops the connection — observed as
        # "Error opening input files: End of file" + exit 187 partway
        # through a 1.5h video's slice, after minutes of 0 B/s throttling.
        # These flags make it retry the stream instead of dying. `ffmpeg_i`
        # places them before -i, which is where reconnect options must go.
        #
        # -rw_timeout is what makes the reconnect flags reachable at all.
        # They only fire on an error or EOF, and the more common failure
        # here produces neither: YouTube (or the proxy in front of it)
        # stops feeding a connection but leaves the socket ESTABLISHED, so
        # ffmpeg blocks in read() forever — observed as a .part frozen at
        # exactly 16 MiB with zero bytes read for ten minutes, ending only
        # when the outer 600s timeout killed the attempt. A read timeout
        # turns that silence into an I/O error, which the reconnect logic
        # can then act on. It bounds a single read, not the download, so
        # 30s of *complete* silence is the bar — a slow-but-alive 60 KB/s
        # stream never trips it. Note that `socket_timeout` above cannot
        # cover this: it only governs yt-dlp's own urllib requests and
        # never reaches the ffmpeg child that fetches the ranged media.
        "external_downloader_args": {
            "ffmpeg_i": [
                "-rw_timeout", "30000000",  # microseconds
                "-reconnect", "1",
                "-reconnect_streamed", "1",
                "-reconnect_on_network_error", "1",
                "-reconnect_delay_max", "30",
            ],
        },
        # Enable the EJS solver fetch for YouTube's "n signature" challenge;
        # same rationale as in _try_fetch_metadata_and_captions.
        "remote_components": {"ejs:github"},
    }
    cookiefile = _yt_cookiefile()
    if cookiefile:
        base_opts["cookiefile"] = cookiefile

    attempts = [
        # Pass 1: loose cut (snaps to nearest keyframe, no re-encoding).
        # Order matters: this runs first because the previous "exact-first"
        # order routinely tripped the overall timeout on Tokyo-prod 200m-CPU
        # pods — re-encoding a 170s 1080p clip there can take 3-5 minutes
        # on top of ~110s download. The ±10s drift from snapping to keyframes
        # is invisible against the AI segment's own ±15s admin tuning.
        ("loose", {**base_opts, "force_keyframes_at_cuts": False}),
        # Pass 2: exact cut (re-encodes around keyframes for frame-precise
        # boundaries). Kept as a defensive fallback for the rare case
        # where the loose snap lands on an unplayable boundary.
        ("exact", {**base_opts, "force_keyframes_at_cuts": True}),
    ]

    last_error: str | None = None

    def _run_attempt(opts: dict) -> str | None:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                return None
            video_path = ydl.prepare_filename(info)
            mp4_path = str(Path(video_path).with_suffix(".mp4"))
            final = mp4_path if Path(mp4_path).exists() else video_path
            _finalize_mp4(final)
            return final

    vid = _extract_youtube_id(url)

    for mode, opts in attempts:
        log.warning(
            "yt-dlp downloading segment [%s-%s] of %s (mode=%s, timeout=%ds)",
            start, end, url, mode, _YTDLP_ATTEMPT_TIMEOUT_SEC,
        )
        result_holder: dict = {"path": None, "error": None}

        def _worker():
            try:
                result_holder["path"] = _run_attempt(opts)
            except Exception as e:
                result_holder["error"] = repr(e)

        # One watcher per attempt: elapsed/remaining then line up with the
        # per-attempt timeout the admin is actually racing against.
        stop_watch = _start_download_watcher(
            task_id, out_dir,
            prefix=vid,
            label=f"片段 {start}-{end}s · {mode} 模式",
            deadline_sec=_YTDLP_ATTEMPT_TIMEOUT_SEC,
        )
        t = threading.Thread(target=_worker, daemon=True)
        t.start()
        t.join(timeout=_YTDLP_ATTEMPT_TIMEOUT_SEC)
        stop_watch()

        if t.is_alive():
            # We can't kill the thread (Python doesn't support that safely),
            # but we can kill what it's blocked on. Leaving the ffmpeg alive
            # means the next attempt competes with a wedged connection from
            # the last one — and they accumulate, one per attempt, for the
            # life of the process. Killing it also unblocks yt-dlp in the
            # orphan thread, which then retires on its own; daemon=True is
            # only the last-resort backstop it used to be the only one.
            reaped = _reap_ffmpeg(vid)
            # Short grace join: once its child is dead the worker usually
            # unwinds in well under a second. Not waiting longer than that —
            # the attempt is already forfeit and the next one should start.
            t.join(timeout=5)
            last_error = f"timed out after {_YTDLP_ATTEMPT_TIMEOUT_SEC}s"
            log.warning(
                "yt-dlp attempt %s timed out (reaped %d ffmpeg, worker %s)",
                mode, reaped, "exited" if not t.is_alive() else "still running",
            )
            continue

        if result_holder["path"]:
            return result_holder["path"], None

        last_error = result_holder["error"] or "unknown failure (no info)"
        log.warning("yt-dlp attempt %s failed: %s", mode, last_error[:300])

    return None, last_error


def _try_ytdlp_download_full(
    url: str, out_dir: Path, task_id: int | None = None
) -> tuple[str | None, str | None]:
    """Download the FULL video as a 1080p mp4 (no time range, no ffmpeg slice).

    Used by chapters-mode imports where the whole video is preserved.  Returns
    `(path, None)` on success or `(None, error_summary)` on failure.

    Single attempt with a generous timeout proportional to "could be a 30 min
    1080p file" — no loose/exact retry split because there's no slicing to
    snap to a keyframe.  Same cookies + EJS solver setup as the segment path
    so YouTube's anti-bot / n-signature challenges go through.
    """
    try:
        import yt_dlp  # type: ignore
    except ImportError:
        log.warning("yt-dlp not installed")
        return None, "yt-dlp 未安装"

    out_template = str(out_dir / "%(id)s_%(epoch)s.%(ext)s")
    opts = {
        # Same H.264-first rationale as the segment path (see _H264_FORMAT).
        "format": _H264_FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": out_template,
        "noprogress": True,
        "quiet": False,
        "no_warnings": False,
        "noplaylist": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 60,
        "remote_components": {"ejs:github"},
    }
    cookiefile = _yt_cookiefile()
    if cookiefile:
        opts["cookiefile"] = cookiefile

    # 600s = 2× the segment per-attempt timeout. A full 30 min 1080p video
    # can be 250-400 MB; 600s is enough headroom on a Tokyo prod pod with
    # decent throughput while still bounded so a hung session can't wedge
    # the whole pipeline.
    timeout_sec = 600
    log.warning(
        "yt-dlp downloading FULL video %s (timeout=%ds)", url, timeout_sec,
    )
    result_holder: dict = {"path": None, "error": None}

    def _worker():
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                if not info:
                    return
                video_path = ydl.prepare_filename(info)
                mp4_path = str(Path(video_path).with_suffix(".mp4"))
                final = mp4_path if Path(mp4_path).exists() else video_path
                _finalize_mp4(final)
                result_holder["path"] = final
        except Exception as e:
            result_holder["error"] = repr(e)

    stop_watch = _start_download_watcher(
        task_id, out_dir,
        prefix=_extract_youtube_id(url),
        label="完整视频",
        deadline_sec=timeout_sec,
    )
    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(timeout=timeout_sec)
    stop_watch()

    if t.is_alive():
        # Same reap as the segment path: the thread is unkillable, its
        # ffmpeg child is not, and leaving it alive leaks a wedged socket.
        _reap_ffmpeg(_extract_youtube_id(url))
        t.join(timeout=5)
        return None, f"full-video download timed out after {timeout_sec}s"
    if result_holder["path"]:
        return result_holder["path"], None
    return None, result_holder["error"] or "unknown failure (no info)"


# Codecs an iPhone 14 / iOS 16 can hardware-decode. av1 and vp9 are NOT
# in this set, which is the whole point of _finalize_mp4 / the transcoder.
_IPHONE_SAFE_CODECS = {"h264", "avc1"}


def probe_video_codec(path: str | Path) -> tuple[str, str]:
    """Return (codec_name, pix_fmt) of the first video stream.

    ("", "") on any failure (missing ffprobe, unreadable file). Callers
    treat the empty case as "unknown, don't touch" so a flaky probe
    never triggers a needless multi-minute re-encode.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,pix_fmt",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return "", ""
        lines = [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]
        return (lines[0] if lines else ""), (lines[1] if len(lines) > 1 else "")
    except Exception as e:
        log.warning("ffprobe failed for %s: %s", path, e)
        return "", ""


def _ffmpeg_finalize(src: Path, *, transcode: bool, timeout: int) -> bool:
    """One ffmpeg pass into a `.tmp.mp4` sibling, atomic-replace on success.

    transcode=False → stream copy + faststart (~1-2s, just moves `moov`).
    transcode=True  → libx264 high@4.0 yuv420p crf23 veryfast + aac +
                      faststart (minutes — full re-encode).

    Returns True only if the original was replaced. Soft-fails (leaves
    the original untouched) on any error so a bad pass can't destroy a
    working file.
    """
    tmp = src.with_suffix(".tmp.mp4")
    if transcode:
        vargs = ["-c:v", "libx264", "-profile:v", "high", "-level", "4.0",
                 "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "veryfast",
                 "-c:a", "aac", "-b:a", "128k"]
    else:
        vargs = ["-c", "copy"]
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
           *vargs, "-movflags", "+faststart", str(tmp)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            log.warning("ffmpeg finalize failed (rc=%d, transcode=%s): %s",
                        result.returncode, transcode, result.stderr[:300])
            tmp.unlink(missing_ok=True)
            return False
        if not tmp.exists() or tmp.stat().st_size == 0:
            log.warning("ffmpeg finalize produced empty file; leaving original")
            tmp.unlink(missing_ok=True)
            return False
        tmp.replace(src)
        log.info("ffmpeg finalize ok (transcode=%s): %s (%d bytes)",
                 transcode, src.name, src.stat().st_size)
        return True
    except FileNotFoundError:
        log.warning("ffmpeg not on PATH; skipping finalize")
        return False
    except subprocess.TimeoutExpired:
        log.warning("ffmpeg finalize timed out (transcode=%s) for %s", transcode, src.name)
        tmp.unlink(missing_ok=True)
        return False
    except Exception as e:
        log.warning("ffmpeg finalize error: %s", e)
        tmp.unlink(missing_ok=True)
        return False


def transcode_in_place_to_h264(mp4_path: str | Path, timeout: int = 1800) -> str:
    """Re-encode an existing file to H.264 in place. Returns the resulting
    video codec ("h264" on success, original codec / "" on failure).

    Used by the admin transcode queue to repair stored AV1/VP9 episodes
    without changing the filename or DB video_url.
    """
    src = Path(mp4_path)
    if not src.exists() or src.suffix.lower() != ".mp4":
        return ""
    ok = _ffmpeg_finalize(src, transcode=True, timeout=timeout)
    codec, _ = probe_video_codec(src)
    return codec if ok else codec


def _finalize_mp4(mp4_path: str) -> None:
    """Make a freshly-downloaded mp4 iPhone-safe in one ffmpeg pass.

    Two concerns, one pass at import time:

    1. faststart — iOS Safari refuses to start playback until it can read
       the `moov` atom; yt-dlp writes it at the END. Without faststart iOS
       surfaces MEDIA_ERR_SRC_NOT_SUPPORTED. Desktop/Chrome quietly do a
       second range request to the tail and play anyway.
    2. codec — iPhone 14 and earlier have no AV1 hardware decode and show
       ⃠ on av01 files. The yt-dlp selector prefers AVC, but YouTube
       sometimes only offers AV1/VP9; those get re-encoded to H.264 here.

    Already-H.264 → cheap `-c copy` faststart (~1-2s). AV1/VP9 → libx264
    veryfast (minutes). Unknown/probe-fail → faststart only (don't burn
    minutes re-encoding on a flaky probe). Atomic `.tmp.mp4` rename.
    Soft-fails so an ffmpeg hiccup can't fail the whole import.
    """
    src = Path(mp4_path)
    if not src.exists() or src.suffix.lower() != ".mp4":
        # Non-mp4 (.webm fallback) — Safari won't play it and faststart is
        # mp4-specific; leave alone.
        return
    codec, _pix = probe_video_codec(src)
    need_transcode = codec != "" and codec not in _IPHONE_SAFE_CODECS
    if need_transcode:
        log.warning("non-iPhone codec %r in %s — transcoding to H.264",
                    codec, src.name)
    _ffmpeg_finalize(src, transcode=need_transcode,
                     timeout=900 if need_transcode else 120)


def _extract_youtube_id(url: str) -> str:
    """Pull the video id out of any of YouTube's URL shapes.

    Recognises:
      - https://i.ytimg.com/vi/<ID>/maxresdefault.jpg
      - https://www.youtube.com/watch?v=<ID>
      - https://youtu.be/<ID>
      - https://www.youtube.com/embed/<ID>
    Returns "" if no id is recoverable."""
    if not url:
        return ""
    patterns = [
        r"/vi/([A-Za-z0-9_-]{6,})/",        # i.ytimg.com thumbnail
        r"[?&]v=([A-Za-z0-9_-]{6,})",        # watch?v=
        r"youtu\.be/([A-Za-z0-9_-]{6,})",    # short link
        r"/embed/([A-Za-z0-9_-]{6,})",       # embed
    ]
    for pat in patterns:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return ""


def _download_thumbnail(remote_url: str, youtube_id: str = "") -> str | None:
    """Download a YouTube thumbnail to /app/media/thumbs/<id>.jpg.

    Returns the relative path "/media/thumbs/<id>.jpg" on success, or
    None on any failure (caller falls back to the original URL).

    Why local: YouTube's i.ytimg.com CDN is GFW-blocked for mainland CN
    users — episode cards rendered straight off it come up blank.
    Tokyo origin can fetch i.ytimg.com fine, so downloading once at
    import time and serving from our own /media path (which goes
    through the media bypass subdomain) makes the thumbnails visible
    in CN without anyone needing a VPN.

    Idempotent enough: if the file already exists at the target path,
    we trust it and skip re-download.  Same youtube_id always maps to
    the same disk path, so re-imports of the same source video
    deduplicate naturally.
    """
    if not remote_url:
        return None
    if not youtube_id:
        youtube_id = _extract_youtube_id(remote_url)
    if not youtube_id:
        return None
    # Normalize id defensively (in case caller passed something odd).
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "", youtube_id)
    if not safe_id:
        return None
    target = THUMBS_DIR / f"{safe_id}.jpg"
    rel = f"/media/thumbs/{safe_id}.jpg"
    if target.exists() and target.stat().st_size > 0:
        return rel
    import urllib.request
    try:
        req = urllib.request.Request(
            remote_url,
            headers={"User-Agent": "Mozilla/5.0 (justSpeak thumbnail fetcher)"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
    except Exception as e:
        log.warning("thumbnail fetch failed for %s: %s", safe_id, e)
        return None
    if not data or len(data) < 1024:  # YouTube returns a 12-byte 1x1 placeholder when maxres doesn't exist
        log.info("thumbnail %s response too small (%d bytes); skipping", safe_id, len(data) if data else 0)
        return None
    try:
        target.write_bytes(data)
    except OSError as e:
        log.warning("thumbnail write failed for %s: %s", safe_id, e)
        return None
    log.info("thumbnail saved: %s (%d bytes)", target.name, len(data))
    return rel


# ============ Stage 2: Whisper transcription ============
# Lazy-loaded singleton so we don't reload the model on every import.
_FW_MODEL = None


def _try_whisper_transcribe(audio_path: str) -> list[tuple[int, int, str, str]] | None:
    """Return [(start_ms, end_ms, text_en, ''), ...] or None.

    Uses faster-whisper (CTranslate2 reimplementation, ~10x lighter than openai-whisper).
    The 'tiny.en' model is ~75MB and transcribes a 10-min clip in ~30s on CPU.
    """
    global _FW_MODEL
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        log.info("faster-whisper not installed, using stub subtitles")
        return None

    try:
        if _FW_MODEL is None:
            log.info("loading faster-whisper tiny.en model (first call only)")
            _FW_MODEL = WhisperModel("tiny.en", device="cpu", compute_type="int8")
        segments, info = _FW_MODEL.transcribe(
            audio_path,
            beam_size=5,
            vad_filter=True,    # skip silences
            language="en",
        )
        rows = []
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            rows.append((
                int(seg.start * 1000),
                int(seg.end * 1000),
                text,
                "",  # zh filled by translation step
            ))
        log.info("whisper transcribed %d segments (audio %.1fs)", len(rows), info.duration)
        return rows
    except Exception as e:
        log.warning("whisper transcribe failed: %s", e)
        return None


# ============ Stage 2.5: Translate subs to Chinese via LLM ============
_TRANSLATE_BATCH_SYS = """You translate English subtitles into natural Chinese for learners.

INPUT: numbered English lines like "[1] ..." "[2] ...".
OUTPUT: same numbered lines with Chinese translations, one per line.

GENERAL RULES:
- Each output line MUST start with the same [N] prefix, same N count, same order.
- Translations are CEFR-B1 natural Chinese — readable, not machine-literal.
- Keep punctuation close to source — if an English line ends without a period,
  the Chinese may end without 。 to preserve the "continues to next line" feel.
- DO NOT add commentary, explanations, or output anything except the numbered
  translations.

PARSE BEFORE TRANSLATING (this is the most common quality bug):
YouTube auto-captions are spoken English — they drop relative pronouns,
run sentences together, omit punctuation, and put words in unusual orders.
You MUST mentally parse subject / verb / object FIRST, then translate the
MEANING, not the surface word order. Specific patterns to watch for:

1. IMPLICIT relative pronoun (whom / that / which dropped):
   EN: "I was one of the few creators they told me about it"
   PARSE: "I was one of the few creators [whom] they told [about it]"
   ZH: "我是他们告知的少数几个创作者之一"
   WRONG: "他们是少数几个告诉我的创作者" (subject inverted!)

   EN: "the thing I was talking about"
   PARSE: "the thing [that] I was talking about"
   ZH: "我刚才说的那件事" (NOT "我说的事")

2. RUN-ON sentences with no clause boundary:
   EN: "I bought it because they told me it was good and I trusted them"
   ZH: split into two natural Chinese clauses with proper conjunctions

3. CROSS-SENTENCE pronoun reference (this/that/it/they/them):
   When a sentence starts with "This means..." / "It works..." / "They have...",
   look at the previous 1-3 lines to figure out the actual referent, and use
   the concrete noun if Chinese reads better that way.
   EN: "[1] We launched MCP. [2] It changes everything."
   ZH: "[2] 这（指 MCP）改变了一切。" — explicit antecedent OK if needed.

4. SUBJECT INVERSION / question-as-statement:
   EN: "said I" → "我说" (NOT "说我")
   EN: "Says he, ..." → "他说，..."
   EN: "What's interesting is" → "有意思的是" (the predicate is the focus)

5. PREPOSITION-STRANDED relative clauses:
   EN: "the company I work for"
   ZH: "我工作的公司" (NOT "我为公司工作的")
   EN: "the people I'm with"
   ZH: "和我在一起的人"

PROPER-NOUN ASR FIXES (use context to recover the real name, then be CONSISTENT):
- "GPD", "GPT 4", "GPT-4", "GPT5" + a version like "5.2" → "GPT-5.2"
- "entropic" / "anthropic" → "Anthropic"
- "open claw" / "open clawed" → "OpenClaude"
- "cloud code(s)" / "claw code" → "Claude Code"
- "deep player" → keep as-is unless clearly wrong
- Obvious verb tense / typo fixes only when needed for readability."""


# One LLM call per this many subtitle lines.  DeepSeek v4 is a reasoning
# model and it thinks line-by-line: measured on a 34-line clip, it spent
# 8429 reasoning tokens before writing a single character of answer, blew
# through the whole (already doubled) 8024-token budget and came back with
# finish_reason=length and content="".  The caller saw an empty string,
# every row went into the DB with a blank text_zh, and the import still
# reported success — ep 47/48 shipped with English-only subtitles.
# Reasoning cost scales with line count, so no single budget is safe for a
# long transcript; a fixed window keeps each call's thinking bounded.
_TRANSLATE_WINDOW = 20
# Lines of already-translated context handed to the next window so
# pronouns and proper nouns stay consistent across the seam.
_TRANSLATE_CONTEXT_LINES = 3


def _parse_translated(raw: str) -> dict[int, str]:
    """Pull `[N] 译文` lines out of an LLM reply. Keys are the [N] as sent."""
    out: dict[int, str] = {}
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("[") and "]" in line:
            num_str, text = line[1:].split("]", 1)
            try:
                out[int(num_str)] = text.strip()
            except ValueError:
                pass
    return out


def _translate_window(
    window: list[tuple[int, str]], context: list[tuple[str, str]],
    no_think: bool = False,
) -> dict[int, str]:
    """Translate one window of (global_index, english) pairs.

    Numbering stays global — the model sees [17]..[36], not [1]..[20] — so
    a window boundary can't silently shift rows onto the wrong timestamps.
    Returns {global_index: zh}; empty dict means the call produced nothing.
    """
    user = ""
    if context:
        # Context is shown, not asked for: it exists so "it"/"they" and the
        # proper nouns already fixed in the previous window carry over.
        user += "CONTEXT (already translated, DO NOT output these):\n"
        user += "\n".join(f"{en}\n→ {zh}" for en, zh in context)
        user += "\n\nTRANSLATE THESE:\n"
    user += "\n".join(f"[{i}] {en}" for i, en in window)
    # Measured on deepseek-v4-pro: ~250 reasoning tokens per subtitle line
    # before the answer starts, and the answer itself is ~90.  Ask for the
    # sum (llm._chat doubles it again for DeepSeek) — max_tokens is a
    # ceiling, not a spend, so over-asking is free and under-asking loses
    # the whole window.
    budget = 350 * len(window) + 1000
    raw = llm._chat(
        system=_TRANSLATE_BATCH_SYS,
        user=user,
        max_tokens=budget,
        timeout=180,
        task="translate_subs",
        no_think=no_think,
    )
    return _parse_translated(raw) if raw else {}


def _translate_to_zh(subs: list[tuple[int, int, str, str]]) -> list[tuple[int, int, str, str]]:
    """Translate all English rows, in windows of _TRANSLATE_WINDOW lines.

    Windowed rather than one big call because a reasoning model's thinking
    budget scales with the number of lines (see _TRANSLATE_WINDOW).  Each
    window still carries the tail of the previous one as context, which is
    what the single-call version was really buying: consistent proper nouns
    across rows, and ASR errors like "GPD 5.2" that only resolve to
    "GPT-5.2" when you can see the surrounding sentences.
    """
    if not llm.has_credentials() or not subs:
        return subs
    translations: dict[int, str] = {}
    try:
        for start in range(0, len(subs), _TRANSLATE_WINDOW):
            window = [
                (i + 1, subs[i][2])
                for i in range(start, min(start + _TRANSLATE_WINDOW, len(subs)))
            ]
            context = [
                (subs[i][2], translations[i + 1])
                for i in range(max(0, start - _TRANSLATE_CONTEXT_LINES), start)
                if translations.get(i + 1)
            ]
            got = _translate_window(window, context)
            if not got:
                # Empty means the model thought itself out of budget (or the
                # provider is down).  Retry once with thinking off: a plain
                # translation of 20 short lines took 10s and 598 tokens with
                # no reasoning at all, versus 8429 reasoning tokens and an
                # empty answer with it.  One retry only, so a dead provider
                # can't turn into a retry storm.
                got = _translate_window(window, context, no_think=True)
            if not got:
                log.error(
                    "translate window %d-%d produced nothing — those rows "
                    "will have no zh",
                    window[0][0], window[-1][0],
                )
            translations.update(got)
    except Exception as e:
        log.warning("translation failed: %s", e)

    missing = len(subs) - len([i for i in range(len(subs)) if translations.get(i + 1)])
    if missing:
        # Loud: a clip with no Chinese is a broken clip, and the import used
        # to report success anyway.  Admin can re-run
        # POST /api/admin/episodes/{id}/retranslate-subtitles once the
        # provider is healthy again.
        log.error("translation incomplete: %d/%d rows have no zh", missing, len(subs))
    return [
        (s[0], s[1], s[2], translations.get(i + 1, s[3]))
        for i, s in enumerate(subs)
    ]


# ============ Main runner ============
async def run_pipeline(db: AsyncSession, task_id: int, params: dict):
    """Import one video end to end.

    `params["llm_override"]` carries the credentials this run bills to —
    the admin who pressed 导入, or the owner of the schedule that fired.
    Set once here as the ambient override (llm.use_override) rather than
    threaded through the ~16 llm.* functions this run touches; see the
    note on llm._ambient_override for why.
    """
    task = await db.get(ImportTask, task_id)
    if not task:
        return
    override = params.get("llm_override")
    with llm.use_override(override):
        await _run_pipeline_inner(db, task, task_id, params)


async def _run_pipeline_inner(
    db: AsyncSession, task: ImportTask, task_id: int, params: dict,
):

    async def mark(stage: int, status: str, progress: int, **extra):
        task.stage = stage
        task.status = status
        task.progress = progress
        for k, v in extra.items():
            setattr(task, k, v)
        task.log = list(task.log) + [{"stage": stage, "status": status, "ts": time.time()}]
        await db.commit()

    try:
        title_fallback = "Imported Episode"
        summary_fallback = "Imported from YouTube via AI pipeline"
        thumbnail = "https://picsum.photos/seed/justspeak-%d/800/500" % task.id
        video_url = ""
        duration = 38
        real_download = False

        # --- Stage 1: metadata + YouTube captions (no video download) ---
        # Fast & cheap — lets the LLM see the FULL transcript before we commit to
        # downloading any bytes. Critical for 1-2h videos where the old flow
        # downloaded 90s around t=0 and then asked AI to pick from that sliver.
        await mark(1, "fetching_metadata", 5)
        try:
            meta = await asyncio.wait_for(
                asyncio.to_thread(_try_fetch_metadata_and_captions, task.youtube_url),
                timeout=60,
            )
        except asyncio.TimeoutError:
            log.warning("metadata fetch timed out after 60s")
            meta = None

        yt_subs: list[tuple[int, int, str, str]] = []
        full_duration = 0
        if meta:
            title_fallback = meta["title"] or title_fallback
            summary_fallback = meta["description"] or summary_fallback
            thumbnail = meta["thumbnail"] or thumbnail
            full_duration = meta["duration"] or 0
            yt_subs = meta["subs"]

            # Mirror the YouTube thumbnail to our origin so CN users
            # (whose ISPs block i.ytimg.com) actually see the card art.
            # Falls back to the remote URL on download failure — better
            # to ship a card with a slow / blocked image than a 404.
            local_thumb = await asyncio.to_thread(
                _download_thumbnail,
                thumbnail,
                _extract_youtube_id(task.youtube_url) or _extract_youtube_id(thumbnail),
            )
            if local_thumb:
                thumbnail = local_thumb
            # Bug 3 fix: persist raw_vtt so phase 2 (multi-segment approval
            # path) can run the hybrid sentence splitter. The VTT can be
            # 200KB+; too big for the task.selected_segment JSON column.
            _persist_vtt_for_task(task.id, meta.get("vtt_raw", ""))

        # --- Stage 2: pick learning window(s) ---
        # `mode` toggles between:
        #   "highlight" (default): existing behavior — AI picks 1 or N
        #     non-overlapping highlight windows; admin previews if >1.
        #   "full": legacy Collection mode — split the WHOLE video into
        #     2-3min segments, each becomes an Episode sharing youtube_url.
        #   "chapters": full-video import — keep the whole video as ONE
        #     Episode (import_mode='chapters') with AI-generated chapter
        #     markers (episode_chapters rows) for navigation only.
        mode = (params.get("mode") or "highlight").lower()

        # Chapters-mode early branch: skip the whole segment-selection /
        # snap-to-sentence / pad / preview machinery (none of it applies
        # when the entire video is preserved) and dispatch to the
        # dedicated full-video processor.
        if mode == "chapters":
            await mark(2, "splitting_chapters", 18)
            await _process_full_video(
                db, task, mark, yt_subs, meta, params,
                title_fallback, summary_fallback, thumbnail, full_duration,
            )
            await mark(5, "reviewing", 100)
            return

        segments_count = params.get("segments_count", 1)
        # auto_approve: skip the admin preview/adjust pause entirely and run
        # stages 3-5 straight through on the AI-picked segments. Default True —
        # the manual review gate was friction (and its "确认并下载" button was
        # flaky); imports now just go end-to-end. Scheduled imports already
        # passed True. To bring the preview gate back for a one-off, pass
        # auto_approve=false in the import body.
        auto_approve = params.get("auto_approve", True)
        # Full mode never previews — it always runs end-to-end. Highlight
        # multi-segment keeps the existing admin-preview gate.
        use_preview = (
            mode != "full"
            and (params.get("preview", False) or segments_count > 1)
            and not auto_approve
        )
        await mark(2, "selecting_segment", 18)

        # The transcript the picker reads keeps its ">>" speaker markers, even
        # though the displayed subtitles drop them. Who is talking is exactly
        # the signal that tells a picker where a thought begins: strip it and
        # the model cannot tell a question from the answer that follows, which
        # is how clips ended up opening on "Well, I'm currently making just
        # under 18k a month." with the question left outside the window.
        raw_caps_for_pick = (meta or {}).get("vtt_raw", "") if isinstance(meta, dict) else ""
        pick_turns = _caption_word_timings(raw_caps_for_pick)[1] if raw_caps_for_pick else []

        def _opens_turn(start_ms: int, end_ms: int) -> bool:
            i = bisect_left(pick_turns, start_ms)
            return i < len(pick_turns) and pick_turns[i] < end_ms

        sub_dicts = [
            {
                "start_sec": s[0] / 1000,
                "end_sec": s[1] / 1000,
                "text_en": (">> " if _opens_turn(s[0], s[1]) else "") + s[2],
            }
            for s in yt_subs
        ] if yt_subs else []
        segments: list[dict] = []
        is_full_mode = mode == "full"
        topic_hint = str(params.get("topic_hint", "")).strip()
        # Locate sponsor reads BEFORE picking, so the picker is told which
        # ranges are off-limits and the code below can enforce it. Failure
        # here degrades to the old behaviour rather than blocking the import.
        ad_spans: list[dict] = []
        if sub_dicts:
            try:
                ad_spans = await asyncio.wait_for(
                    asyncio.to_thread(llm.detect_ad_spans, sub_dicts), timeout=180,
                )
            except Exception as e:
                log.warning("ad detection failed, proceeding without: %s", e)

        # Map the video's topic structure before picking a window out of it.
        # Highlight mode only: full mode already covers the whole timeline, so
        # there is nothing for chapters to confine. Failure degrades to picking
        # over the raw timeline (see llm.select_learning_segments).
        topic_units: list[dict] = []
        if sub_dicts and not is_full_mode:
            try:
                topic_units = await asyncio.wait_for(
                    asyncio.to_thread(llm.outline_topic_units, sub_dicts, full_duration),
                    timeout=180,
                )
            except Exception as e:
                log.warning("chaptering failed, picking over raw timeline: %s", e)

        if sub_dicts:
            if is_full_mode:
                # One LLM call splits the whole video into N coherent
                # 2-3min segments with title + topic blurb.
                segments = await asyncio.to_thread(
                    llm.split_full_video, sub_dicts, 20, topic_hint,
                )
                log.info("full-video split into %d segments", len(segments))
            else:
                segments = await asyncio.to_thread(
                    llm.select_learning_segments, sub_dicts, segments_count,
                    topic_hint, ad_spans, topic_units,
                )
            log.info("AI segment pick(s): %s", segments)

        # The picker is told to avoid the ads and sometimes still walks into
        # one. This is the enforcement that doesn't rely on it cooperating.
        if ad_spans and segments:
            kept = [
                s for s in segments
                if _relocate_out_of_ads(
                    s, ad_spans, full_duration, trim_only=is_full_mode,
                )
            ]
            if kept:
                segments = kept
            else:
                # Every window was judged unusable — likelier a runaway ad
                # detector than a video that is all ads. Keep the picks.
                log.warning("ad filter would drop every segment; keeping originals")

        if not segments:
            anchor = _parse_youtube_timestamp(task.youtube_url)
            seg_start_fb = anchor
            seg_end_fb = anchor + SEGMENT_LENGTH_SEC
            if full_duration and seg_end_fb > full_duration:
                seg_end_fb = full_duration
                seg_start_fb = max(0, seg_end_fb - SEGMENT_LENGTH_SEC)
            # A blind window is a materially worse episode: it opens wherever
            # the video happens to be at that second, which is what shipped as
            # "clips that start mid-explanation" for episodes 42-48. It used to
            # be indistinguishable from a real pick in the admin UI — the only
            # trace was one word in ai_metadata. Say so on the task instead.
            why = "字幕解析为空" if not sub_dicts else "AI 选段返回空（模型没给出可用结果）"
            log.warning("segment selection produced nothing (%s) — using blind window "
                        "%ds-%ds", why, seg_start_fb, seg_end_fb)
            task.error = (
                f"⚠️ AI 选段未生效（{why}），已退回默认窗口 "
                f"{seg_start_fb}s-{seg_end_fb}s。片段可能从半句话开始，建议重新导入。"
            )
            segments = [{
                "start": seg_start_fb,
                "end": seg_end_fb,
                "reason": f"fallback window ({why})",
                "fallback": True,
            }]

        # Snap each segment's start to the nearest .!? sentence boundary
        # within ±15s. The LLM picks segment endpoints from coalesced 10s
        # bins (see llm._coalesce_subs) so it can't see sub-bin punctuation
        # — its starts routinely land mid-sentence by 3-8s. Word-level
        # VTT timestamps let us correct that here, before bounds enforcement
        # so the 1/3-backward extension doesn't re-pollute our snapped start.
        # Length is preserved (delta also applied to end).
        # No-op when raw_vtt is missing (whisper-only path) or there's no
        # boundary in the drift window.
        raw_vtt_for_snap = (meta or {}).get("vtt_raw", "") if isinstance(meta, dict) else ""
        boundaries_ms: list[int] = []
        if raw_vtt_for_snap and segments:
            snap_words, snap_turns = _caption_word_timings(raw_vtt_for_snap)
            boundaries_ms = _sentence_boundaries_ms(snap_words, snap_turns)
            if boundaries_ms:
                for seg in segments:
                    pre = (int(seg.get("start", 0)), int(seg.get("end", 0)))
                    # Speaker changes get first refusal: on interview content
                    # the best opening is the question, not whatever sentence
                    # happens to be nearest. Falls through to plain sentence
                    # boundaries when no hand-off is within reach, and the
                    # second call is a no-op once the first one lands.
                    _snap_segment_to_sentence(seg, snap_turns, full_duration)
                    _snap_segment_to_sentence(seg, boundaries_ms, full_duration)
                    # End-snap: extend forward to the next .!? within +8s so
                    # we don't chop a sentence in half. Independent from
                    # start-snap (which is symmetric ±15s); end-snap is
                    # asymmetric forward-only because we never want to
                    # shorten an already-too-short clip's tail.
                    _extend_segment_end_to_sentence(seg, boundaries_ms, full_duration)
                    post = (int(seg["start"]), int(seg["end"]))
                    if pre != post:
                        log.info("snapped segment bounds: %s -> %s", pre, post)

        # Enforce 2-3 minute window before padding/persisting. DeepSeek
        # sometimes picks 30-90s windows by greedy density; learners need
        # at least 2 minutes of context.
        for seg in segments:
            _enforce_segment_bounds(seg, full_duration)

        # ...and then re-align, because enforcement is what un-does the snap:
        # it reaches 1/3 of the shortfall BACKWARD, which walks the start back
        # through the boundary we just aligned to and lands mid-sentence again
        # (the ad filter already gets a second pass here for the same reason).
        # Start only moves forward now, so it can never re-enter a sentence,
        # and the few seconds it gives back are worth more than hitting the
        # 120s floor exactly.
        if boundaries_ms:
            for seg in segments:
                pre = (int(seg.get("start", 0)), int(seg.get("end", 0)))
                _pull_segment_start_to_boundary(seg, boundaries_ms)
                _extend_segment_end_to_sentence(seg, boundaries_ms, full_duration)
                post = (int(seg["start"]), int(seg["end"]))
                if pre != post:
                    log.info("re-aligned after bounds enforcement: %s -> %s", pre, post)

        # Sentence-snapping drifts a window by up to ±15s and bounds
        # enforcement extends it by up to 120s — either can walk a clean
        # pick back into an ad. Trim (never relocate) once more now that
        # the boundaries are final.
        if ad_spans and segments:
            segments = [
                s for s in segments
                if _relocate_out_of_ads(s, ad_spans, full_duration, trim_only=True)
            ] or segments

        # Pad each segment and persist to task for the admin UI.
        for seg in segments:
            seg["source_start"] = max(0, int(seg["start"]) - SEGMENT_START_PADDING_SEC)
            seg["source_end"] = int(seg["end"]) + SEGMENT_END_PADDING_SEC
            if full_duration:
                seg["source_end"] = min(seg["source_end"], full_duration)
            if seg["source_end"] <= seg["source_start"]:
                seg["source_end"] = seg["source_start"] + SEGMENT_LENGTH_SEC

        task.selected_segment = {
            "segments": segments,
            "full_duration": full_duration,
            "mode": mode,
            # Surfaced so the admin preview can show what was excluded and
            # why a window sits where it does.
            "ad_spans": ad_spans,
            "meta": {
                "title": title_fallback,
                "description": summary_fallback,
                "thumbnail": thumbnail,
            },
        }
        # Store yt_subs compactly so phase 2 can reuse them without re-fetching.
        task.ai_segments = [[s[0], s[1], s[2], s[3]] for s in yt_subs]
        await db.commit()

        # --- Preview mode: pause here, admin reviews/adjusts, then approves ---
        if use_preview:
            await mark(2, "pending_review", 25)
            log.info("pausing for admin review (%d segments)", len(segments))
            return

        # --- No preview → run stages 3-5. Full mode fans out (semaphore=3)
        # so a 30-min video doesn't take 15min to import; highlight mode
        # runs its 1-5 windows sequentially. Both isolate per-segment
        # failures so one dead download can't sink the whole import. ---
        n = len(segments)
        if is_full_mode:
            await _run_full_video_segments(
                task_id, segments, yt_subs, meta, params,
                title_fallback, summary_fallback, thumbnail, full_duration,
            )
        else:
            await _run_highlight_segments(
                db, task, mark, segments, yt_subs, meta, params,
                title_fallback, summary_fallback, thumbnail, full_duration,
            )
        await mark(5, "reviewing", 100)
    except Exception as e:
        log.exception("pipeline failed: %s", e)
        try:
            await db.rollback()
        except Exception:
            pass
        fresh_task = await db.get(ImportTask, task_id)
        if fresh_task:
            fresh_task.status = "failed"
            fresh_task.error = str(e)[:500]
            fresh_task.log = list(fresh_task.log or []) + [
                {"stage": fresh_task.stage, "status": "failed",
                 "ts": time.time(), "error": str(e)[:200]}
            ]
            try:
                await db.commit()
            except Exception:
                log.exception("failed to persist failure status")


# ============ Segment processor (stages 3-5 for one clip) ============
async def _process_segment(
    db: AsyncSession,
    task: "ImportTask",
    mark,
    seg: dict,
    yt_subs: list[tuple[int, int, str, str]],
    meta: dict | None,
    params: dict,
    title_fallback: str,
    summary_fallback: str,
    thumbnail: str,
    full_duration: int,
    *,
    seg_idx: int = 0,
    n_segments: int = 1,
    collection_kind: str | None = None,
    segment_title_override: str | None = None,
    segment_topic_zh: str | None = None,
):
    """Run stages 3-5 for a single segment: download → subtitles → chunks →
    dialog → persist episode. Called once for single-segment imports,
    or N times in a loop for multi-segment."""
    seg_start = seg["source_start"]
    seg_end = seg["source_end"]
    # Count-prefix-parens reads better than the old " #N/M" suffix: when
    # several same-source segments cluster in a list, the (N/M) tokens
    # column-align at the start and the eye finds the sequence instantly.
    seg_label = f"({seg_idx + 1}/{n_segments}) " if n_segments > 1 else ""

    # Multi-segment status prefix: admin polling /import/{id} sees
    # "[2/5] downloading" instead of a generic "downloading" with no
    # clue which highlight segment is in flight. Re-binds the local
    # `mark` so every downstream call picks up the prefix automatically.
    if n_segments > 1:
        _seg_status_prefix = f"[{seg_idx + 1}/{n_segments}] "
        _outer_mark = mark

        async def mark(stage: int, status: str, progress: int, **extra):  # type: ignore[no-redef]
            await _outer_mark(stage, f"{_seg_status_prefix}{status}", progress, **extra)

    # --- Stage 3a: download ---
    await mark(3, "downloading", 30)
    video_path: str | None = None
    yt_error: str | None = None
    try:
        video_path, yt_error = await asyncio.wait_for(
            asyncio.to_thread(
                _try_ytdlp_download_segment,
                task.youtube_url, MEDIA_DIR, seg_start, seg_end, task.id,
            ),
            # Outer budget = 2 × per-attempt (600s) + 100s slack for ffmpeg
            # remux + IO. Inner _try_ytdlp_download_segment owns its own
            # per-attempt timeout, so a hung loose pass no longer eats the
            # exact pass's chance.
            timeout=1300,
        )
    except asyncio.TimeoutError:
        log.warning("segment download outer timeout (1300s) tripped")
        yt_error = "outer timeout 1300s exceeded"

    # Hard-fail on download failure regardless of meta status — otherwise we'd
    # silently create an Episode with video_url="" and fall back to CANNED_SUBS
    # below, which the frontend surfaces as "视频文件未提供" with fake demo content.
    if not video_path:
        friendly = _classify_ytdlp_error(yt_error or "")
        raw_suffix = ""
        if yt_error:
            raw_suffix = f"（yt-dlp: {yt_error[:120]}）"
        raise RuntimeError(
            f"片段下载失败（{seg_start}-{seg_end}s of {full_duration}s 原片）：{friendly}{raw_suffix}"
        )
    video_url = f"/media/{Path(video_path).name}"
    # _finalize_mp4 already guaranteed H.264 (or left it unknown); record
    # the actual codec so the admin codec scan / badge is correct from
    # import without a separate probe pass.
    video_codec = probe_video_codec(video_path)[0]
    duration = seg_end - seg_start
    real_download = True

    # --- Stage 3b: subtitles ---
    # Split into COMPLETE SENTENCES using the VTT's word-level timestamps,
    # so every display row is a natural unit for reading + shadowing and
    # translations can preserve cross-sentence context (proper nouns etc.).
    await mark(3, "transcribing", 50)
    sub_rows: list[tuple[int, int, str, str]] = []
    row_word_timings: list[list[list]] = []  # parallel to sub_rows
    needs_translate = False

    # Subtitles cover the clip's REAL end, not the AI's chosen end: the last
    # SEGMENT_END_PADDING_SEC of audio plays either way, and stopping the rows
    # early is what left the final subtitle hanging mid-sentence ("...but you
    # can") when the sentence finishes a second or two into the padding.
    clip_end_abs_ms = seg_end * 1000
    seg_start_ms = seg_start * 1000  # padded start = audio t=0
    raw_vtt = (meta or {}).get("vtt_raw", "") if isinstance(meta, dict) else ""

    if raw_vtt:
        # Hybrid path: word-timing sentence-split for the head, plain
        # yt_subs sentence-merge for the uncovered tail.  Some videos
        # (ep 39/47 historically) have VTTs whose <c> tags only cover
        # part of the clip; without a tail fallback, we'd lose minutes
        # of subtitles silently — see _hybrid_subtitle_split docstring.
        all_word_times, all_turns = _caption_word_timings(raw_vtt)
        # Subtitles begin at the exact snapped boundary, which can sit up to a
        # second after the clip's whole-second start — see _record_boundary.
        # The rebase origin stays seg_start_ms either way, so timings still
        # line up with the <video> element's currentTime.
        #
        # The boundary is only trusted inside the second it belongs to. Bounds
        # enforcement and ad trimming both move `start` afterwards without
        # knowing about it, and a stale boundary sitting 20s into the clip
        # would silently swallow the first 20s of subtitles — so anything that
        # doesn't line up with the current start is simply ignored.
        ai_start_ms = int(seg.get("start", seg_start)) * 1000
        boundary_ms = int(seg.get("start_boundary_ms") or 0)
        subs_from_ms = (
            boundary_ms if ai_start_ms <= boundary_ms < ai_start_ms + 1000
            else seg_start_ms
        )
        clip_word_times = [
            (w, t - seg_start_ms)
            for (w, t) in all_word_times
            if subs_from_ms <= t < clip_end_abs_ms
        ]
        clip_turns = [
            t - seg_start_ms for t in all_turns if subs_from_ms <= t < clip_end_abs_ms
        ]
        clip_end_ms = clip_end_abs_ms - seg_start_ms
        # Pre-rebase yt_subs for the same window so the hybrid splitter
        # has a comparable cue list.  Kept even if word_times alone
        # already cover the clip — _hybrid_subtitle_split decides.
        yt_cues_clip = [
            (s[0] - seg_start_ms, s[1] - seg_start_ms, s[2])
            for s in (yt_subs or [])
            if s[0] >= seg_start_ms and s[0] < clip_end_abs_ms
        ]
        rows, coverage = _hybrid_subtitle_split(
            clip_word_times, yt_cues_clip, clip_end_ms, turn_starts_ms=clip_turns,
        )
        if coverage < 0.7:
            log.warning(
                "subtitle coverage low: %.0f%% (clip %dms, primary covered %dms) — "
                "tail filled from %d yt cues",
                coverage * 100, clip_end_ms,
                int(coverage * clip_end_ms),
                len(yt_cues_clip),
            )
        sub_rows = [(s, e, text, "") for (s, e, text, _wt) in rows]
        row_word_timings = [wt for (_s, _e, _t, wt) in rows]
        needs_translate = bool(sub_rows)
    elif yt_subs:
        # No raw VTT at all (very rare path) — use plain cues directly.
        sub_rows = [
            (s[0] - seg_start_ms, s[1] - seg_start_ms, s[2], s[3])
            for s in yt_subs
            if s[0] >= seg_start_ms and s[0] < clip_end_abs_ms
        ]
        row_word_timings = [[] for _ in sub_rows]
        needs_translate = bool(sub_rows)
    elif video_path:
        whisper_rows = await asyncio.to_thread(_try_whisper_transcribe, video_path)
        if whisper_rows:
            sub_rows = whisper_rows
            row_word_timings = [[] for _ in sub_rows]
            needs_translate = True

    if not sub_rows:
        # No captions from YouTube AND whisper returned nothing — refuse to
        # publish an episode with the hard-coded CANNED_SUBS demo content.
        raise RuntimeError(
            f"无法获取字幕（片段 {seg_start}-{seg_end}s）。"
            "YouTube 未提供字幕且 Whisper 转写为空，请重试或换一个视频。"
        )

    if llm.has_credentials() and needs_translate:
        sub_rows = await asyncio.to_thread(_translate_to_zh, sub_rows)

    # --- Stage 4: chunks ---
    # Up to 3 attempts with 180s timeout each. extract_chunks returns []
    # when the LLM flakes (truncated JSON, parse failure, nothing matched
    # by the stub canned phrases), which used to silently create an Episode
    # with chunks_count=0. Retry gives DeepSeek a second/third chance;
    # hard-fail after 3 so the task surfaces an actual error instead.
    await mark(4, "chunking", 65)
    full_en = " ".join(r[2] for r in sub_rows)
    chunk_data: list[dict] = []
    for attempt in range(1, 4):
        try:
            chunk_data = await asyncio.wait_for(
                asyncio.to_thread(llm.extract_chunks, full_en), timeout=180,
            )
        except asyncio.TimeoutError:
            log.warning("extract_chunks attempt %d/3 timed out", attempt)
            continue
        if chunk_data:
            if attempt > 1:
                log.info("extract_chunks recovered on attempt %d", attempt)
            break
        log.warning("extract_chunks attempt %d/3 returned empty", attempt)
    if not chunk_data:
        raise RuntimeError(
            "Chunk 提取失败：LLM 三次尝试都返回空列表（可能是 LLM 服务不稳定或返回格式被截断）。请重试。"
        )

    # --- Stage 5a: dialog + clip summary ---
    await mark(5, "dialoging", 85)
    target_texts = [c["text"] for c in chunk_data]
    try:
        scenario, _ = await asyncio.wait_for(
            asyncio.to_thread(
                llm.design_scenario, title_fallback, summary_fallback, target_texts
            ), timeout=180,
        )
    except asyncio.TimeoutError:
        raise RuntimeError("对话脚本生成超时（LLM 无响应超过 3 分钟）。请重试。")

    # Generate a clip-specific summary instead of using the full YouTube description.
    # Creator name + clip title flow into the prompt so the Chinese intro
    # opens in friend-recommending-friend tone ("Mel Robbins 又来开炮了…")
    # rather than press-release academic ("In this clip, Mel discusses…").
    clip_creator_name = (meta or {}).get("channel", "") if isinstance(meta, dict) else ""
    clip_summary_en = summary_fallback
    summary_zh = ""
    try:
        en, zh = await asyncio.wait_for(
            asyncio.to_thread(
                llm.summarize_clip, full_en, clip_creator_name, title_fallback,
            ), timeout=120,
        )
        if en:
            clip_summary_en = en
        if zh:
            summary_zh = zh
    except asyncio.TimeoutError:
        log.warning("clip summary timed out; using YouTube description")

    # Lesson Brief: pre-generated study card shown above the AI chat.
    # Soft-fail by design — if the LLM flakes here, the episode still ships
    # without a brief (frontend hides the card; admin can regenerate later
    # via the /regenerate-lesson-brief endpoint). Don't let this block
    # publishing: we already have chunks + scenario + summary.
    lesson_brief: dict | None = None
    try:
        lesson_brief = await asyncio.wait_for(
            asyncio.to_thread(
                llm.generate_lesson_brief,
                full_en,
                target_texts,
                clip_creator_name,
                title_fallback,
            ),
            timeout=120,
        )
    except asyncio.TimeoutError:
        log.warning("lesson brief timed out; episode will ship without it")
    except Exception as e:
        log.warning("lesson brief generation failed (non-fatal): %s", e)

    # --- Stage 5b: persist ---
    await mark(5, "persisting", 95)

    cat_id = params.get("category_id")
    if cat_id and not await db.get(Category, cat_id):
        cat_id = None
    sp_id = params.get("speaker_id")
    if sp_id:
        from ..models import Speaker
        if not await db.get(Speaker, sp_id):
            sp_id = None

    # Auto-bind Creator from yt-dlp channel info if admin didn't pick one.
    # Idempotent: same channel_id always maps to the same Speaker row, so
    # re-imports and additional episodes from the same channel collapse
    # into one creator on /catalog?creator=… and the Creator hub page.
    if sp_id is None and isinstance(meta, dict):
        ch_id = (meta.get("channel_id") or "").strip()
        ch_name = (meta.get("channel") or "").strip()
        if ch_id or ch_name:
            from ..models import Speaker
            from sqlalchemy import select as _select
            sp_row = None
            if ch_id:
                sp_row = (await db.execute(
                    _select(Speaker).where(Speaker.channel_id == ch_id)
                )).scalar_one_or_none()
            if sp_row is None and ch_name:
                # Fallback for channels yt-dlp didn't expose an ID for —
                # match by name so we don't fork the row.
                sp_row = (await db.execute(
                    _select(Speaker).where(Speaker.name == ch_name)
                )).scalar_one_or_none()
            if sp_row is None:
                handle = (meta.get("uploader_handle") or "").strip()
                if handle and not handle.startswith("@"):
                    handle = "@" + handle
                sp_row = Speaker(
                    name=ch_name or (handle.lstrip("@") if handle else "Unknown"),
                    handle=handle or "",
                    channel_id=ch_id,
                    youtube_url=(meta.get("channel_url") or "").strip(),
                    default_accent=params.get("accent", "US"),
                )
                db.add(sp_row)
                await db.flush()
                log.info("created Speaker id=%s name=%r channel_id=%s",
                         sp_row.id, sp_row.name, ch_id or "(none)")
            elif ch_id and not sp_row.channel_id:
                # Backfill channel_id on a row created by name-match before.
                sp_row.channel_id = ch_id
                await db.flush()
            sp_id = sp_row.id

    # LLM auto-classify category (format) + topic (subject).  Admin's
    # explicit category_id wins if set; otherwise we use the LLM's
    # category slug.  Topic is always LLM-driven.
    auto_cat_slug, auto_topic, auto_subtopic = await asyncio.to_thread(
        llm.classify_episode, title_fallback, clip_summary_en or summary_fallback,
    )
    if cat_id is None and auto_cat_slug:
        from sqlalchemy import select as _select
        cat_row = (await db.execute(
            _select(Category).where(Category.slug == auto_cat_slug)
        )).scalar_one_or_none()
        if cat_row is not None:
            cat_id = cat_row.id

    # Req 1: when admin didn't supply explicit difficulty/accent, infer from
    # transcript. params.get(...) is None when the front-end now omits them
    # (after the auto-classify rollout); falls back to canned 3 / "US" if
    # LLM unavailable.
    full_transcript = " ".join(r[2] for r in sub_rows)
    channel_hint = (meta or {}).get("channel", "") if isinstance(meta, dict) else ""
    if params.get("difficulty") is None:
        difficulty_val = await asyncio.to_thread(llm.estimate_difficulty, full_transcript)
    else:
        difficulty_val = int(params["difficulty"])
    if params.get("accent") is None:
        accent_val = await asyncio.to_thread(llm.detect_accent, full_transcript, channel_hint)
    else:
        accent_val = str(params["accent"])

    # Pick one sentence-pattern lesson for the Learn page Chunks tab.
    # Soft-fails: if LLM is down or returns garbage, episode just doesn't
    # show the card (frontend hides when key is missing).
    sentence_pattern = None
    try:
        pattern_subs = [(i + 1, en) for i, (_, _, en, _) in enumerate(sub_rows)]
        sentence_pattern = await asyncio.wait_for(
            asyncio.to_thread(
                llm.pick_sentence_pattern,
                title_fallback, clip_summary_en or summary_fallback, pattern_subs,
            ),
            timeout=120,
        )
    except Exception as e:
        log.warning("sentence pattern generation failed (soft): %s", e)

    # For full-video collections, the segment carries an LLM-generated
    # title ("Claude Code 初始化") that beats the raw episode title +
    # numeric suffix.  Fall back to the standard "{title} #i/N" pattern
    # if no override or it's empty.
    if segment_title_override and segment_title_override.strip():
        ep_title = f"{seg_label}{segment_title_override.strip()} - {title_fallback}"
    else:
        ep_title = f"{seg_label}{title_fallback}"
    # Likewise stash the LLM topic blurb (if any) in ai_metadata so the
    # collection page can show "this segment is about: ..." without a
    # second LLM call.
    seg_meta: dict = {
        "source_start": seg_start,
        "source_end": seg_end,
        "reason": seg.get("reason", ""),
        "source": "youtube_caps" if yt_subs else ("whisper" if video_path else "stub"),
        "full_duration": full_duration,
    }
    if segment_topic_zh:
        seg_meta["topic_zh"] = segment_topic_zh

    ep = Episode(
        title=ep_title,
        summary=clip_summary_en,
        youtube_url=task.youtube_url,
        video_url=video_url,
        video_codec=video_codec,
        thumbnail_url=thumbnail,
        duration_sec=duration,
        category_id=cat_id,
        speaker_id=sp_id,
        topic=auto_topic or "other",
        subtopic=auto_subtopic or "",
        accent=accent_val,
        difficulty=difficulty_val,
        subtitles_count=len(sub_rows),
        chunks_count=len(chunk_data),
        # Default: land in reviewing so admin can QA before users see it.
        # Override with FULL_MODE_AUTO_PUBLISH=true to skip the review step
        # for full-mode imports — useful when admin trusts the LLM splits
        # and wants the collection live the moment pipeline finishes.
        # Highlight (1-N hand-picked) imports always start in reviewing,
        # since they're usually the result of an editorial decision.
        status=(
            "published"
            if (collection_kind == "full"
                and os.getenv("FULL_MODE_AUTO_PUBLISH", "").lower() in ("1", "true", "yes"))
            else "reviewing"
        ),
        published_at=datetime.now(timezone.utc),
        collection_kind=collection_kind,
        segment_index=(seg_idx + 1) if collection_kind else None,
        ai_metadata={
            "pipeline": "v2",
            "scenario": scenario,
            "summary_zh": summary_zh,
            "real_download": real_download,
            "lesson_brief": lesson_brief,
            "sentence_pattern": sentence_pattern,
            "segment": seg_meta,
        },
    )
    db.add(ep)
    await db.flush()

    # Insert chunks first so we have IDs for chunk_refs back-fill.
    chunk_objs: list[Chunk] = []
    for c in chunk_data:
        if isinstance(c.get("text"), str):
            c["text"] = normalize_proper_nouns(c["text"])
        if "similar_expressions" in c:
            c["similar_expressions"] = normalize_list(c["similar_expressions"])
        if "common_collocations" in c:
            c["common_collocations"] = normalize_list(c["common_collocations"])
        obj = Chunk(episode_id=ep.id, **c)
        db.add(obj)
        chunk_objs.append(obj)
    await db.flush()  # assigns chunk IDs

    # Word-level timings for phrase-level highlighting: we already computed
    # them row-by-row during sentence splitting (row_word_timings is parallel
    # to sub_rows).  Fall back to empty list when the row came from whisper
    # or CANNED_SUBS.
    for i, (start, end, en, zh) in enumerate(sub_rows, start=1):
        en = normalize_proper_nouns(en)
        en_lower = en.lower()
        refs = [co.id for co in chunk_objs if co.text.lower() in en_lower]
        wt = row_word_timings[i - 1] if i - 1 < len(row_word_timings) else []
        db.add(Subtitle(
            episode_id=ep.id, seq=i,
            start_ms=start, end_ms=end, text_en=en, text_zh=zh,
            chunk_refs=refs, word_timings=wt,
        ))

    if seg_idx == 0:
        task.episode_id = ep.id

    # Update the segment record with the produced episode_id
    sel = dict(task.selected_segment or {})
    segs = list(sel.get("segments") or [])
    if seg_idx < len(segs):
        segs[seg_idx]["episode_id"] = ep.id
        sel["segments"] = segs
        task.selected_segment = sel

    await db.commit()
    log.info("segment %d/%d → episode %d", seg_idx + 1, n_segments, ep.id)
    return ep


# ============ Chapters mode: full-video processor (stages 3-5 + chapters) ============
async def _process_full_video(
    db: AsyncSession,
    task: "ImportTask",
    mark,
    yt_subs: list[tuple[int, int, str, str]],
    meta: dict | None,
    params: dict,
    title_fallback: str,
    summary_fallback: str,
    thumbnail: str,
    full_duration: int,
):
    """Chapters-mode pipeline path (mode='chapters').

    Keeps the whole video intact (no clipping), generates chapter markers
    via the LLM, extracts a denser chunk pool (up to 18), runs one whole-
    video scenario for the AI conversation, and writes an Episode with
    import_mode='chapters' + N episode_chapters rows.

    Parallel structure with _process_segment intentional — they share most
    of the "extract chunks → design scenario → classify → persist" tail —
    but the head differs (download, subtitle timeline, chapter generation)
    enough that interleaving the two would obscure both. Hard-fails on
    download / no-captions / empty chunks / empty chapters: a chapters
    episode without chapters is a degenerate UX the catalog shouldn't ship.
    """
    # --- Stage 2 (continued): chapter markers from full transcript ---
    sub_dicts = [
        {"start_sec": s[0] / 1000, "end_sec": s[1] / 1000, "text_en": s[2]}
        for s in yt_subs
    ] if yt_subs else []
    chapters_data: list[dict] = []
    if sub_dicts:
        chapters_data = await asyncio.to_thread(
            llm.split_into_chapters, sub_dicts, full_duration,
        )
        log.info("chapters mode: LLM produced %d chapter markers", len(chapters_data))
    if not chapters_data:
        # Without captions the chapter LLM has nothing to read; the rest
        # of the pipeline depends on captions anyway, so this is fatal.
        raise RuntimeError(
            "章节生成失败：未获取到字幕或 LLM 返回空。请检查 YouTube 字幕是否可用。"
        )

    # --- Stage 3a: download FULL video ---
    await mark(3, "downloading_full", 30)
    video_path: str | None = None
    yt_error: str | None = None
    try:
        video_path, yt_error = await asyncio.wait_for(
            asyncio.to_thread(
                _try_ytdlp_download_full, task.youtube_url, MEDIA_DIR, task.id
            ),
            # 700s = 600s inner timeout + 100s slack for ffmpeg remux + IO.
            timeout=700,
        )
    except asyncio.TimeoutError:
        log.warning("full-video download outer timeout (700s) tripped")
        yt_error = "outer timeout 700s exceeded"

    if not video_path:
        friendly = _classify_ytdlp_error(yt_error or "")
        raw_suffix = f"（yt-dlp: {yt_error[:120]}）" if yt_error else ""
        raise RuntimeError(f"完整视频下载失败：{friendly}{raw_suffix}")
    video_url = f"/media/{Path(video_path).name}"
    video_codec = probe_video_codec(video_path)[0]

    # --- Stage 3b: subtitles — keep the full-video timeline, no rebase ---
    await mark(3, "transcribing", 50)
    sub_rows: list[tuple[int, int, str, str]] = []
    row_word_timings: list[list[list]] = []
    needs_translate = False
    raw_vtt = (meta or {}).get("vtt_raw", "") if isinstance(meta, dict) else ""

    if raw_vtt:
        # Same hybrid splitter as segment mode, but with the FULL clip
        # window so we cover the whole video.  No rebase delta (offset=0).
        all_word_times, all_turns = _caption_word_timings(raw_vtt)
        clip_end_ms = full_duration * 1000 if full_duration else (
            max((t for _, t in all_word_times), default=0) + 1000
        )
        yt_cues_clip = [(s[0], s[1], s[2]) for s in (yt_subs or [])]
        rows, coverage = _hybrid_subtitle_split(
            all_word_times, yt_cues_clip, clip_end_ms, turn_starts_ms=all_turns,
        )
        if coverage < 0.7:
            log.warning(
                "chapters mode subtitle coverage low: %.0f%%", coverage * 100,
            )
        sub_rows = [(s, e, text, "") for (s, e, text, _wt) in rows]
        row_word_timings = [wt for (_s, _e, _t, wt) in rows]
        needs_translate = bool(sub_rows)
    elif yt_subs:
        sub_rows = [(s[0], s[1], s[2], s[3]) for s in yt_subs]
        row_word_timings = [[] for _ in sub_rows]
        needs_translate = bool(sub_rows)
    elif video_path:
        whisper_rows = await asyncio.to_thread(_try_whisper_transcribe, video_path)
        if whisper_rows:
            sub_rows = whisper_rows
            row_word_timings = [[] for _ in sub_rows]
            needs_translate = True

    if not sub_rows:
        raise RuntimeError(
            "无法获取字幕（完整视频）。"
            "YouTube 未提供字幕且 Whisper 转写为空，请重试或换一个视频。"
        )

    if llm.has_credentials() and needs_translate:
        sub_rows = await asyncio.to_thread(_translate_to_zh, sub_rows)

    # --- Stage 4: chunks (denser pool — 12-18 for a longer transcript) ---
    await mark(4, "chunking", 65)
    full_en = " ".join(r[2] for r in sub_rows)
    chunk_data: list[dict] = []
    for attempt in range(1, 4):
        try:
            chunk_data = await asyncio.wait_for(
                asyncio.to_thread(llm.extract_chunks, full_en, 18), timeout=240,
            )
        except asyncio.TimeoutError:
            log.warning("extract_chunks (chapters) attempt %d/3 timed out", attempt)
            continue
        if chunk_data:
            if attempt > 1:
                log.info("extract_chunks (chapters) recovered on attempt %d", attempt)
            break
        log.warning("extract_chunks (chapters) attempt %d/3 returned empty", attempt)
    if not chunk_data:
        raise RuntimeError(
            "Chunk 提取失败（章节模式）：LLM 三次尝试都返回空列表。请重试。"
        )

    # --- Stage 5a: ONE scenario for the whole video + summary + brief ---
    await mark(5, "dialoging", 85)
    target_texts = [c["text"] for c in chunk_data]
    try:
        scenario, _ = await asyncio.wait_for(
            asyncio.to_thread(
                llm.design_scenario, title_fallback, summary_fallback, target_texts,
            ), timeout=180,
        )
    except asyncio.TimeoutError:
        raise RuntimeError("对话脚本生成超时（章节模式）。请重试。")

    clip_creator_name = (meta or {}).get("channel", "") if isinstance(meta, dict) else ""
    clip_summary_en = summary_fallback
    summary_zh = ""
    try:
        en, zh = await asyncio.wait_for(
            asyncio.to_thread(
                llm.summarize_clip, full_en, clip_creator_name, title_fallback,
            ), timeout=180,
        )
        if en:
            clip_summary_en = en
        if zh:
            summary_zh = zh
    except asyncio.TimeoutError:
        log.warning("chapters summary timed out; using YouTube description")

    lesson_brief: dict | None = None
    try:
        lesson_brief = await asyncio.wait_for(
            asyncio.to_thread(
                llm.generate_lesson_brief,
                full_en, target_texts, clip_creator_name, title_fallback,
            ),
            timeout=150,
        )
    except asyncio.TimeoutError:
        log.warning("chapters lesson brief timed out; episode will ship without it")
    except Exception as e:
        log.warning("chapters lesson brief failed (non-fatal): %s", e)

    # --- Stage 5b: persist Episode + chapters + chunks + subtitles ---
    await mark(5, "persisting", 95)

    cat_id = params.get("category_id")
    if cat_id and not await db.get(Category, cat_id):
        cat_id = None
    sp_id = params.get("speaker_id")
    if sp_id:
        from ..models import Speaker
        if not await db.get(Speaker, sp_id):
            sp_id = None

    if sp_id is None and isinstance(meta, dict):
        # Same auto-bind logic as _process_segment — kept in line rather
        # than refactored to avoid mid-PR cross-mode regression risk.
        ch_id = (meta.get("channel_id") or "").strip()
        ch_name = (meta.get("channel") or "").strip()
        if ch_id or ch_name:
            from ..models import Speaker
            from sqlalchemy import select as _select
            sp_row = None
            if ch_id:
                sp_row = (await db.execute(
                    _select(Speaker).where(Speaker.channel_id == ch_id)
                )).scalar_one_or_none()
            if sp_row is None and ch_name:
                sp_row = (await db.execute(
                    _select(Speaker).where(Speaker.name == ch_name)
                )).scalar_one_or_none()
            if sp_row is None:
                handle = (meta.get("uploader_handle") or "").strip()
                if handle and not handle.startswith("@"):
                    handle = "@" + handle
                sp_row = Speaker(
                    name=ch_name or (handle.lstrip("@") if handle else "Unknown"),
                    handle=handle or "",
                    channel_id=ch_id,
                    youtube_url=(meta.get("channel_url") or "").strip(),
                    default_accent=params.get("accent", "US"),
                )
                db.add(sp_row)
                await db.flush()
            elif ch_id and not sp_row.channel_id:
                sp_row.channel_id = ch_id
                await db.flush()
            sp_id = sp_row.id

    auto_cat_slug, auto_topic, auto_subtopic = await asyncio.to_thread(
        llm.classify_episode, title_fallback, clip_summary_en or summary_fallback,
    )
    if cat_id is None and auto_cat_slug:
        from sqlalchemy import select as _select
        cat_row = (await db.execute(
            _select(Category).where(Category.slug == auto_cat_slug)
        )).scalar_one_or_none()
        if cat_row is not None:
            cat_id = cat_row.id

    channel_hint = (meta or {}).get("channel", "") if isinstance(meta, dict) else ""
    if params.get("difficulty") is None:
        difficulty_val = await asyncio.to_thread(llm.estimate_difficulty, full_en)
    else:
        difficulty_val = int(params["difficulty"])
    if params.get("accent") is None:
        accent_val = await asyncio.to_thread(llm.detect_accent, full_en, channel_hint)
    else:
        accent_val = str(params["accent"])

    sentence_pattern = None
    try:
        pattern_subs = [(i + 1, en) for i, (_, _, en, _) in enumerate(sub_rows)]
        sentence_pattern = await asyncio.wait_for(
            asyncio.to_thread(
                llm.pick_sentence_pattern,
                title_fallback, clip_summary_en or summary_fallback, pattern_subs,
            ),
            timeout=120,
        )
    except Exception as e:
        log.warning("chapters sentence pattern failed (soft): %s", e)

    ep = Episode(
        title=title_fallback,
        summary=clip_summary_en,
        youtube_url=task.youtube_url,
        video_url=video_url,
        video_codec=video_codec,
        thumbnail_url=thumbnail,
        duration_sec=full_duration,
        category_id=cat_id,
        speaker_id=sp_id,
        topic=auto_topic or "other",
        subtopic=auto_subtopic or "",
        accent=accent_val,
        difficulty=difficulty_val,
        subtitles_count=len(sub_rows),
        chunks_count=len(chunk_data),
        status="reviewing",
        published_at=datetime.now(timezone.utc),
        import_mode="chapters",
        ai_metadata={
            "pipeline": "v2",
            "scenario": scenario,
            "summary_zh": summary_zh,
            "real_download": True,
            "lesson_brief": lesson_brief,
            "sentence_pattern": sentence_pattern,
            "source": "youtube_caps" if yt_subs else (
                "whisper" if video_path else "stub"
            ),
            "full_duration": full_duration,
        },
    )
    db.add(ep)
    await db.flush()

    # Chapters rows — order_idx is 1-based so the UI can render "#3 · ..."
    # without recomputing the position from the array index.
    for i, ch in enumerate(chapters_data, start=1):
        # Clamp into the actual video span so a LLM-hallucinated end past
        # the file duration doesn't break the seek bar logic.
        ch_start_ms = max(0, int(ch["start"]) * 1000)
        ch_end_ms = int(ch["end"]) * 1000
        if full_duration:
            ch_end_ms = min(ch_end_ms, full_duration * 1000)
        if ch_end_ms <= ch_start_ms:
            continue
        db.add(EpisodeChapter(
            episode_id=ep.id,
            order_idx=i,
            start_ms=ch_start_ms,
            end_ms=ch_end_ms,
            title_en=str(ch.get("title_en", ""))[:255],
            title_zh=str(ch.get("title_zh", ""))[:255],
            summary_zh=str(ch.get("summary_zh", "")),
        ))

    # Insert chunks first so we have IDs for chunk_refs back-fill.
    chunk_objs: list[Chunk] = []
    for c in chunk_data:
        if isinstance(c.get("text"), str):
            c["text"] = normalize_proper_nouns(c["text"])
        if "similar_expressions" in c:
            c["similar_expressions"] = normalize_list(c["similar_expressions"])
        if "common_collocations" in c:
            c["common_collocations"] = normalize_list(c["common_collocations"])
        obj = Chunk(episode_id=ep.id, **c)
        db.add(obj)
        chunk_objs.append(obj)
    await db.flush()

    # Subtitles: timeline is the original full-video one (no rebase).
    for i, (start, end, en, zh) in enumerate(sub_rows, start=1):
        en = normalize_proper_nouns(en)
        en_lower = en.lower()
        refs = [co.id for co in chunk_objs if co.text.lower() in en_lower]
        wt = row_word_timings[i - 1] if i - 1 < len(row_word_timings) else []
        db.add(Subtitle(
            episode_id=ep.id, seq=i,
            start_ms=start, end_ms=end, text_en=en, text_zh=zh,
            chunk_refs=refs, word_timings=wt,
        ))

    task.episode_id = ep.id
    await db.commit()
    log.info(
        "chapters mode: episode %d created with %d chapters, %d chunks, %d subs",
        ep.id, len(chapters_data), len(chunk_data), len(sub_rows),
    )
    return ep


# ============ Full-video mode: parallel stage 3-5 across N segments ============
SEGMENT_RETRY_DELAY_SEC = 10


async def _run_highlight_segments(
    db: AsyncSession,
    task: ImportTask,
    mark,
    segments: list[dict],
    yt_subs: list[tuple[int, int, str, str]],
    meta: dict | None,
    params: dict,
    title_fallback: str,
    summary_fallback: str,
    thumbnail: str,
    full_duration: int,
) -> tuple[int, list[str]]:
    """Run stages 3-5 for each highlight segment, isolating failures.

    Returns `(succeeded, failure_messages)` and raises only when EVERY
    segment failed.

    Importing 5 windows out of a 1.5h video means 5 independent ranged
    downloads, and YouTube throttles then drops those often enough that at
    least one usually dies. The old inline loop let that exception escape
    run_pipeline: the whole import went `failed` even though earlier
    segments had already produced perfectly good episodes, and the
    remaining segments never ran at all. Full mode has had isolation for a
    while (_run_full_video_segments); highlight mode now matches it.

    Sequential on purpose. Parallel segments would write the same
    _DL_PROGRESS slot (it is keyed by task, not segment) and garble the
    live byte counter, and the "[3/5] downloading" status prefix only
    reads correctly with one segment in flight.
    """
    n = len(segments)
    failures: list[str] = []
    done = 0
    for idx, seg in enumerate(segments):
        label = f"[{idx + 1}/{n}]"
        for attempt in (1, 2):
            try:
                await _process_segment(
                    db, task, mark, seg, yt_subs, meta, params,
                    title_fallback, summary_fallback, thumbnail,
                    full_duration, seg_idx=idx, n_segments=n,
                )
                done += 1
                break
            except Exception as e:
                # One retry, because the common failure — YouTube throttling
                # a range request to zero and dropping it — is transient:
                # the URL that died on "ffmpeg exited with code 187"
                # downloaded fine minutes later.
                if attempt == 1:
                    log.warning(
                        "segment %s failed (%s); retrying once",
                        label, str(e)[:200],
                    )
                    await _recover_session(db, task)
                    await asyncio.sleep(SEGMENT_RETRY_DELAY_SEC)
                    continue
                log.exception("segment %s failed twice", label)
                await _recover_session(db, task)
                failures.append(f"{label} {str(e)[:160]}")

    if not done:
        raise RuntimeError("全部 %d 段都失败：%s" % (n, "；".join(failures)))
    if failures:
        # Partial success is still success: the episodes that made it are
        # usable now, and the admin can retry the URL for the rest instead
        # of redoing all of it.
        task.error = "%d/%d 段成功，失败的：%s" % (done, n, "；".join(failures))
        log.warning("import %s partial: %s", task.id, task.error)
    return done, failures


async def _run_full_video_segments(
    task_id: int,
    segments: list[dict],
    yt_subs: list[tuple[int, int, str, str]],
    meta: dict | None,
    params: dict,
    title_fallback: str,
    summary_fallback: str,
    thumbnail: str,
    full_duration: int,
):
    """Run stage 3-5 for every segment of a full-video import in parallel.

    Concurrency is capped at 3 so we don't hammer LLM rate limits or
    saturate yt-dlp. Each segment runs in its own AsyncSession because
    SQLAlchemy AsyncSession is single-tasking — sharing the parent
    pipeline's session across gather() would race on flush/commit.

    Failures on individual segments are caught and logged so one bad
    segment doesn't kill the rest of the collection. The task surfaces
    `failed_segments` count on the log; admin can re-import or delete.
    """
    n = len(segments)
    sem = asyncio.Semaphore(3)
    task_lock = asyncio.Lock()  # serialise task.selected_segment writes
    done_count = 0
    failed: list[tuple[int, str]] = []

    async def runner(idx: int, seg: dict):
        nonlocal done_count
        async with sem:
            try:
                async with SessionLocal() as sub_db:
                    sub_task = await sub_db.get(ImportTask, task_id)
                    if not sub_task:
                        return

                    # Per-segment mark closure — no-ops on stage/status since
                    # the orchestrator owns those; only progress is updated
                    # by the outer loop after each segment completes.
                    async def _no_mark(stage, status, progress, **extra):
                        # Still useful as a logging hook; commit nothing here.
                        return

                    ep = await _process_segment(
                        sub_db, sub_task, _no_mark, seg, yt_subs, meta, params,
                        title_fallback, summary_fallback, thumbnail, full_duration,
                        seg_idx=idx, n_segments=n,
                        collection_kind="full",
                        segment_title_override=seg.get("title"),
                        segment_topic_zh=seg.get("topic_zh"),
                    )
                    log.info("full-mode segment %d/%d done → episode %s",
                             idx + 1, n, ep.id if ep else "?")
            except Exception as e:
                log.exception("full-mode segment %d/%d FAILED: %s", idx + 1, n, e)
                failed.append((idx + 1, str(e)[:200]))

        # Update progress on the parent task using a fresh session +
        # lock so two parallel tasks don't trample each other.
        async with task_lock:
            done_count += 1
            try:
                async with SessionLocal() as upd_db:
                    upd_task = await upd_db.get(ImportTask, task_id)
                    if upd_task:
                        upd_task.progress = 30 + int((done_count / max(n, 1)) * 65)
                        upd_task.status = f"full_segment_{done_count}_of_{n}"
                        upd_task.log = list(upd_task.log or []) + [{
                            "stage": 5,
                            "status": f"segment_{idx + 1}_done",
                            "ts": time.time(),
                        }]
                        await upd_db.commit()
            except Exception:
                log.exception("progress update failed for task %d", task_id)

    await asyncio.gather(*(runner(i, s) for i, s in enumerate(segments)))

    if failed:
        # Surface partial failure on the task log so admin sees it without
        # digging through logs. The successful episodes are already in the DB.
        async with SessionLocal() as final_db:
            ft = await final_db.get(ImportTask, task_id)
            if ft:
                ft.log = list(ft.log or []) + [{
                    "stage": 5,
                    "status": "partial_failure",
                    "ts": time.time(),
                    "failed_segments": failed,
                }]
                await final_db.commit()


# ============ Phase 2: process approved segments (called by admin approve) ============
async def run_pipeline_phase2(
    db: AsyncSession, task_id: int, approved_segments: list[dict],
    llm_override=None,
):
    """Continue a task that was paused at pending_review. Downloads + processes
    each approved segment sequentially, creating one Episode per segment.

    `llm_override` is the approving admin's credentials — the second half of
    an import is billed the same way as the first."""
    task = await db.get(ImportTask, task_id)
    if not task:
        return
    with llm.use_override(llm_override):
        await _run_phase2_inner(db, task, task_id, approved_segments)


async def _run_phase2_inner(
    db: AsyncSession, task: ImportTask, task_id: int, approved_segments: list[dict],
):

    async def mark(stage: int, status: str, progress: int, **extra):
        task.stage = stage
        task.status = status
        task.progress = progress
        for k, v in extra.items():
            setattr(task, k, v)
        task.log = list(task.log) + [{"stage": stage, "status": status, "ts": time.time()}]
        await db.commit()

    try:
        # Restore state from phase 1
        stored = task.selected_segment or {}
        meta_info = stored.get("meta") or {}
        full_duration = stored.get("full_duration", 0)
        title_fallback = meta_info.get("title", "Imported Episode")
        summary_fallback = meta_info.get("description", "")
        thumbnail = meta_info.get("thumbnail", "")

        # Restore yt_subs from compact storage
        raw_subs = task.ai_segments or []
        yt_subs: list[tuple[int, int, str, str]] = [
            (int(s[0]), int(s[1]), str(s[2]), str(s[3] if len(s) > 3 else ""))
            for s in raw_subs if len(s) >= 3
        ]
        # Bug 3 fix: pull raw_vtt back from disk so the hybrid sentence
        # splitter runs (gives word_timings + per-sentence rows, not raw
        # cue rows). Empty string falls through to the cue-only branch.
        raw_vtt = _load_vtt_for_task(task.id)
        meta: dict | None = (
            {"title": title_fallback, "vtt_raw": raw_vtt} if yt_subs else None
        )

        params = {
            "accent": "US",
            "difficulty": 3,
            "category_id": None,
            "speaker_id": None,
        }

        n = len(approved_segments)
        # Update task's segments to match approved (possibly adjusted) list
        task.selected_segment = {
            "segments": approved_segments,
            "full_duration": full_duration,
            "meta": meta_info,
        }
        await db.commit()

        for idx, seg in enumerate(approved_segments):
            log.info("processing segment %d/%d: %s-%s", idx + 1, n, seg["source_start"], seg["source_end"])
            await _process_segment(
                db, task, mark, seg, yt_subs, meta, params,
                title_fallback, summary_fallback, thumbnail, full_duration,
                seg_idx=idx, n_segments=n,
            )

        await mark(5, "reviewing", 100)
    except Exception as e:
        log.exception("pipeline phase 2 failed: %s", e)
        try:
            await db.rollback()
        except Exception:
            pass
        fresh_task = await db.get(ImportTask, task_id)
        if fresh_task:
            fresh_task.status = "failed"
            fresh_task.error = str(e)[:500]
            fresh_task.log = list(fresh_task.log or []) + [
                {"stage": fresh_task.stage, "status": "failed",
                 "ts": time.time(), "error": str(e)[:200]}
            ]
            try:
                await db.commit()
            except Exception:
                log.exception("failed to persist failure status")
