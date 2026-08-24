"""One-shot backfill: download YouTube thumbnails to local /app/media/thumbs/
and rewrite each Episode.thumbnail_url to the relative /media/thumbs/<id>.jpg
path so the schema's field_validator can prepend MEDIA_BASE_URL at serialization.

Why a script (not a migration): the work is per-episode I/O — fetching
~30 jpgs from i.ytimg.com over the network — and the api pod is the
only place where both the network egress (Tokyo can reach YouTube)
and the disk volume (/app/media is bind-mounted) live.  Run from
inside the pod.

Behavior:
    - Walks every Episode row.
    - Skips rows where thumbnail_url is already a relative /media/thumbs/...
      path (idempotent — re-running this is cheap).
    - Skips rows where the youtube id can't be parsed (no fail-loud, just log).
    - Downloads the maxresdefault.jpg (whatever URL is on the row).
    - Saves to /app/media/thumbs/<id>.jpg, sets row.thumbnail_url=/media/thumbs/<id>.jpg.
    - Commits in one transaction at the end.

How to run on prod (from the dev mac):
    scp scripts/backfill-thumbnails.py root@<runner>:/tmp/
    ssh root@<runner>
    POD=$(KUBECONFIG=/tmp/kubeconfig kubectl -n justspeak get pod -l app=justspeak-app -o name | head -1 | sed s|pod/||)
    KUBECONFIG=/tmp/kubeconfig kubectl -n justspeak cp /tmp/backfill-thumbnails.py $POD:/tmp/ -c api
    KUBECONFIG=/tmp/kubeconfig kubectl -n justspeak exec $POD -c api -- python3 /tmp/backfill-thumbnails.py

Idempotent — safe to re-run after partial failures.
"""

from __future__ import annotations

import os
import re
import sys
import urllib.request
from pathlib import Path

# Run from /app inside the api container so the package imports resolve.
sys.path.insert(0, "/app")

from sqlalchemy import create_engine, select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.config import settings  # noqa: E402
from app.models import Episode  # noqa: E402

# The app uses AsyncSession everywhere; for a one-shot script without
# concurrency the sync engine keeps the code readable.  psycopg is
# already in requirements.txt (alongside asyncpg).  Swap the driver
# segment of the URL so SQLAlchemy picks the sync dialect.
_SYNC_URL = settings.database_url.replace("+asyncpg", "+psycopg")
engine_sync = create_engine(_SYNC_URL, pool_pre_ping=True)


THUMBS_DIR = Path("/app/media/thumbs")
THUMBS_DIR.mkdir(parents=True, exist_ok=True)


def extract_id(url: str) -> str:
    if not url:
        return ""
    for pat in (
        r"/vi/([A-Za-z0-9_-]{6,})/",
        r"[?&]v=([A-Za-z0-9_-]{6,})",
        r"youtu\.be/([A-Za-z0-9_-]{6,})",
        r"/embed/([A-Za-z0-9_-]{6,})",
    ):
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return ""


def download(url: str, dest: Path) -> bool:
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (justSpeak thumbnail backfill)"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
    except Exception as e:
        print(f"  fetch failed: {e}")
        return False
    if not data or len(data) < 1024:
        print(f"  response too small ({len(data) if data else 0} bytes); skip")
        return False
    dest.write_bytes(data)
    return True


def main() -> None:
    total = 0
    skipped = 0
    fixed = 0
    failed = 0

    with Session(engine_sync) as s:
        eps = s.execute(select(Episode)).scalars().all()
        for ep in eps:
            total += 1
            current = ep.thumbnail_url or ""

            # Already relative-pathed → nothing to do.
            if current.startswith("/media/thumbs/"):
                print(f"SKIP  ep {ep.id}: already local")
                skipped += 1
                continue

            yt_id = extract_id(current) or extract_id(ep.youtube_url or "")
            if not yt_id:
                print(f"FAIL  ep {ep.id}: no youtube id parseable from url={current!r}")
                failed += 1
                continue

            target = THUMBS_DIR / f"{yt_id}.jpg"

            # If the file's already on disk (admin re-imported maybe), trust it.
            if target.exists() and target.stat().st_size > 0:
                ep.thumbnail_url = f"/media/thumbs/{yt_id}.jpg"
                print(f"FIX   ep {ep.id}: {yt_id} (already on disk)")
                fixed += 1
                continue

            # Pick a download URL: the row's own thumbnail_url first, then
            # fall back to YouTube's well-known maxresdefault path.  The
            # well-known path occasionally 404s for shorts / paywalled
            # videos — `download` returns False and we count as failed.
            urls_to_try = []
            if current.startswith("http"):
                urls_to_try.append(current)
            urls_to_try.append(f"https://i.ytimg.com/vi/{yt_id}/maxresdefault.jpg")
            urls_to_try.append(f"https://i.ytimg.com/vi/{yt_id}/hqdefault.jpg")

            ok = False
            for u in urls_to_try:
                print(f"      trying {u}")
                if download(u, target):
                    ok = True
                    break

            if not ok:
                print(f"FAIL  ep {ep.id}: {yt_id} (all URLs failed)")
                failed += 1
                continue

            ep.thumbnail_url = f"/media/thumbs/{yt_id}.jpg"
            print(f"FIX   ep {ep.id}: {yt_id} ({target.stat().st_size} bytes)")
            fixed += 1

        s.commit()

    print()
    print(f"Summary: total={total} fixed={fixed} skipped={skipped} failed={failed}")


if __name__ == "__main__":
    main()
