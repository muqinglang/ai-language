# Deployment & usage

Ways to run justSpeak, from easiest to most involved:

1. [Local development](#1-local-development-hot-reload) (hot reload)
2. [Self-host on one VPS](#2-self-host-on-one-vps-recommended) with Docker Compose + HTTPS **(recommended, truly `git clone` + one command)**
3. [Railway (backend) + Vercel (frontend)](#3-railway-backend--vercel-frontend) — managed, no server to babysit
4. [Hand the repo to an AI agent (Claude Code / Codex)](#4-hand-the-repo-to-an-ai-agent-claude-code--codex) to do it for you

> **Can I put the whole thing on Vercel?** No. The frontend can, but the backend
> cannot — see [Why the backend doesn't fit Vercel](#why-the-backend-doesnt-fit-vercel).
>
> **Where do the videos live?** On disk. The compose stack keeps them in a Docker
> `media` volume; on Railway you mount a **persistent Volume** at `/app/media`. Vercel
> (serverless, ephemeral disk) **cannot** store them — that's why the backend never runs
> on Vercel.

---

## Prerequisites

- **Docker** + **Docker Compose v2** (`docker compose`, not `docker-compose`).
- A server with a **public IP** and, for HTTPS, a **domain** pointed at it.
- For YouTube imports: the server (or a proxy it uses) must reach YouTube. Data-centre
  IPs are frequently anti-bot-challenged — a residential IP and/or cookies help. You can
  also import on your laptop and serve on the server; the pipeline just needs LLM keys.

---

## 1. Local development (hot reload)

Backend and DB in Docker, frontend on the Vite dev server:

```bash
cp .env.example .env

# just the database
docker compose up -d db

# backend (hot reload)
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.seed          # creates schema + admin (password printed to stdout)
uvicorn app.main:app --reload   # http://localhost:8000

# frontend (hot reload) — new terminal
cd frontend
npm install
npm run dev                 # http://localhost:5173  (proxies /api → :8000)
```

Or run the whole stack in Docker with one command:

```bash
docker compose up -d --build   # web :8080, api :8000, db :5432
```

---

## 2. Self-host on one VPS (recommended)

One small VPS (2 vCPU / 2 GB is enough to *serve*; transcription is heavier — see note)
runs everything: Postgres, API, and the web/nginx container. A reverse proxy in front
terminates TLS.

### 2a. Bring the stack up

```bash
ssh you@your-server
git clone <your-fork-url> justspeak && cd justspeak
cp .env.example .env
# EDIT .env — set at minimum:
#   POSTGRES_PASSWORD   (strong, alphanumeric)
#   JWT_SECRET          (openssl rand -hex 32)
#   ADMIN_PASSWORD      (or read the generated one from logs)
#   CREDENTIAL_ENC_KEY  (if you want the BYOK feature; see .env.example)
#   SEED_DEMO=false     (no fake sample videos in prod)
docker compose up -d --build
docker compose logs api | grep generated   # if you left ADMIN_PASSWORD blank
```

The web container listens on `127.0.0.1:8080` by default (see `docker-compose.yml`).
Put a TLS-terminating reverse proxy in front of it.

### 2b. HTTPS with Caddy (simplest — automatic Let's Encrypt)

Point your domain's DNS **A record** at the server, then on the host:

```bash
# /etc/caddy/Caddyfile
your-domain.example {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo apt install caddy      # or: docker run caddy
sudo systemctl reload caddy # Caddy fetches + renews certs automatically
```

That's it — `https://your-domain.example` now serves the app, and Caddy renews certs
for you. (Prefer nginx + certbot? Any reverse proxy to `127.0.0.1:8080` works.)

### 2c. Production override (optional, leaner image)

`docker-compose.prod.yml` builds the API from `Dockerfile.server` (no pipeline deps —
smaller/faster) and the web from `Dockerfile.prod` (copies a prebuilt `dist`). Use it
only if you build the frontend separately (CI) and **don't** import YouTube on this box:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

For a single all-in-one box that also imports YouTube, stick with the plain
`docker-compose.yml` (the full image has yt-dlp + whisper + ffmpeg).

> **Transcription is CPU-heavy.** faster-whisper on a 2-core box is slow. Either import
> on a beefier/local machine, use small whisper models, or offload the pipeline.

### 2d. Day-2 operations

```bash
# update to latest code
git pull && docker compose up -d --build

# logs / restart
docker compose logs -f api
docker compose restart api

# database shell + backup
docker compose exec db psql -U admin -d justspeak
docker compose exec db pg_dump -U admin justspeak | gzip > backup-$(date +%F).sql.gz

# reset everything (DANGER: wipes the database volume)
docker compose down -v
```

**Change the admin password** after first login (Admin → account), and keep
`ADMIN_PASSWORD` in `.env` so reseeds don't surprise you.

---

## 3. Railway (backend) + Vercel (frontend)

Managed hosting, nothing to SSH into. **Railway** runs the backend container + Postgres
+ a persistent Volume for videos; **Vercel** serves the static frontend. The backend's
`docker-entrypoint.sh` waits for the DB, seeds it (creating the admin user), and starts
uvicorn — so once the env vars are right it comes up on its own.

### 3a. Backend + database + video storage on Railway

1. **New Project → Deploy from GitHub repo** (your fork).
2. In the service **Settings → Build**: set **Root Directory** = `backend` (Railway then
   uses `backend/Dockerfile` automatically). **Networking**: the app listens on **8000** —
   generate a public domain and set the target port to `8000`.
3. **Add PostgreSQL**: in the project, **New → Database → PostgreSQL**.
4. **Wire the database URL** — the app uses the async driver, so build the URL from
   Railway's Postgres reference variables. In the backend service **Variables**, add:

   ```
   DATABASE_URL=postgresql+asyncpg://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   ```

   (Note the `+asyncpg` — Railway's default `DATABASE_URL` lacks it and won't work.)
5. **Add a Volume** for videos: attach a Volume with **Mount path `/app/media`**. This is
   where yt-dlp downloads, thumbnails and the TTS cache live; without it they vanish on
   every redeploy. Size it generously — clips are large (a collection can be ~1 GB).
6. **Set the rest of the env** (see `.env.example` / [Environment reference](#environment-reference)):
   `JWT_SECRET`, `ADMIN_PASSWORD` (or read the generated one from the deploy logs),
   `CREDENTIAL_ENC_KEY`, `SEED_DEMO=false`, and any LLM/TTS keys you want.
7. Deploy. Grab the public URL, e.g. `https://your-app.up.railway.app`.

### 3b. Frontend on Vercel

1. **Import the repo**, set **Root Directory** = `frontend` (Vercel detects Vite: build
   `npm run build`, output `dist`).
2. The frontend calls `/api/*` and `/media/*` relative — point both at the Railway
   backend by committing **`frontend/vercel.json`**:

   ```json
   {
     "rewrites": [
       { "source": "/api/:path*",   "destination": "https://your-app.up.railway.app/api/:path*" },
       { "source": "/media/:path*", "destination": "https://your-app.up.railway.app/media/:path*" }
     ]
   }
   ```

   Replace the host with your Railway domain. Deploy — done.

### 3c. Caveats on the managed path

- **Video seeking**: on the Railway-only backend, video is served by FastAPI's static
  files, which don't fully honour HTTP Range — playback works, scrubbing/seek can be
  flaky. For proper seeking keep the compose stack's nginx layer (§2) or front `/media`
  with a CDN.
- **Heavy imports**: yt-dlp + whisper transcription is CPU-heavy and slow on small
  Railway instances. Either size up, or import on your laptop and publish the finished
  bundle to the server (the app has a publish path). Data-centre IPs also get anti-bot
  challenged by YouTube — cookies/proxy may be needed.
- **Scaling storage**: a Railway Volume is fine for personal/small use. At scale, move
  media to object storage (Cloudflare R2 / S3 / OSS) + CDN — that integration is **not
  wired in the current code** and would need adding.

### Why the backend doesn't fit Vercel

Vercel runs **serverless functions**, which are the wrong shape for this backend:

| Backend needs | Vercel serverless |
|---|---|
| Long-running yt-dlp download + whisper transcription (minutes) | Function timeout (10–300 s) |
| Persistent disk for `/app/media`, tts cache, whisper models | Ephemeral filesystem, wiped per invocation |
| A bundled PostgreSQL | None — you'd need an external DB anyway |
| Long-lived SSE streams + video Range serving | Awkward / limited under serverless |
| An always-on process (import tasks, connection pool) | Cold-started, stateless functions |

So: **frontend → Vercel is fine; backend → a real container host (Railway/VPS).**

---

## 4. Hand the repo to an AI agent (Claude Code / Codex)

If you'd rather not click through dashboards, clone the repo and let a coding agent drive
the deploy. Open the repo folder in **Claude Code** (or Codex / Cursor) and paste a prompt
like this:

```
This repo is a self-hostable FastAPI + React + PostgreSQL app (see README.md and DEPLOY.md).
Deploy it for me:
- Read DEPLOY.md and pick the simplest working option for my setup.
- Target: <"a VPS I have at 1.2.3.4 over SSH"  OR  "Railway backend + Vercel frontend">.
- Generate strong secrets (JWT_SECRET, CREDENTIAL_ENC_KEY, POSTGRES_PASSWORD), write the
  .env, and set SEED_DEMO=false.
- Bring the stack up, run the DB seed, and tell me the admin username + the generated
  admin password from the logs.
- Make sure videos persist (Docker media volume, or a Railway Volume at /app/media).
- Give me the final URL and a one-paragraph summary of what you did.
Ask me for any secret/API key you need; don't invent placeholder values.
```

The agent has everything it needs in this repo: `docker-compose.yml`, `backend/Dockerfile`,
`docker-entrypoint.sh` (waits for DB → seeds → starts uvicorn), `.env.example`, and this
guide. For a VPS it will typically `git clone`, write `.env`, and run `docker compose up -d`;
for Railway/Vercel it will follow §3.

---

## Environment reference

All configuration lives in `.env` (compose reads it) — see **`.env.example`** for the
full annotated list. The essentials for production:

| Variable | Why |
|---|---|
| `POSTGRES_PASSWORD` | DB password (set before first boot) |
| `JWT_SECRET` | Signs login tokens — must be strong & secret |
| `ADMIN_PASSWORD` | Pins the admin login (else auto-generated + logged) |
| `CREDENTIAL_ENC_KEY` | Encrypts learner BYOK keys at rest (feature off if unset) |
| `SEED_DEMO=false` | No fake sample videos in prod |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / … | Server-side LLM (optional; BYOK works without) |
| `ELEVENLABS_API_KEY` | Platform TTS (optional; Web Speech fallback otherwise) |
