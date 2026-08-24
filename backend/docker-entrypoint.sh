#!/bin/sh
set -e

# Wait for postgres (up to ~60s)
echo "[entrypoint] waiting for database..."
python - <<'PY'
import os, socket, time, urllib.parse as u
url = os.environ.get("DATABASE_URL", "")
if "@" in url and "/" in url:
    host_port = url.split("@", 1)[1].split("/", 1)[0]
    host, _, port = host_port.partition(":")
    port = int(port or 5432)
else:
    host, port = "db", 5432

for i in range(60):
    try:
        with socket.create_connection((host, port), timeout=1):
            print(f"[entrypoint] db reachable at {host}:{port}")
            break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit(f"[entrypoint] db unreachable at {host}:{port}")
PY

# Idempotent seed — creates tables, users, categories, sample episodes
echo "[entrypoint] running seed..."
python -m app.seed || echo "[entrypoint] seed failed but continuing"

echo "[entrypoint] launching: $@"
exec "$@"
