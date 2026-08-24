"""Usage: python -m app.seed

Always seeds: schema, categories, admin user.
Seeds sample episodes only when SEED_DEMO=true (local dev).
Production sets SEED_DEMO=false to avoid the fake RGB-bars demo videos."""
import asyncio
import os
import secrets
from datetime import datetime, timezone

from sqlalchemy import select

from .auth import hash_password
from .db import Base, SessionLocal, engine
from .models import Category, Chunk, Episode, Speaker, Subtitle, User


def _demo_enabled() -> bool:
    return os.getenv("SEED_DEMO", "true").lower() in ("1", "true", "yes", "on")

CATEGORIES = [
    ("🤖", "AI", "ai"),
    ("📈", "商业创业", "business"),
    ("💻", "科技数码", "tech"),
    ("🔬", "科学科普", "science"),
    ("🧠", "心理", "psych"),
    ("💪", "健身健康", "fitness"),
    ("✈", "旅行文化", "travel"),
    ("🎙", "播客访谈", "podcast"),
    ("📰", "时事新闻", "news"),
    ("🏡", "生活 Vlog", "vlog"),
]

# Local sample videos served by FastAPI StaticFiles at /media/*. Generated on
# first boot by ensure_sample_videos() below using ffmpeg lavfi sources, so we
# don't depend on any external CDN (which would be blocked by GFW/throttling).
SAMPLE_VIDEOS = [
    "/media/sample.mp4",
    "/media/sample1.mp4",
    "/media/sample2.mp4",
    "/media/sample3.mp4",
    "/media/sample4.mp4",
]


def ensure_sample_videos() -> None:
    """Generate 5 small (≤1MB) test videos under /app/media if missing.
    Runs at seed time, requires ffmpeg in the image."""
    import shutil
    import subprocess
    from pathlib import Path

    media_dir = Path("/app/media")
    media_dir.mkdir(parents=True, exist_ok=True)

    if not shutil.which("ffmpeg"):
        print("[seed] ffmpeg missing; skipping sample video generation")
        return

    sources = [
        ("sample.mp4",  "testsrc",     440),
        ("sample1.mp4", "testsrc",     220),
        ("sample2.mp4", "smptebars",   330),
        ("sample3.mp4", "rgbtestsrc",  660),
        ("sample4.mp4", "yuvtestsrc",  880),
    ]
    for fname, src, freq in sources:
        out = media_dir / fname
        if out.exists() and out.stat().st_size > 100_000:
            continue
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"{src}=size=640x360:rate=24:duration=20",
            "-f", "lavfi", "-i", f"sine=frequency={freq}:duration=20",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "64k",
            str(out),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=60)
            print(f"[seed] generated {out.name}")
        except Exception as e:
            print(f"[seed] failed to generate {out.name}: {e}")

SEED_EPISODES = [
    dict(
        title="AI 会取代开发者吗？Karpathy 的品味论",
        summary="Karpathy 认为 AI 最终会帮开发者做掉所有枯燥重复的部分，但真正的工程是关于品味和判断——那是 AI 短期内很难复制的。",
        category_slug="ai", accent="US", difficulty=3, chunks=12, duration=167,
        thumb="https://picsum.photos/seed/justspeak-1/800/500",
    ),
    dict(
        title="OpenAI 早期故事：GPT 是怎么意外冒出来的",
        summary="Ilya 回忆 GPT 最初只是一个语言建模实验，没人想到它会成为 AGI 路上第一道门。",
        category_slug="ai", accent="US", difficulty=4, chunks=14, duration=182,
        thumb="https://picsum.photos/seed/justspeak-2/800/500",
    ),
    dict(
        title="YC 创始人课：如何判断一个 idea 值不值得做",
        summary="Michael Seibel 用 5 个问题帮你过滤掉 90% 不靠谱的创业点子。",
        category_slug="business", accent="US", difficulty=3, chunks=10, duration=151,
        thumb="https://picsum.photos/seed/justspeak-3/800/500",
    ),
    dict(
        title="黑洞内部到底发生了什么？",
        summary="Veritasium 用简单的类比解释事件视界之后的物理学。",
        category_slug="science", accent="AU", difficulty=4, chunks=15, duration=178,
        thumb="https://picsum.photos/seed/justspeak-4/800/500",
    ),
    dict(
        title="为什么越聪明的人越容易焦虑",
        summary="Jay Shetty 聊过度思考与自我怀疑的循环。",
        category_slug="psych", accent="UK", difficulty=2, chunks=9, duration=134,
        thumb="https://picsum.photos/seed/justspeak-5/800/500",
    ),
    dict(
        title="Apple Vision Pro 一年后：到底值不值",
        summary="MKBHD 从实际使用角度评价 Vision Pro 的长期体验。",
        category_slug="tech", accent="US", difficulty=3, chunks=11, duration=165,
        thumb="https://picsum.photos/seed/justspeak-6/800/500",
    ),
    dict(
        title="每天 10 分钟真的能变强吗？",
        summary="Hanna 测试'微运动'一个月，结果出乎意料。",
        category_slug="fitness", accent="US", difficulty=2, chunks=8, duration=129,
        thumb="https://picsum.photos/seed/justspeak-7/800/500",
    ),
    dict(
        title="在东京下北泽寻找完美古着店",
        summary="穿街走巷找那些只有本地人知道的小店。",
        category_slug="travel", accent="UK", difficulty=3, chunks=13, duration=192,
        thumb="https://picsum.photos/seed/justspeak-8/800/500",
    ),
    dict(
        title="Sam Altman 聊 AGI 来临那一天",
        summary="AGI 到来不是一个瞬间，而是一段过渡。",
        category_slug="podcast", accent="US", difficulty=4, chunks=12, duration=172,
        thumb="https://picsum.photos/seed/justspeak-9/800/500",
    ),
    dict(
        title="AI 监管大战：欧美路线对比",
        summary="BBC 对比欧盟 AI Act 和美国的行业自律。",
        category_slug="news", accent="UK", difficulty=3, chunks=10, duration=148,
        thumb="https://picsum.photos/seed/justspeak-10/800/500",
    ),
]
# Attach a playable sample URL to each seed row (round-robin).
for i, _seed in enumerate(SEED_EPISODES):
    _seed["video_url"] = SAMPLE_VIDEOS[i % len(SAMPLE_VIDEOS)]

