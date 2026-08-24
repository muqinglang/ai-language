#!/usr/bin/env bash
#
# One-shot: export YouTube cookies from local Chrome → push to k8s as a
# secret → restart the api pod → verify yt-dlp inside the pod can fetch a
# previously bot-challenged video. Run on your Mac whenever cookies stop
# working (YouTube rotates them every ~20-30 days).
#
# Usage:
#   scripts/refresh-yt-cookies.sh                # Chrome default profile
#   scripts/refresh-yt-cookies.sh 'Profile 2'    # specific Chrome profile
#
# Env overrides (all optional):
#   RUNNER            ssh target that has kubectl access
#                     (default: root@45.32.31.176)
#   KUBECONFIG_PATH   kubeconfig path on the runner (default: /tmp/kubeconfig)
#   NAMESPACE         k8s namespace (default: justspeak)
#   TEST_VIDEO        URL to validate cookies against
#                     (default: a video known to hit the bot challenge)
#   BROWSER           chrome | safari | firefox | brave | edge | chromium
#                     (default: chrome)
#
# Pre-reqs:
#   * brew install yt-dlp
#   * Chrome logged into a YouTube account (recommended: a throwaway, not
#     your main Google account — YouTube sometimes flags scraper patterns)
#   * SSH key already trusted by the runner
#
# The script is idempotent. Re-run any time to rotate.

set -euo pipefail

PROFILE="${1:-}"                              # "" = Chrome default profile
RUNNER="${RUNNER:-root@45.32.31.176}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-/tmp/kubeconfig}"
NAMESPACE="${NAMESPACE:-justspeak}"
BROWSER="${BROWSER:-chrome}"
# This video hit "Sign in to confirm you're not a bot" from the Vultr pod.
# If it now works, cookies are good.
TEST_VIDEO="${TEST_VIDEO:-https://www.youtube.com/watch?v=SXtH7CxIHI0}"

# mktemp -d then a non-existent path inside it. yt-dlp's `--cookies FILE`
# tries to PARSE an existing file as Netscape format first — an empty file
# from plain `mktemp` fails that check with "does not look like a Netscape
# format cookies file". Pointing at a path that doesn't exist yet lets
# yt-dlp write it fresh.
COOKIES_DIR="$(mktemp -d -t yt-cookies.XXXXXX)"
COOKIES="$COOKIES_DIR/cookies.txt"
trap 'rm -rf "$COOKIES_DIR"' EXIT

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$1" "$2"; }
die() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. deps ----------
log 1/6 "checking dependencies"
command -v yt-dlp >/dev/null || die "yt-dlp not installed (brew install yt-dlp)"
command -v ssh    >/dev/null || die "ssh not available"
command -v scp    >/dev/null || die "scp not available"
echo "  · yt-dlp $(yt-dlp --version)"

# ---------- 2. Chrome must be closed ----------
# yt-dlp reads the SQLite cookie DB directly; Chrome holds an exclusive
# lock while running, which makes the read fail with "database is locked".
if pgrep -x "Google Chrome" >/dev/null 2>&1; then
    die "Google Chrome is running — close it first (the cookie DB is locked)."
fi

# ---------- 3. export cookies ----------
log 2/6 "exporting cookies from $BROWSER → $COOKIES"
BROWSER_ARG="$BROWSER"
[[ -n "$PROFILE" ]] && BROWSER_ARG="$BROWSER:$PROFILE"

# Running yt-dlp against the test URL does two useful things at once:
#   a) dumps the browser cookies into Netscape format at $COOKIES
#   b) validates the cookies work for a bot-challenged video before we
#      bother pushing anything to the cluster
if ! yt-dlp --cookies-from-browser "$BROWSER_ARG" \
            --cookies "$COOKIES" \
            --skip-download --get-title --no-warnings \
            "$TEST_VIDEO" > /tmp/yt-cookies-selftest.log 2>&1; then
    echo "--- yt-dlp output ---" >&2
    cat /tmp/yt-cookies-selftest.log >&2
    die "cookies not valid for $TEST_VIDEO (see log above). \
Are you logged into YouTube in $BROWSER? Try a different profile: \
$(basename "$0") 'Profile N'"
fi

TITLE=$(cat /tmp/yt-cookies-selftest.log)
rm -f /tmp/yt-cookies-selftest.log
echo "  ✓ cookies valid — video title: $TITLE"

# ---------- 4. upload + rotate secret ----------
log 3/6 "uploading to runner ($RUNNER)"
scp -q "$COOKIES" "$RUNNER:/tmp/yt-cookies-new.txt"

log 4/6 "rotating k8s secret yt-cookies in namespace $NAMESPACE"
ssh "$RUNNER" bash -s <<REMOTE
set -euo pipefail
export KUBECONFIG=$KUBECONFIG_PATH
kubectl -n $NAMESPACE delete secret yt-cookies --ignore-not-found=true >/dev/null
kubectl -n $NAMESPACE create secret generic yt-cookies \
    --from-file=cookies.txt=/tmp/yt-cookies-new.txt >/dev/null
shred -u /tmp/yt-cookies-new.txt 2>/dev/null || rm -f /tmp/yt-cookies-new.txt
echo "  · secret yt-cookies (re)created"
REMOTE

# ---------- 5. restart api ----------
log 5/6 "restarting deploy/app (to pick up the new secret)"
ssh "$RUNNER" bash -s <<REMOTE
set -euo pipefail
export KUBECONFIG=$KUBECONFIG_PATH
kubectl -n $NAMESPACE rollout restart deploy/app >/dev/null
kubectl -n $NAMESPACE rollout status deploy/app --timeout=180s
REMOTE

# ---------- 6. verify from inside the pod ----------
# Note: `kubectl exec ... yt-dlp ... | tail -1` loses yt-dlp's exit code to
# the pipeline — tail always returns 0. Capture stdout + exit code via a
# heredoc with pipefail so we actually notice pod-side failures.
log 6/6 "verifying yt-dlp inside the pod can fetch $TEST_VIDEO"
# Verify via the actual pipeline code path: _try_fetch_metadata_and_captions
# uses the cookies file the same way a real import does — including the
# read-only-mount → /tmp copy that yt-dlp's --cookies arg can't do alone
# (yt-dlp opens the file rw to persist refreshed session tokens, the k8s
# Secret mount is read-only tmpfs → OSError [Errno 30] from inside the
# CLI invocation here even when the cookies themselves are fine).
if ! POD_OUT=$(ssh "$RUNNER" bash -s <<REMOTE
set -euo pipefail
export KUBECONFIG=$KUBECONFIG_PATH
kubectl -n $NAMESPACE exec deploy/app -c api -- python -c "
import sys
from app.services.pipeline import _try_fetch_metadata_and_captions
r = _try_fetch_metadata_and_captions('$TEST_VIDEO')
if not r or not r.get('title'):
    print('pipeline returned None/empty — check pod logs for the underlying yt-dlp error', file=sys.stderr)
    sys.exit(1)
print(r['title'])
"
REMOTE
); then
    echo "--- pod yt-dlp output ---" >&2
    echo "$POD_OUT" >&2
    die "pod-side yt-dlp failed. The secret is mounted but the cookies \
don't work from the pod's IP — try a fresh export, or the deployment may \
still be rolling out the volumeMount (check kubectl describe pod)."
fi

POD_TITLE=$(echo "$POD_OUT" | tail -1)
echo "  ✓ pod fetched title: $POD_TITLE"
echo
printf '\033[1;32m[DONE]\033[0m cookies rotated and verified in pod. \n'
echo "      Re-import a video from the admin UI to confirm end-to-end."
