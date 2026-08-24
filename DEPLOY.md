# Deployment & usage

Three ways to run justSpeak, from easiest to most involved:

1. [Local development](#1-local-development-hot-reload) (hot reload)
2. [Self-host on one VPS](#2-self-host-on-one-vps-recommended) with Docker Compose + HTTPS **(recommended)**
3. [Split: frontend on Vercel + backend on a VPS](#3-split-frontend-on-vercel--backend-elsewhere)

> **Can I put the whole thing on Vercel?** No. The frontend can, but the backend
> cannot — see [Why the backend doesn't fit Vercel](#why-the-backend-doesnt-fit-vercel).

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

## 3. Split: frontend on Vercel + backend elsewhere

The React frontend is a static Vite build and deploys to Vercel cleanly. The backend
still has to live on a Docker-capable host (VPS from §2, or Railway / Render / Fly.io)
with a Postgres (managed options: Neon, Supabase, Railway PG).

### Frontend on Vercel

1. Import the repo in Vercel, set **Root Directory** = `frontend`.
2. Build command `npm run build`, output dir `dist` (Vite defaults; Vercel detects it).
3. The frontend talks to the API at `/api/*`. On Vercel there is no backend to proxy to,
   so route `/api/*` to your backend. Add `frontend/vercel.json`:

   ```json
   {
     "rewrites": [
       { "source": "/api/:path*", "destination": "https://api.your-domain.example/api/:path*" }
     ]
   }
   ```

   (Or point the frontend at an absolute API base URL and enable CORS on the backend.)
4. Media files (`/media/*`) and SSE streaming are served by the backend — make sure your
   backend host allows long-lived responses and range requests.

### Backend on Railway / Render / Fly.io

- Deploy `backend/` via its `Dockerfile` (full) or `Dockerfile.server` (serve-only).
- Attach a managed Postgres and set `DATABASE_URL` accordingly.
- Set the same secrets as `.env` (`JWT_SECRET`, `CREDENTIAL_ENC_KEY`, LLM/TTS keys…).
- Persistent disk for `/app/media` if you import/store video on that host.

### Why the backend doesn't fit Vercel

Vercel runs **serverless functions**, which are the wrong shape for this backend:

| Backend needs | Vercel serverless |
|---|---|
| Long-running yt-dlp download + whisper transcription (minutes) | Function timeout (10–300 s) |
| Persistent disk for `/app/media`, tts cache, whisper models | Ephemeral filesystem, wiped per invocation |
| A bundled PostgreSQL | None — you'd need an external DB anyway |
| Long-lived SSE streams + video Range serving | Awkward / limited under serverless |
| A always-on process (import tasks, connection pool) | Cold-started, stateless functions |

So: **frontend → Vercel is fine; backend → a real container host.**

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