CANNED_SUBS = [
    (0, 4000, "So the question everybody keeps asking me is: are developers gonna be out of a job in five years?",
     "所以大家一直在问我：五年后开发者是不是就没工作了？"),
    (4000, 8000, "And my honest answer is, it depends on what kind of developer you are.",
     "我的真实回答是，这取决于你是哪种开发者。"),
    (8000, 13000, "If your whole job is knocking out CRUD endpoints from a spec, yeah, I think you'll end up doing a lot less of that.",
     "如果你的全部工作就是按文档敲 CRUD 接口，你会越来越少做这种事。"),
    (13000, 19000, "But the way I see it, real engineering is sort of like taste. It's knowing what not to build.",
     "但在我看来，真正的工程更像是品味——是知道什么东西不该做。"),
    (19000, 24000, "A junior engineer will build the thing you asked for. A senior engineer will go, wait a sec, should we even be building this?",
     "初级工程师会直接做你要的东西，而资深工程师会停下来问：我们真的应该做这个吗？"),
    (24000, 29000, "And that question, the way I see it, is still really hard for a model to ask.",
     "在我看来，这个问题对模型来说还是很难主动提出的。"),
    (29000, 33000, "Lex: that's kind of like saying it's about judgment, not output.",
     "Lex：你这话差不多就是说——重要的是判断力，而不是产出。"),
    (33000, 38000, "Exactly. And judgment comes from a decade of seeing things blow up in your face.",
     "没错。判断力是你被各种事情炸脸炸了十年才攒出来的。"),
]

SEED_CHUNKS = [
    dict(
        text="end up doing",
        chunk_type="idiomatic",
        why_explanation=(
            "表示'事情最后落成了这个结果'。这是一种放弃控制、承认'本来不打算但最终这样了'的语气。"
            "母语者用它来削减'我是主动做的'这种味道。"
        ),
        usage_scenario="讲一件事没按计划进行，最后变成另一种结果时用。",
        similar_expressions=["wound up doing", "turned out to be doing"],
        common_collocations=["end up + V-ing", "end up + 形容词"],
        pronunciation_tip="end up 常连读为 /ɛnˈdʌp/",
        difficulty=3,
    ),
    dict(
        text="the way I see it",
        chunk_type="functional",
        why_explanation="委婉地给出自己的观点，暗示'这只是我的看法，不是事实'。给建议时特别好用。",
        usage_scenario="给建议 / 委婉表达观点。",
        similar_expressions=["if you ask me", "from where I stand"],
        common_collocations=["the way I see it, ..."],
        pronunciation_tip="",
        difficulty=3,
    ),
    dict(
        text="kind of like",
        chunk_type="collocation",
        why_explanation="打比方的口语填充词，用来把一个陌生的想法类比成熟悉的东西，降低听者的认知门槛。",
        usage_scenario="解释新概念时。",
        similar_expressions=["sort of like", "basically like"],
        common_collocations=["it's kind of like + 名词"],
        pronunciation_tip="kind of 常弱读成 /ˈkaɪndə/",
        difficulty=2,
    ),
    dict(
        text="keeps asking me",
        chunk_type="discourse",
        why_explanation="用'keeps doing'强调这件事反复发生、让人感觉疲倦或无奈。带有一点抱怨或好笑的意味。",
        usage_scenario="抱怨式陈述一个常见问题。",
        similar_expressions=["won't stop asking me"],
        common_collocations=["keeps + V-ing"],
        pronunciation_tip="",
        difficulty=2,
    ),
]


