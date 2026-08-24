import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import SessionLocal, get_db
from ..models import AIConversation, Chunk, Episode, Subtitle, User
from ..schemas import ConversationOut, SendMessage, StartConversation
from ..services import llm, tts
from .user_llm import (
    load_tts_override,
    note_byok_error,
    note_tts_error,
    require_override,
)

router = APIRouter(prefix="/api/ai", tags=["ai"])


async def _llm_call(db: AsyncSession, user: User, fn, *args, **kwargs):
    """Run a blocking llm.* call off the event loop.

    Sole reason this wrapper exists: when the learner brought their own
    key, llm raises BYOKCallFailed instead of quietly re-running the call
    on the platform's key.  That has to reach the learner as something
    they can fix, and be remembered on their settings row — otherwise the
    AI tab just looks broken with no explanation anywhere.
    """
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except llm.BYOKCallFailed as e:
        await note_byok_error(db, user.id, str(e))
        raise HTTPException(502, str(e)) from e

# Sibling router for general utilities (like on-demand translation)
# exposed under /api, not /api/ai.
util_router = APIRouter(prefix="/api", tags=["util"])


class TranslateIn(BaseModel):
    text: str


class TranslateOut(BaseModel):
    text_zh: str


class TTSIn(BaseModel):
    text: str
    # 平台 ElevenLabs 的音色 id（浏览器本地偏好）。**只对 ElevenLabs 有意义** ——
    # 学员自己的 CosyVoice 音色存在服务端他自己那一行里。
    #
    # 这两件事曾经共用这一个字段，于是 CosyVoice 分支把
    # "XrExE9yKIg1WjnnlVkGX" 这种 ElevenLabs id 当音色名发给百炼，换回
    # "Engine return error code: 418"，前端一路降级到浏览器机器音 ——
    # 表现就是"配了 CosyVoice 但 AI 对话根本没用上"。
    voice_id: str | None = None
    model: str | None = None
    # 设置页试听专用：临时用这个 CosyVoice 音色合成一次，不改保存的配置。
    # 单独一个字段，就是为了不再和上面那个混为一谈。
    preview_voice: str | None = None


