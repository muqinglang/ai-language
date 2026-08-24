# justSpeak · 只需要开口

> Learn spoken English by watching real YouTube clips, then practising with an AI tutor.
> 用真实 YouTube 语料 + Chunk 表达 + AI 场景对话,帮中文母语者开口说英语。

A self-hostable language-learning platform. Learners watch 2–3 minute curated
clips with bilingual subtitles, collect natural expressions ("chunks"), then run
scenario conversations with an AI that reuses those chunks.

<!-- Add screenshots/GIFs here once you have a public instance. -->

---

## Features

**Learner side**
- Real YouTube clips imported + transcribed (yt-dlp + faster-whisper), 5 subtitle
  modes (bilingual / EN / ZH / dictation / cloze / listen-only)
- Clickable word lookup (LLM definition + IPA + pronunciation + "hear it in the
  clip" + add to vocabulary)
- **AI scenario chat** — streaming (SSE), bubble translation, slow-read, grammar
  feedback, hints, "teach-back" (Feynman) prompts
- Spaced-repetition flashcards (SM-2-lite) for vocabulary and chunks
- Shadowing recorder with live speech-to-text, favourites, notes, progress heatmap
- Responsive: desktop sidebar, mobile bottom-tab bar, iPad layout; installable as a
  PWA (add to home screen / install as a desktop app)

**Admin side**
- Paste a YouTube URL → AI picks the best segment(s) → download, subtitle, translate,
  extract chunks, generate a conversation script, auto-classify by topic
- Import task dashboard with retries/errors; per-episode re-extract / re-generate tools

**Bring-your-own-key (BYOK)** — learners can plug in their own LLM / TTS keys so each
learner's model calls are billed to them, not the operator. See [docs/BYOK.md](docs/BYOK.md).

---

## Tech stack

| Layer | Tech |
|---|---|
| Backend | FastAPI · SQLAlchemy 2 (async) · PostgreSQL 16 · JWT · Pydantic |
| Frontend | React 18 · TypeScript · Vite · TailwindCSS · TanStack Query |
| Import pipeline | yt-dlp + faster-whisper + multi-provider LLM (DeepSeek / OpenAI / Claude) |
| TTS | ElevenLabs / MiniMax / CosyVoice → Web Speech fallback |
| STT | Browser Web Speech API |
| Deploy | Docker Compose (db + api + web) |

---

## Quick start (Docker)

```bash
git clone <your-fork-url> justspeak && cd justspeak
cp .env.example .env          # edit secrets — at minimum POSTGRES_PASSWORD + JWT_SECRET
docker compose up -d --build
```

| Service | URL |
|---|---|
| Web | http://localhost:8080 |
| API docs (Swagger) | http://localhost:8000/docs |
| Postgres | `psql -h localhost -U admin -d justspeak` |

On first boot `seed.py` creates the schema, categories, and an **admin** user. If you
did not set `ADMIN_PASSWORD` in `.env`, a random password is generated and printed to
the api logs — grab it with:

```bash
docker compose logs api | grep "generated"
```

The app runs with **zero API keys** — LLM and TTS features degrade gracefully (BYOK or
Web Speech). Add keys in `.env` to enable server-side AI. See [docs/](docs/) for how each
subsystem works.

**Local development (hot reload)** and **production deployment (VPS + HTTPS, or frontend
on Vercel)** are covered in **[DEPLOY.md](DEPLOY.md)**.

---

## Repository layout

```
justspeak/
├── docker-compose.yml          # db + api + web
├── docker-compose.prod.yml     # production override (lean image, host nginx/Caddy)
├── .env.example                # all configuration
├── backend/                    # FastAPI app (app/routers, app/services, app/models)
├── frontend/                   # React + Vite SPA
└── docs/                       # per-subsystem developer docs — read the one you're touching
```

The `docs/` files are the real design docs: each maps to a part of the codebase
(pipeline, learn UI, AI chat, BYOK, accounts, learning data) and is worth reading before
changing that area.

---

## ⚠️ YouTube / content disclaimer

The import pipeline uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to download YouTube
content for transcription. **This project is provided for personal, educational and
research use only.** Downloading, storing, or redistributing third-party video content
may violate YouTube's Terms of Service and/or copyright law in your jurisdiction. **You
are solely responsible** for how you use this software and for obtaining any rights
needed for the content you process. The authors provide no warranty and accept no
liability for misuse. Do not use this to redistribute copyrighted material.

Data-centre IPs are also commonly challenged by YouTube's anti-bot measures — imports
generally need a residential IP and/or cookies to succeed.

---

## License

[AGPL-3.0](LICENSE). In short: you may use, modify and self-host this freely, but if you
run a modified version as a network service, you must make your modified source available
to its users. Commercial closed-source hosting is not permitted under this license.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