async def main() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    demo = _demo_enabled()
    if demo:
        ensure_sample_videos()
    else:
        print("[seed] SEED_DEMO=false — skipping sample videos + demo episodes")

    async with SessionLocal() as db:
        # Categories
        cats = {}
        for icon, name, slug in CATEGORIES:
            existing = await db.scalar(select(Category).where(Category.slug == slug))
            if existing:
                cats[slug] = existing
                continue
            c = Category(icon=icon, name=name, slug=slug, sort=len(cats))
            db.add(c)
            await db.flush()
            cats[slug] = c

        # Users: admin is always seeded; demo only for local dev.
        #
        # Open-source safety: the admin password is NEVER hard-coded. It comes
        # from ADMIN_PASSWORD; if that is unset we generate a strong random one
        # and print it ONCE so the operator can copy it from the boot logs. Pin
        # it via ADMIN_PASSWORD in your .env to keep it stable across reseeds.
        admin_user = os.getenv("ADMIN_USERNAME", "admin")
        admin_email = os.getenv("ADMIN_EMAIL", "admin@example.com")
        if not await db.scalar(select(User).where(User.username == admin_user)):
            admin_pw = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(12)
            if not os.getenv("ADMIN_PASSWORD"):
                print(f"[seed] created admin '{admin_user}' with a GENERATED password: {admin_pw}")
                print("[seed] set ADMIN_PASSWORD in .env to pin it; login now, change it later.")
            db.add(User(username=admin_user, email=admin_email, role="admin",
                        password_hash=hash_password(admin_pw)))

        # demo/demo1234 is a throwaway local-only account, never seeded in prod.
        if demo and not await db.scalar(select(User).where(User.username == "demo")):
            db.add(User(username="demo", email="demo@example.com", role="user",
                        password_hash=hash_password("demo1234")))

        if not demo:
            await db.commit()
            print("[seed] schema + categories + admin user ready (no demo data).")
            return

        # --- Everything below is demo-only ---
        sp = await db.scalar(select(Speaker).where(Speaker.handle == "@Karpathy"))
        if not sp:
            sp = Speaker(handle="@Karpathy", name="Andrej Karpathy", default_accent="US", default_gender="male")
            db.add(sp)
            await db.flush()

        # Episodes — upsert by title, so re-running seed also backfills video_url etc.
        existing_by_title = {
            ep.title: ep
            for ep in (await db.execute(select(Episode))).scalars().all()
        }
        for seed in SEED_EPISODES:
            cat = cats[seed["category_slug"]]
            existing = existing_by_title.get(seed["title"])
            if existing:
                # Backfill fields that may have been missing from older seed runs.
                existing.video_url = seed["video_url"]
                existing.thumbnail_url = seed["thumb"]
                existing.summary = seed["summary"]
                existing.duration_sec = seed["duration"]
                existing.category_id = cat.id
                existing.speaker_id = sp.id
                existing.accent = seed["accent"]
                existing.difficulty = seed["difficulty"]
                existing.chunks_count = seed["chunks"]
                existing.subtitles_count = len(CANNED_SUBS)
                existing.status = "published"
                continue

            ep = Episode(
                title=seed["title"],
                summary=seed["summary"],
                youtube_url="https://youtube.com/watch?v=example",
                video_url=seed["video_url"],
                thumbnail_url=seed["thumb"],
                duration_sec=seed["duration"],
                category_id=cat.id,
                speaker_id=sp.id,
                accent=seed["accent"],
                difficulty=seed["difficulty"],
                chunks_count=seed["chunks"],
                subtitles_count=len(CANNED_SUBS),
                status="published",
                published_at=datetime.now(timezone.utc),
                ai_metadata={"seeded": True},
            )
            db.add(ep)
            await db.flush()

            for i, (start, end, en, zh) in enumerate(CANNED_SUBS, start=1):
                db.add(Subtitle(
                    episode_id=ep.id, seq=i,
                    start_ms=start, end_ms=end, text_en=en, text_zh=zh, chunk_refs=[],
                ))
            for c in SEED_CHUNKS:
                db.add(Chunk(episode_id=ep.id, **c))

        await db.commit()
        print("seed complete.")


if __name__ == "__main__":
    asyncio.run(main())
