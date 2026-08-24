FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

# ---- 1. Swap Debian mirror to Aliyun (avoids GFW / fake-IP DNS hijack) ----
# Debian 12+ uses sources.list.d/debian.sources; older layouts use sources.list.
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi

# ---- 2. System deps ----
#   - ffmpeg: yt-dlp needs it to mux audio/video
#   - libpq5, build-essential: psycopg / bcrypt wheels
#   - curl: healthcheck
#   - unzip: needed by the deno installer
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libpq5 \
        build-essential \
        curl \
        unzip \
        && rm -rf /var/lib/apt/lists/*

# ---- 2b. Deno (JS runtime for yt-dlp's YouTube "n signature" challenge) ----
# Without a JS runtime yt-dlp can only fetch storyboard images — the real
# media URLs need the n-param computed in JS to download. deno is the one
# yt-dlp enables by default (see its "EJS" wiki page).
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y \
    && deno --version

WORKDIR /app

# ---- 3. Python deps via Tsinghua mirror ----
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn

COPY requirements.txt .
RUN pip install -r requirements.txt

# ---- 4. App code ----
COPY app ./app
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

RUN mkdir -p /app/media

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD curl -fsS http://localhost:8000/healthz || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
