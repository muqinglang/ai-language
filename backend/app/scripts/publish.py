"""Stage 6 — upload a bundle directory to a (remote or local) justSpeak API.

Reads ``<bundle_dir>/manifest.json`` + the referenced media files and POSTs
them as one multipart request to ``/api/admin/import-bundle``. Each file part's
filename is set to the manifest-relative path so the server matches bytes to
segment.

Runs on the local Mac to publish to the mainland ECS:

    python -m app.scripts.publish out/XXXX \\
        --api https://api.your-domain.example --user admin --password ****

Or locally for E2E testing (talks to the dev api on localhost:8000):

    docker exec justspeak-api python -m app.scripts.publish /app/out/XXXX \\
        --api http://localhost:8000 --user admin --password <admin-password>

Env fallbacks: JUSTSPEAK_API, JUSTSPEAK_TOKEN.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import httpx


def _login(api: str, user: str, password: str) -> str:
    r = httpx.post(
        f"{api.rstrip('/')}/api/auth/login",
        json={"username": user, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    tok = r.json().get("access_token", "")
    if not tok:
        raise SystemExit("login returned no access_token")
    return tok


def publish(bundle_dir: Path, api: str, token: str, force: bool, publish: bool = False) -> dict:
    manifest_path = bundle_dir / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"no manifest.json in {bundle_dir}")
    manifest_raw = manifest_path.read_text(encoding="utf-8")
    manifest = json.loads(manifest_raw)

    # Collect every referenced media file, keyed by its manifest-relative path.
    rel_paths: list[str] = []
    for seg in manifest.get("segments", []):
        rel_paths.append(seg["video_file"])
        if seg.get("thumb_file"):
            rel_paths.append(seg["thumb_file"])

    open_files = []
    files = []
    try:
        for rel in rel_paths:
            fp = bundle_dir / rel
            if not fp.exists():
                raise SystemExit(f"bundle references missing file: {rel}")
            fh = fp.open("rb")
            open_files.append(fh)
            ctype = "video/mp4" if rel.endswith(".mp4") else "image/jpeg"
            # field name must be "files"; filename carries the manifest path.
            files.append(("files", (rel, fh, ctype)))

        data = {
            "manifest": manifest_raw,
            "force": "true" if force else "false",
            "publish": "true" if publish else "false",
        }
        total_mb = sum((bundle_dir / r).stat().st_size for r in rel_paths) / (1024 * 1024)
        print(f"uploading {len(rel_paths)} file(s), {total_mb:.1f}MB → {api}")
        r = httpx.post(
            f"{api.rstrip('/')}/api/admin/import-bundle",
            data=data,
            files=files,
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(connect=30, read=600, write=600, pool=30),
        )
    finally:
        for fh in open_files:
            fh.close()

    if r.status_code == 409:
        raise SystemExit(
            f"already imported (409): {r.json().get('detail')}\n"
            f"  re-run with --force to import anyway."
        )
    r.raise_for_status()
    return r.json()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Publish a bundle to a justSpeak API.")
    ap.add_argument("bundle_dir", type=Path)
    ap.add_argument("--api", default=os.getenv("JUSTSPEAK_API", "http://localhost:8000"))
    ap.add_argument("--token", default=os.getenv("JUSTSPEAK_TOKEN", ""))
    ap.add_argument("--user", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--publish", action="store_true", help="set episodes to published on prod immediately")
    args = ap.parse_args(argv)

    token = args.token
    if not token:
        if not (args.user and args.password):
            raise SystemExit("provide --token, or --user + --password to log in")
        token = _login(args.api, args.user, args.password)

    result = publish(args.bundle_dir, args.api, token, args.force, args.publish)
    print(f"✓ published: {result['count']} episode(s) {result['episode_ids']}")
    for u in result.get("video_urls", []):
        print(f"  {u}")


if __name__ == "__main__":
    main(sys.argv[1:])