@util_router.post("/tts")
async def tts_endpoint(
    body: TTSIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """TTS proxy. Returns audio/mpeg bytes.

    Two voices, in order:

    1. **学员自己配的朗读 provider**（MiniMax 或 CosyVoice，见
       services/tts_providers.py）。记在学员账上，国内直连，且**不受
       TTS_DISABLED 影响** —— 那个开关是拦平台花钱的，这不是平台花钱。
    2. **The platform's ElevenLabs keys**, if configured and not disabled.

    Neither available → 503, and the browser reads the line with free Web
    Speech. That is a downgrade, not a failure, which is why this endpoint
    never 428s the way the chat endpoints do.

    The frontend handles three failure shapes by falling back to Web Speech:
    - 503: no voice available (no key / TTS_DISABLED)
    - 402: quota exhausted / rate limited / key invalid (cooldown active)
    - 502: transient provider error (try-again-later)

    Frontend caches 503/402 in a sticky session flag so subsequent calls
    skip the network and synthesize locally — preserves the user-gesture
    context iOS Safari needs for SpeechSynthesis.

    7-day Cache-Control + per-text disk cache make repeat playbacks
    near-free.
    """
    text_in = (body.text or "").strip()
    if not text_in:
        raise HTTPException(400, "empty text")
    text_in = text_in[:1500]

    creds = await load_tts_override(db, user)
    if creds is not None:
        # 音色取自服务端存的配置；只有设置页试听会用 preview_voice 临时
        # 顶掉它。**绝不读 body.voice_id** —— 那是 ElevenLabs 的 id，塞给
        # 别家 provider 必然报"音色不存在"。凭据始终来自学员自己那一行。
        audio = await asyncio.to_thread(
            tts.synthesize_byok_cached,
            creds.provider, text_in, creds.api_key,
            (body.preview_voice or "").strip() or creds.voice,
            creds.model, creds.group_id,
        )
        if isinstance(audio, str):
            # Their key failed. Remember why for the settings page (设置页
            # 的「上次朗读失败」看得到，所以这不是静默降级)，然后 502。
            #
            # X-TTS-Byok-Failed：告诉前端"挂掉的是学员自己配的声音"，不是
            # "没配声音"。配了声音的学员是特意花 key 换掉浏览器系统音的 ——
            # 这一行临时失败时用系统机器音顶替，会让人以为音色被偷偷改了。
            # 前端据这个头**不**降级系统音（宁可这一行不出声）。没配声音的
            # 学员走不到这个分支（下面的 503），系统音仍是他们的正常路径。
            await note_tts_error(db, user.id, audio)
            raise HTTPException(502, audio, headers={"X-TTS-Byok-Failed": "1"})
        return Response(
            content=audio,
            media_type="audio/mpeg",
            headers={"Cache-Control": "public, max-age=604800"},  # 7 days
        )

    # 平台 ElevenLabs：只有学员没配自己的声音时才走到这里。
    if not tts.is_configured():
        raise HTTPException(503, "tts not configured")
    if tts.is_quota_out():
        # Cooldown active — skip the network and tell the client to
        # fall back. Same effect as a 402 from ElevenLabs but instant.
        raise HTTPException(402, "tts quota exhausted; using fallback")
    text = text_in
    audio, quota_out = await asyncio.to_thread(
        tts.synthesize_with_status, text, body.voice_id, body.model
    )
    if quota_out:
        # All keys responded 401/402/429 this round.  Per-key cooldowns
        # are already set inside synthesize_with_status; just 402 the
        # client so the frontend caches the cooldown for this session.
        raise HTTPException(402, "tts quota exhausted; using fallback")
    if not audio:
        raise HTTPException(502, "tts synthesis failed")
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=604800"},  # 7 days
    )


@util_router.post("/translate", response_model=TranslateOut)
async def translate(
    body: TranslateIn,
    user: User = Depends(current_user),
    # Needed since this route started honouring the learner's own key.
    db: AsyncSession = Depends(get_db),
):
    """Translate a free-form English blob to Chinese.  Used by the AI-chat
    bubble 翻译 button when the learner wants to see what a reply means."""
    text = (body.text or "").strip()
    if not text:
        return TranslateOut(text_zh="")
    override = await require_override(db, user)
    zh = await _llm_call(
        db, user, llm.translate_to_zh, text, user.role == "admin", override,
    )
    return TranslateOut(text_zh=zh or "")


async def _new_conversation(
    ep: Episode, user: User, db: AsyncSession,
) -> AIConversation:
    """Actually call the LLM + INSERT a fresh AIConversation.  Extracted
    so start_conversation and reset_conversation share the same path."""
    chunks = (await db.execute(select(Chunk).where(Chunk.episode_id == ep.id).limit(5))).scalars().all()
    target_ids = [c.id for c in chunks]
    target_texts = [c.text for c in chunks]
    scenario, opening = await _llm_call(
        db, user, llm.design_scenario, ep.title, ep.summary, target_texts,
        await require_override(db, user),
    )
    convo = AIConversation(
        user_id=user.id,
        episode_id=ep.id,
        scenario=scenario,
        target_chunks=target_ids,
        messages=[{"role": "assistant", "content": opening, "ts": time.time()}],
        chunks_used=[],
        status="active",
    )
    db.add(convo)
    await db.commit()
    await db.refresh(convo)
    return convo


