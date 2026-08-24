#!/usr/bin/env bash
#
# One-shot remux of every existing /app/media/*.mp4 to faststart layout.
# Required for iOS Safari's <video> element to stream-play; older
# imports were produced before pipeline started doing this automatically.
#
# Why a script (not a migration): videos are 14–40 MB each and there
# are dozens of them.  Running this from the running api pod (where
# ffmpeg + the actual /app/media volume both already exist) is the
# fastest path; no need to copy bytes around.
#
# Behavior:
#   - Iterates /app/media/*.mp4
#   - For each file: peeks at the first 64 bytes; skips if `moov` is
#     already in there (already faststart) — no work, no rewrite.
#   - Otherwise remuxes with `-c copy -movflags +faststart` to a
#     sibling .tmp.mp4 and atomic-renames over the original.
#   - On ffmpeg failure: keeps original, logs and continues with next
#     file so a single bad asset doesn't stop the whole sweep.
#   - Prints a summary at the end (total / fixed / skipped / failed).
#
# How to run on prod (from the dev mac):
#   POD=$(ssh root@<runner> 'KUBECONFIG=/tmp/kubeconfig kubectl -n justspeak get pod -l app=app -o name | head -1')
#   ssh root@<runner> "KUBECONFIG=/tmp/kubeconfig kubectl -n justspeak cp scripts/backfill-faststart.sh $POD:/tmp/ -c api"
#   ssh root@<runner> "KUBECONFIG=/tmp/kubeconfig kubectl -n justspeak exec $POD -c api -- bash /tmp/backfill-faststart.sh"
#
# Idempotent — safe to re-run.  Once the pipeline change ships and
# every clip has been re-imported once, this script becomes obsolete.

set -uo pipefail

MEDIA_DIR="${1:-/app/media}"
total=0
fixed=0
skipped=0
failed=0

if [ ! -d "$MEDIA_DIR" ]; then
  echo "ERROR: media dir not found: $MEDIA_DIR" >&2
  exit 1
fi

shopt -s nullglob
for src in "$MEDIA_DIR"/*.mp4; do
  total=$((total + 1))
  name=$(basename "$src")

  # Check if first 1KB already contains the moov box (faststart already done).
  # `head -c 1024` reads the prefix; `grep -ao moov` finds the literal
  # 4-byte signature without binary-mode complaints.
  if head -c 1024 "$src" 2>/dev/null | grep -qao moov; then
    echo "SKIP  $name (already faststart)"
    skipped=$((skipped + 1))
    continue
  fi

  tmp="${src%.mp4}.tmp.mp4"
  if ffmpeg -y -loglevel error -i "$src" -c copy -movflags +faststart "$tmp" 2>/tmp/ffmpeg.err; then
    if [ -s "$tmp" ]; then
      mv -f "$tmp" "$src"
      fixed=$((fixed + 1))
      size=$(stat -c%s "$src" 2>/dev/null || stat -f%z "$src")
      echo "FIX   $name ($size bytes)"
    else
      echo "FAIL  $name (empty output)"
      rm -f "$tmp"
      failed=$((failed + 1))
    fi
  else
    err=$(cat /tmp/ffmpeg.err 2>/dev/null | head -2 | tr '\n' ' ')
    echo "FAIL  $name ($err)"
    rm -f "$tmp"
    failed=$((failed + 1))
  fi
done

echo ""
echo "Summary: total=$total fixed=$fixed skipped=$skipped failed=$failed"
