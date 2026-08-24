import mimetypes
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .db import Base, engine
from .routers import admin, admin_users, ai, anchors, auth, collections, creators, episodes, playback, review, schedules, search, user_data, user_llm, vocabulary, words

# Python's mimetypes db is missing several common audio/video formats.
# Register them so StaticFiles serves the right Content-Type and browsers
# can decode the files instead of treating them as text/plain.
for ext, mime in [
    (".m4a", "audio/mp4"),
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    (".ogg", "audio/ogg"),
    (".opus", "audio/opus"),
    (".mp3", "audio/mpeg"),
    (".wav", "audio/wav"),
]:
    mimetypes.add_type(mime, ext)

app = FastAPI(title="justSpeak API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(episodes.router)
app.include_router(ai.router)
app.include_router(ai.util_router)
app.include_router(admin.router)
app.include_router(admin_users.router)
app.include_router(user_data.router)
app.include_router(search.router)
app.include_router(vocabulary.router)
app.include_router(creators.router)
app.include_router(collections.router)
app.include_router(collections.admin_router)
app.include_router(words.router)
app.include_router(schedules.router)
app.include_router(anchors.router)
app.include_router(user_llm.router)
app.include_router(playback.router)
app.include_router(review.router)

# Serve videos/thumbnails downloaded by the yt-dlp pipeline.
# Pipeline writes to /app/media inside the container; compose mounts a volume here.
MEDIA_DIR = Path("/app/media")
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.on_event("startup")
async def _init():
    # Simple auto-create on startup for dev. Swap to Alembic for prod.
    async with engine.begin() as conn:
        # Anchor model pivot (2026-05-19): creator/series "anchors" were
        # replaced by topic-driven narrow-listening paths. Drop the old
        # curated tables and the old user_anchor shape so create_all
        # rebuilds user_anchor with the new topic-based columns. These
        # tables were never deployed (test data only) — destructive
        # migration is intentional and safe here.
        await conn.execute(text(
            "DROP TABLE IF EXISTS anchor_items CASCADE"
        ))
        await conn.execute(text(
            "DROP TABLE IF EXISTS anchors CASCADE"
        ))
        await conn.execute(text("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'user_anchor' AND column_name = 'anchor_id'
                ) THEN
                    DROP TABLE user_anchor CASCADE;
                END IF;
            END$$;
        """))
        await conn.run_sync(Base.metadata.create_all)
        # In-place upgrade for the import_tasks → episodes FK. create_all
        # only creates new tables/constraints; it does NOT alter existing
        # ones. If the FK already exists with the default NO ACTION, drop
        # & recreate it with ON DELETE SET NULL so admin episode deletion
        # works without orphaning the import audit row. Idempotent — only
        # runs the ALTER when the current confdeltype isn't already 'n'.
        await conn.execute(text("""
            DO $$
            DECLARE
                cur_action char;
            BEGIN
                SELECT confdeltype INTO cur_action
                FROM pg_constraint
                WHERE conname = 'import_tasks_episode_id_fkey';

                IF cur_action IS NOT NULL AND cur_action <> 'n' THEN
                    ALTER TABLE import_tasks
                        DROP CONSTRAINT import_tasks_episode_id_fkey;
                    ALTER TABLE import_tasks
                        ADD CONSTRAINT import_tasks_episode_id_fkey
                        FOREIGN KEY (episode_id) REFERENCES episodes(id)
                        ON DELETE SET NULL;
                END IF;
            END$$;
        """))

        # Add word_timings column to subtitles (idempotent).
        await conn.execute(text(
            "ALTER TABLE subtitles "
            "ADD COLUMN IF NOT EXISTS word_timings JSON DEFAULT '[]'"
        ))

        # Add topic field to episodes (idempotent).
        await conn.execute(text(
            "ALTER TABLE episodes "
            "ADD COLUMN IF NOT EXISTS topic VARCHAR(32) DEFAULT 'other' NOT NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_episodes_topic ON episodes (topic)"
        ))

        # Sub-topic free-text tag — clusters episodes inside a topic
        # (e.g. "cooking" / "shopping" inside lifestyle). Powers
        # narrow-listening at the sub-domain level in topic paths.
        await conn.execute(text(
            "ALTER TABLE episodes "
            "ADD COLUMN IF NOT EXISTS subtopic VARCHAR(64) DEFAULT '' NOT NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_episodes_subtopic ON episodes (subtopic)"
        ))

        # Collection / segment fields — when a long video is imported in
        # "full" mode, multiple episodes share a youtube_url and use
        # segment_index for ordering. Nullable for back-compat.
        await conn.execute(text(
            "ALTER TABLE episodes "
            "ADD COLUMN IF NOT EXISTS collection_kind VARCHAR(16), "
            "ADD COLUMN IF NOT EXISTS segment_index INTEGER"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_episodes_collection_kind "
            "ON episodes (collection_kind)"
        ))

        # Import strategy — 'segment' (legacy default) | 'chapters' (full
        # video + AI chapter markers in episode_chapters).  Old rows
        # default to 'segment'.  The episode_chapters table itself is
        # auto-created by Base.metadata.create_all above; we just add a
        # defensive index on episode_id for the common lookup pattern.
        await conn.execute(text(
            "ALTER TABLE episodes "
            "ADD COLUMN IF NOT EXISTS import_mode VARCHAR(16) "
            "DEFAULT 'segment' NOT NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_episodes_import_mode "
            "ON episodes (import_mode)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_episode_chapters_episode_id "
            "ON episode_chapters (episode_id)"
        ))

        # Stored video codec ("h264"/"av1"/"vp9"/"" unknown). Powers the
        # admin "iPhone 不兼容" badge + transcode controls. Empty on legacy
        # rows until the admin runs the codec scan. Idempotent.
        await conn.execute(text(
            "ALTER TABLE episodes "
            "ADD COLUMN IF NOT EXISTS video_codec VARCHAR(16) "
            "DEFAULT '' NOT NULL"
        ))

        # One-time title backfill: rewrite legacy "base #N/M" segment
        # titles to "(N/M) base" (count-prefix-parens reads better when
        # same-source segments cluster in lists). Idempotent — skips
        # rows already in the new form.
        await conn.execute(text(r"""
            UPDATE episodes
            SET title = regexp_replace(title, '^(.*) #(\d+)/(\d+)$', '(\2/\3) \1')
            WHERE title ~ ' #\d+/\d+$'
              AND title NOT LIKE '(%/%) %'
        """))

        # Add spaced-repetition fields to vocabulary (idempotent).
        await conn.execute(text(
            "ALTER TABLE vocabulary "
            "ADD COLUMN IF NOT EXISTS next_review_at TIMESTAMPTZ, "
            "ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ, "
            "ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0 NOT NULL"
        ))

        # US IPA column — idempotent, default empty so old rows stay valid.
        await conn.execute(text(
            "ALTER TABLE vocabulary "
            "ADD COLUMN IF NOT EXISTS ipa VARCHAR(128) DEFAULT '' NOT NULL"
        ))

        # Rich Eudic-style word fields (dual IPA, inflections, sense list).
        # Empty/[] on legacy rows; backfilled lazily on first flashcard review.
        await conn.execute(text(
            "ALTER TABLE vocabulary "
            "ADD COLUMN IF NOT EXISTS ipa_uk VARCHAR(128) DEFAULT '' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS ipa_us VARCHAR(128) DEFAULT '' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS inflections VARCHAR(160) DEFAULT '' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS senses JSON DEFAULT '[]'"
        ))

        # Creator (speakers) extension — channel_id and description power
        # the creator hub pages. Empty strings on legacy rows are fine.
        await conn.execute(text(
            "ALTER TABLE speakers "
            "ADD COLUMN IF NOT EXISTS channel_id VARCHAR(64) DEFAULT '' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '' NOT NULL"
        ))

        # User admin_note — free-form note the admin attaches when
        # provisioning an account from a Xiaohongshu order (e.g.
        # payment date, platform, amount).  Never shown to the user.
        await conn.execute(text(
            "ALTER TABLE users "
            "ADD COLUMN IF NOT EXISTS admin_note TEXT DEFAULT '' NOT NULL"
        ))

        # User expires_at — NULL = permanent.  When set and in the
        # past, auth.current_user refuses with 403 trial_expired (admins
        # exempt).  Used to grant trial access ("free 3 days") that
        # auto-revokes without manual intervention.
        await conn.execute(text(
            "ALTER TABLE users "
            "ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ"
        ))

        # Self-serve signup columns — auth_provider records how the account
        # was created, google_sub pins it to a Google identity.  Legacy rows
        # default to the password path, which is what they are.
        await conn.execute(text(
            "ALTER TABLE users "
            "ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(16) "
            "DEFAULT 'local' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS google_sub VARCHAR(64) "
            "DEFAULT '' NOT NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_users_google_sub ON users (google_sub)"
        ))

        # 复习知识点的结构化讲解（meaning / explanation / usageTip /
        # examples）。ChatGPT 的 example 字段有时是字符串有时是对象，
        # 后者整块存这里。
        await conn.execute(text(
            "ALTER TABLE review_items "
            "ADD COLUMN IF NOT EXISTS detail JSON DEFAULT '{}'"
        ))

        # Learner-owned TTS credentials (CosyVoice via Alibaba Model
        # Studio) live in the same row as their LLM key — one place for
        # "this learner's own credentials". Both halves are optional and
        # independent.
        await conn.execute(text(
            "ALTER TABLE user_llm_configs "
            "ADD COLUMN IF NOT EXISTS tts_api_key_enc TEXT DEFAULT '' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS tts_voice VARCHAR(64) DEFAULT '' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS tts_model VARCHAR(64) DEFAULT '' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS tts_verified_at TIMESTAMPTZ, "
            "ADD COLUMN IF NOT EXISTS tts_last_error TEXT DEFAULT '' NOT NULL"
        ))
        # 朗读 provider（cosyvoice | minimax）。老行默认 cosyvoice —— 它们
        # 存的确实是 CosyVoice 的 key，标成别的会让下一次朗读直接失败。
        await conn.execute(text(
            "ALTER TABLE user_llm_configs "
            "ADD COLUMN IF NOT EXISTS tts_provider VARCHAR(16) "
            "DEFAULT 'cosyvoice' NOT NULL, "
            "ADD COLUMN IF NOT EXISTS tts_group_id VARCHAR(64) "
            "DEFAULT '' NOT NULL"
        ))

        # Onboarding opt-out flag — when true, Home renders RecentView
        # instead of the topic-anchor onboarding. Reversible from the
        # frontend via PATCH /me/preferences.
        await conn.execute(text(
            "ALTER TABLE users "
            "ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN "
            "DEFAULT false NOT NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_speakers_channel_id ON speakers (channel_id)"
        ))

        # Reseed categories table with the curated 10 FORMAT-only entries.
        # Old "topic-style" categories (ai/business/etc) are migrated to
        # the new topic field on episodes, then their category rows are
        # removed.  Test data per user — destructive migration is OK.
        from .services.topics import CATEGORIES, TOPIC_SLUGS, CATEGORY_SLUGS
        for c in CATEGORIES:
            await conn.execute(text("""
                INSERT INTO categories (name, slug, icon, sort)
                VALUES (:name, :slug, :icon, :sort)
                ON CONFLICT (slug)
                DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, sort = EXCLUDED.sort
            """), c)
        # Migrate old topic-shaped category slugs onto episodes.topic, then
        # detach + drop the old rows so the catalog only shows formats.
        old_to_topic = {
            "ai": "ai", "business": "business", "tech": "tech",
            "science": "science", "psych": "psychology",
            "fitness": "health", "travel": "travel",
            "podcast": "interview",  # category slug "podcast" was a hybrid
        }
        for old_slug, new_topic in old_to_topic.items():
            if new_topic in TOPIC_SLUGS:
                await conn.execute(text("""
                    UPDATE episodes SET topic = :topic
                    WHERE category_id = (SELECT id FROM categories WHERE slug = :slug)
                      AND (topic IS NULL OR topic = '' OR topic = 'other')
                """), {"topic": new_topic, "slug": old_slug})
            # If the migrated slug is now a TOPIC, also remap category_id
            # so episodes get a sensible default format.
            await conn.execute(text("""
                UPDATE episodes SET category_id = (
                    SELECT id FROM categories WHERE slug = CASE
                        WHEN :slug = 'podcast' THEN 'interview'
                        ELSE 'creator' END
                )
                WHERE category_id = (SELECT id FROM categories WHERE slug = :slug)
            """), {"slug": old_slug})
        # Now safe to drop legacy category rows that are NOT in CATEGORY_SLUGS.
        from sqlalchemy import bindparam
        await conn.execute(
            text("DELETE FROM categories WHERE slug NOT IN :slugs").bindparams(
                bindparam("slugs", expanding=True)
            ),
            {"slugs": list(CATEGORY_SLUGS)},
        )

    # Idempotent proper-noun backfill: correct AI brand-name ASR errors
    # in already-stored English (subtitles / chunks / featured words),
    # e.g. "Chat GBT" → "ChatGPT". The pipeline now normalizes on import;
    # this repairs pre-existing rows without a re-import. Only changed
    # rows are written, so steady-state boots are a cheap no-op scan.
    from sqlalchemy import select as _sel

    from .db import SessionLocal
    from .models import Chunk, FeaturedWord, Subtitle
    from .services.text_norm import normalize_list, normalize_proper_nouns

    async with SessionLocal() as s:
        fixed = 0
        for row in (await s.execute(_sel(Subtitle))).scalars():
            n = normalize_proper_nouns(row.text_en)
            if n != row.text_en:
                row.text_en = n
                fixed += 1
        for row in (await s.execute(_sel(Chunk))).scalars():
            changed = False
            n = normalize_proper_nouns(row.text)
            if n != row.text:
                row.text = n
                changed = True
            ns = normalize_list(row.similar_expressions or [])
            if ns != (row.similar_expressions or []):
                row.similar_expressions = ns
                changed = True
            nc = normalize_list(row.common_collocations or [])
            if nc != (row.common_collocations or []):
                row.common_collocations = nc
                changed = True
            if changed:
                fixed += 1
        for row in (await s.execute(_sel(FeaturedWord))).scalars():
            changed = False
            for attr in ("word", "definition_en", "example"):
                v = getattr(row, attr)
                nv = normalize_proper_nouns(v)
                if nv != v:
                    setattr(row, attr, nv)
                    changed = True
            if changed:
                fixed += 1
        if fixed:
            await s.commit()
            print(f"[startup] proper-noun backfill: corrected {fixed} rows")

    # Req 5: bring up the import scheduler. Loads all enabled
    # ImportSchedule rows from DB and registers cron triggers in
    # APScheduler. Idempotent on subsequent calls.
    from .services.scheduler import init_scheduler
    await init_scheduler()


@app.get("/healthz")
async def healthz():
    return {"ok": True}