@router.post("/conversations", response_model=ConversationOut)
async def start_conversation(
    body: StartConversation,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get-or-create.  Returns the user's existing active conversation for
    this episode if there is one, so re-entering the AI tab doesn't burn
    a fresh scenario-design LLM call every time.

    Exception: if the existing convo has used ALL target chunks already,
    auto-archive it and start a new one — the learner has finished the
    "narrow path" and deserves a fresh angle instead of a dead-end chat."""
    ep = await db.get(Episode, body.episode_id)
    if not ep:
        raise HTTPException(404, "episode not found")

    existing = (await db.execute(
        select(AIConversation)
        .where(AIConversation.user_id == user.id)
        .where(AIConversation.episode_id == ep.id)
        .where(AIConversation.status == "active")
        .order_by(AIConversation.id.desc())
        .limit(1)
    )).scalar_one_or_none()

    if existing is not None:
        # Auto-archive if the learner has exhausted all target chunks.
        all_used = (
            existing.target_chunks
            and len(existing.chunks_used or []) >= len(existing.target_chunks)
        )
        if all_used:
            existing.status = "archived"
            await db.commit()
        else:
            return _to_out(existing)

    fresh = await _new_conversation(ep, user, db)
    return _to_out(fresh)


@router.post("/conversations/{cid}/reset", response_model=ConversationOut)
async def reset_conversation(
    cid: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually archive the current convo and design a new scenario.
    Lets the learner opt into a fresh angle when they want one."""
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")
    ep = await db.get(Episode, convo.episode_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    convo.status = "archived"
    await db.commit()
    fresh = await _new_conversation(ep, user, db)
    return _to_out(fresh)


@router.post("/conversations/{cid}/messages", response_model=ConversationOut)
async def send_message(
    cid: int,
    body: SendMessage,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")

    # Load targets
    chunks = (await db.execute(select(Chunk).where(Chunk.id.in_(convo.target_chunks)))).scalars().all()
    target_map = {c.id: c.text for c in chunks}

    user_msg = {"role": "user", "content": body.content, "ts": time.time()}
    # Detect which target chunks are used in the user's message
    used_ids = [cid for cid, txt in target_map.items() if txt.lower() in body.content.lower()]
    chunks_used = sorted(set(list(convo.chunks_used) + used_ids))

    reply = await _llm_call(
        db, user, llm.reply,
        scenario=convo.scenario,
        history=convo.messages + [user_msg],
        target_chunks=list(target_map.values()),
        unused=[t for cid, t in target_map.items() if cid not in chunks_used],
        admin_tier=(user.role == "admin"),
        # The learner's own key when they configured one.  When present it
        # REPLACES the server's providers — no silent fallback onto the
        # platform's quota.
        override=await require_override(db, user),
    )

    ai_msg = {"role": "assistant", "content": reply, "ts": time.time()}
    convo.messages = convo.messages + [user_msg, ai_msg]
    convo.chunks_used = chunks_used
    await db.commit()
    await db.refresh(convo)
    return _to_out(convo)


@router.post("/conversations/{cid}/messages/stream")
async def send_message_stream(
    cid: int,
    body: SendMessage,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Stream the AI reply token-by-token as SSE.

    Frame format:
      data: {"delta": "Hi"}\\n\\n     ← each token
      event: done                     ← terminal event with full convo
      data: {convo json}\\n\\n
    """
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")

    chunks = (await db.execute(select(Chunk).where(Chunk.id.in_(convo.target_chunks)))).scalars().all()
    target_map = {c.id: c.text for c in chunks}

    user_msg = {"role": "user", "content": body.content, "ts": time.time()}
    used_ids = [cid_ for cid_, txt in target_map.items() if txt.lower() in body.content.lower()]
    chunks_used = sorted(set(list(convo.chunks_used) + used_ids))
    history = convo.messages + [user_msg]
    targets = list(target_map.values())
    unused = [t for cid_, t in target_map.items() if cid_ not in chunks_used]

    # Capture the things the background streamer needs.  We close the DB
    # session for streaming and reopen a fresh one at finalize time, since
    # holding an async session across a long-running generator is brittle.
    convo_id = convo.id
    user_id = user.id

    admin_tier = user.role == "admin"
    # Resolve the learner's own key here, while the request-scoped session
    # is still open — the generator below runs after it closes.
    override = await require_override(db, user)

    async def event_source():
        parts: list[str] = []
        try:
            for piece in llm.reply_stream(
                convo.scenario, history, targets, unused,
                admin_tier=admin_tier, override=override,
            ):
                parts.append(piece)
                yield f"data: {json.dumps({'delta': piece}, ensure_ascii=False)}\n\n"
        except llm.BYOKCallFailed as e:
            # The learner's own key failed and we deliberately did not
            # retry on the platform's. Remember why, so the settings page
            # can explain it later, and end the stream without writing a
            # turn — a transcript full of "(no reply)" is worse than a
            # turn the learner can simply send again.
            async with SessionLocal() as db2:
                await note_byok_error(db2, user_id, str(e))
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            yield f"event: done\ndata: {json.dumps({}, ensure_ascii=False)}\n\n"
            return
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

        full_reply = "".join(parts).strip() or "(no reply)"
        ai_msg = {"role": "assistant", "content": full_reply, "ts": time.time()}

        # Persist with a fresh session so we don't race the outer one.
        async with SessionLocal() as db2:
            fresh = await db2.get(AIConversation, convo_id)
            if fresh is not None:
                fresh.messages = list(fresh.messages) + [user_msg, ai_msg]
                fresh.chunks_used = chunks_used
                await db2.commit()
                await db2.refresh(fresh)
                final = _to_out(fresh).model_dump()
            else:
                final = {}

        yield f"event: done\ndata: {json.dumps(final, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/conversations/{cid}/messages/{msg_idx}/feedback")
async def message_feedback(
    cid: int,
    msg_idx: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Per-turn coach feedback on the user's message at messages[msg_idx]."""
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")
    msgs = list(convo.messages)
    if msg_idx < 0 or msg_idx >= len(msgs) or msgs[msg_idx]["role"] != "user":
        raise HTTPException(400, "no user message at that index")
    learner_reply = msgs[msg_idx]["content"]
    # Use the assistant message immediately before it as the question.
    ai_question = ""
    for j in range(msg_idx - 1, -1, -1):
        if msgs[j]["role"] == "assistant":
            ai_question = msgs[j]["content"]
            break
    chunks = (await db.execute(select(Chunk).where(Chunk.id.in_(convo.target_chunks)))).scalars().all()
    target_texts = [c.text for c in chunks]
    fb = await _llm_call(
        db, user, llm.feedback_on_reply,
        convo.scenario,
        ai_question,
        learner_reply,
        target_texts,
        user.role == "admin",
        await require_override(db, user),
    )
    if fb is None:
        raise HTTPException(502, "feedback unavailable")
    return fb


class TeachbackAnswer(BaseModel):
    answer: str


@router.get("/conversations/{cid}/teachback/question")
async def teachback_question(
    cid: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate the teach-back prompt for this episode."""
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")
    ep = await db.get(Episode, convo.episode_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    chunks = (await db.execute(select(Chunk).where(Chunk.id.in_(convo.target_chunks)))).scalars().all()
    target_texts = [c.text for c in chunks]
    q = await _llm_call(
        db, user, llm.teachback_question,
        ep.title, ep.summary or "", target_texts, user.role == "admin",
        await require_override(db, user),
    )
    return {"question": q, "key_ideas": ep.summary or ""}


@router.post("/conversations/{cid}/teachback/review")
async def teachback_review(
    cid: int,
    body: TeachbackAnswer,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Review the learner's teach-back answer."""
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")
    ep = await db.get(Episode, convo.episode_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    # Re-derive the question deterministically from the same inputs so the
    # review is anchored to the same prompt the learner saw.
    chunks = (await db.execute(select(Chunk).where(Chunk.id.in_(convo.target_chunks)))).scalars().all()
    target_texts = [c.text for c in chunks]
    admin_tier = user.role == "admin"
    override = await require_override(db, user)
    q = await _llm_call(
        db, user, llm.teachback_question,
        ep.title, ep.summary or "", target_texts, admin_tier, override,
    )
    review = await _llm_call(
        db, user, llm.teachback_review,
        q, ep.summary or "", body.answer, admin_tier, override,
    )
    if review is None:
        raise HTTPException(502, "review unavailable")
    return review


@router.post("/conversations/{cid}/hint")
async def message_hint(
    cid: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a model answer the learner can read aloud or adapt."""
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")
    chunks = (await db.execute(select(Chunk).where(Chunk.id.in_(convo.target_chunks)))).scalars().all()
    target_map = {c.id: c.text for c in chunks}
    unused = [t for cid_, t in target_map.items() if cid_ not in convo.chunks_used]
    text_out = await _llm_call(
        db, user, llm.hint_for_reply,
        convo.scenario,
        convo.messages,
        unused or list(target_map.values())[:3],
        user.role == "admin",
        await require_override(db, user),
    )
    return {"hint": text_out}


class FullRecordEvalIn(BaseModel):
    transcript: str
    duration_sec: float
    wpm: float
    chunks_hit: list[str] = []
    chunks_missed: list[str] = []


@router.post("/episodes/{ep_id}/full-record-eval")
async def full_record_eval(
    ep_id: int,
    body: FullRecordEvalIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Grade a learner's full-episode shadowing recording.

    Frontend sends the Web-Speech transcript + observed pace/coverage; we
    pull the original subtitles server-side so the LLM has authoritative
    reference text (not whatever the client constructed)."""
    ep = await db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "episode not found")
    subs = (
        await db.execute(
            select(Subtitle).where(Subtitle.episode_id == ep_id).order_by(Subtitle.seq)
        )
    ).scalars().all()
    original_text = " ".join((s.text_en or "").strip() for s in subs if (s.text_en or "").strip())
    if not original_text:
        raise HTTPException(400, "episode has no subtitles")
    result = await _llm_call(
        db, user, llm.eval_full_record,
        original_text,
        body.transcript,
        body.duration_sec,
        body.wpm,
        body.chunks_hit,
        body.chunks_missed,
        user.role == "admin",
        await require_override(db, user),
    )
    if result is None:
        raise HTTPException(502, "evaluation unavailable")
    return result


@router.delete("/conversations/{cid}/messages/last-turn", response_model=ConversationOut)
async def redo_last_turn(
    cid: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Pop the most recent user+assistant pair so the learner can redo the
    turn.  Keeps the opening assistant message (sent at scenario start) —
    we only drop fully-completed rounds."""
    convo = await db.get(AIConversation, cid)
    if not convo or convo.user_id != user.id:
        raise HTTPException(404, "conversation not found")

    msgs = list(convo.messages)
    # Walk from the end, drop everything back to (and including) the last
    # user message.  If the tail is assistant → user, that's a finished
    # round; drop both.  If there is no user message, nothing to redo.
    last_user = -1
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i]["role"] == "user":
            last_user = i
            break
    if last_user < 0:
        return _to_out(convo)
    msgs = msgs[:last_user]
    convo.messages = msgs

    # Recompute chunks_used from scratch against what's left.
    chunks = (await db.execute(select(Chunk).where(Chunk.id.in_(convo.target_chunks)))).scalars().all()
    used: list[int] = []
    joined = "\n".join(m["content"].lower() for m in msgs if m["role"] == "user")
    for c in chunks:
        if c.text.lower() in joined:
            used.append(c.id)
    convo.chunks_used = sorted(set(used))

    await db.commit()
    await db.refresh(convo)
    return _to_out(convo)


def _to_out(c: AIConversation) -> ConversationOut:
    return ConversationOut(
        id=c.id,
        episode_id=c.episode_id,
        scenario=c.scenario,
        target_chunks=c.target_chunks,
        messages=c.messages,
        chunks_used=c.chunks_used,
        summary=c.summary,
        status=c.status,
    )
