"""Bring-your-own-key settings — /api/me/llm.

A learner can point their AI conversations at their own provider and model.
Three rules shape everything here:

- The key is verified against the provider before it is stored. We never
  save a credential we haven't seen work.
- The key is encrypted at rest and never travels back to the browser; reads
  return a mask ("sk-pro…4f2a") built from the decrypted value.
- The scope is the learner's own AI chat only. The import pipeline keeps
  using the server's keys — one video import would otherwise burn a large
  slice of their quota on work they never asked for.
"""

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import User, UserLLMConfig
from ..services import secrets, tts, tts_providers
from ..services.llm_byok import PROVIDERS, KeyCheckError, LLMOverride, verify

log = logging.getLogger("justspeak.user_llm")

router = APIRouter(prefix="/api/me/llm", tags=["user-llm"])


class ProviderInfo(BaseModel):
    id: str
    label: str
    base_url: str
    default_model: str
    models: list[str]
    # Where to go get a key, one line on what this provider is good for,
    # and a per-model note. Picking a model is the step learners get wrong
    # (deepseek-v4-flash returns empty content and looks like a broken
    # key), so the guidance ships with the options rather than living in
    # a doc nobody opens.
    key_url: str = ""
    hint: str = ""
    notes: dict[str, str] = {}


class LLMSettingsOut(BaseModel):
    """What the settings page renders. Never contains a usable key."""
    # False when the server has no CREDENTIAL_ENC_KEY — the UI hides the
    # whole section rather than offering a form that can only 503.
    available: bool
    configured: bool
    provider: str = ""
    model: str = ""
    base_url: str = ""
    # "sk-pro…4f2a" — enough to recognise, useless to steal.
    key_mask: str = ""
    verified_at: datetime | None = None
    last_error: str = ""
    providers: list[ProviderInfo] = []

    # ---- TTS half（provider 可选），和上面的对话 key 各管各的 ----
    tts_configured: bool = False
    tts_provider: str = ""
    tts_group_id: str = ""
    # 每个 provider 的元信息（label / hint / key_url / 音色 / 模型），
    # 前端照着渲染表单，不在前端写死一份会过期的清单。
    tts_providers: dict = {}
    # 平台自己的 ElevenLabs 是否可用。线上没配 key，那 6 个音色点了也没用 ——
    # 前端据此决定是显示它们，还是提示"先配一个朗读服务"。
    tts_platform_available: bool = False
    tts_voice: str = ""
    tts_model: str = ""
    tts_key_mask: str = ""
    tts_verified_at: datetime | None = None
    tts_last_error: str = ""
    tts_suggested_voices: list[str] = []
    tts_voices_by_model: dict[str, list[str]] = {}
    tts_models: list[dict] = []
    tts_default_voice: str = ""
    tts_default_model: str = ""
    tts_voice_list_url: str = ""
    tts_key_url: str = "https://bailian.console.aliyun.com/?apiKey=1"


class LLMSettingsIn(BaseModel):
    provider: str
    api_key: str
    model: str = ""
    base_url: str = ""


class TTSSettingsIn(BaseModel):
    provider: str = ""
    group_id: str = ""
    # Empty when the learner is only switching voice — the stored key is
    # reused. Sending the key again just to change voice would mean the
    # settings page had to keep it in memory, which it deliberately never
    # does (it is never sent back to the browser in the first place).
    api_key: str = ""
    voice: str = ""
    model: str = ""


def _provider_list() -> list[ProviderInfo]:
    return [
        ProviderInfo(
            id=pid,
            label=meta["label"],
            base_url=meta["base_url"],
            default_model=meta["default_model"],
            models=meta["models"],
            key_url=meta.get("key_url", ""),
            hint=meta.get("hint", ""),
            notes=meta.get("notes", {}),
        )
        for pid, meta in PROVIDERS.items()
    ]


async def _load(db: AsyncSession, user_id: int) -> UserLLMConfig | None:
    return await db.scalar(
        select(UserLLMConfig).where(UserLLMConfig.user_id == user_id)
    )


def _tts_defaults(provider: str = "", model: str = "") -> dict:
    p = tts_providers.normalize(provider)
    meta = tts_providers.PROVIDERS[p]
    by_model = meta.get("voices_by_model") or {}
    voices = by_model.get(model or meta["default_model"]) or meta["voices"]
    return {
        "tts_providers": tts_providers.PROVIDERS,
        "tts_suggested_voices": voices,
        "tts_voices_by_model": by_model,
        "tts_models": meta["models"],
        "tts_default_voice": meta["default_voice"],
        "tts_default_model": meta["default_model"],
        "tts_voice_list_url": meta["voice_list_url"],
        "tts_key_url": meta["key_url"],
        "tts_platform_available": tts.is_configured(),
    }


def _to_out(cfg: UserLLMConfig | None) -> LLMSettingsOut:
    base = LLMSettingsOut(
        available=secrets.secrets_enabled(),
        configured=False,
        providers=_provider_list(),
        **_tts_defaults(),
    )
    if cfg is None:
        return base
    plain = secrets.decrypt(cfg.api_key_enc)
    tts_plain = secrets.decrypt(cfg.tts_api_key_enc) if cfg.tts_api_key_enc else None
    return LLMSettingsOut(
        available=base.available,
        # A row whose ciphertext no longer decrypts (the encryption key was
        # rotated) is reported as unconfigured — the learner is asked to
        # re-enter rather than shown a setting that silently does nothing.
        configured=plain is not None,
        provider=cfg.provider,
        model=cfg.model,
        base_url=cfg.base_url,
        key_mask=secrets.mask(plain) if plain else "",
        verified_at=cfg.verified_at,
        last_error=cfg.last_error if plain else "配置已失效，请重新填写 API key",
        providers=base.providers,
        tts_configured=(
            tts_plain is not None and tts_providers.is_supported(cfg.tts_provider)
        ),
        tts_provider=tts_providers.normalize(cfg.tts_provider),
        tts_group_id=cfg.tts_group_id or "",
        tts_voice=cfg.tts_voice,
        tts_model=cfg.tts_model,
        tts_key_mask=secrets.mask(tts_plain) if tts_plain else "",
        tts_verified_at=cfg.tts_verified_at,
        tts_last_error=(
            "原来的 CosyVoice 朗读已下架（念英文发音不准，会把人教错）。"
            "请换成 MiniMax 重新配置一次。"
            if tts_plain is not None and not tts_providers.is_supported(cfg.tts_provider)
            else cfg.tts_last_error
            if tts_plain or not cfg.tts_api_key_enc
            else "语音配置已失效，请重新填写 API key"
        ),
        **_tts_defaults(cfg.tts_provider, cfg.tts_model),
    )


async def load_override(db: AsyncSession, user: User) -> LLMOverride | None:
    """The learner's credentials for a conversation call, or None.

    Returns None for every "not usable" case — no row, feature disabled,
    ciphertext that no longer decrypts — so callers can pass the result
    straight through and get server-key behaviour when it's absent.
    """
    if not secrets.secrets_enabled():
        return None
    cfg = await _load(db, user.id)
    if cfg is None:
        return None
    key = secrets.decrypt(cfg.api_key_enc)
    if not key or not cfg.model:
        return None
    return LLMOverride(
        provider=cfg.provider,
        api_key=key,
        model=cfg.model,
        base_url=cfg.base_url,
    )


async def require_override(db: AsyncSession, user: User) -> LLMOverride:
    """The learner's own credentials, or a 428 telling them to set them up.

    The platform's own keys do NOT serve learner-facing calls at all —
    not as a default for people who haven't configured anything, not as a
    retry when someone's key fails. A learner uses the model they chose or
    they get an error saying so. The platform key is left for exactly one
    thing: the import pipeline, which is admin work nobody opted into.

    428 (Precondition Required) rather than 402/403: nothing is wrong with
    the account, there is a setup step missing. `code` is what the
    frontend switches on to render a link to the settings card instead of
    a generic red box.
    """
    override = await load_override(db, user)
    if override is not None:
        return override
    cfg = await _load(db, user.id)
    stale = cfg is not None and not secrets.decrypt(cfg.api_key_enc)
    raise HTTPException(
        428,
        {
            "code": "byok_required",
            "message": (
                "你保存的 API key 已失效，请到「我的 → 我的 API key」重新填写"
                if stale
                else "AI 功能需要你自己的 API key。到「我的 → 我的 API key」填一个就能用"
            ),
        },
    )


class TTSCredentials(BaseModel):
    """学员自己的朗读凭据，解好可以直接调。"""
    provider: str
    api_key: str
    voice: str
    model: str
    group_id: str = ""


async def load_tts_override(db: AsyncSession, user: User) -> TTSCredentials | None:
    """The learner's own CosyVoice credentials, or None.

    None for every unusable case (no row, no TTS key, feature disabled,
    ciphertext that no longer decrypts) so /api/tts can fall through to
    the platform voice or to a 503 that the browser answers with Web
    Speech. Unlike the chat path this deliberately does NOT 428: silence
    is not an error state, it's just a less pleasant reading voice.
    """
    if not secrets.secrets_enabled():
        return None
    cfg = await _load(db, user.id)
    if cfg is None or not cfg.tts_api_key_enc:
        return None
    key = secrets.decrypt(cfg.tts_api_key_enc)
    if not key:
        return None
    # 存的是已经下架的 provider（CosyVoice）→ 当作没配。拿百炼的 key 去调
    # MiniMax 只会换回"API key 无效"，那是误导；宁可回落到浏览器朗读，让
    # 设置页去说清楚该重配。
    if not tts_providers.is_supported(cfg.tts_provider):
        return None
    provider = tts_providers.normalize(cfg.tts_provider)
    dv, dm = tts_providers.defaults(provider)
    return TTSCredentials(
        provider=provider,
        api_key=key,
        voice=cfg.tts_voice or dv,
        model=cfg.tts_model or dm,
        group_id=cfg.tts_group_id or "",
    )


async def note_tts_error(db: AsyncSession, user_id: int, message: str) -> None:
    """Same bookkeeping as note_byok_error, for the voice half."""
    try:
        cfg = await _load(db, user_id)
        if cfg is None:
            return
        cfg.tts_last_error = message[:500]
        await db.commit()
    except Exception as e:  # pragma: no cover - bookkeeping only
        log.warning("could not record tts error for user %s: %s", user_id, e)


async def note_byok_error(db: AsyncSession, user_id: int, message: str) -> None:
    """Remember why a learner's key failed, for the settings page to show.

    Best-effort by design: this runs on the failure path of a chat request
    that is already being turned into an error, so a bookkeeping problem
    here must not replace the real error with a database one.
    """
    try:
        cfg = await _load(db, user_id)
        if cfg is None:
            return
        cfg.last_error = message[:500]
        await db.commit()
    except Exception as e:  # pragma: no cover - bookkeeping only
        log.warning("could not record byok error for user %s: %s", user_id, e)


@router.get("", response_model=LLMSettingsOut)
async def get_settings(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    return _to_out(await _load(db, user.id))


@router.put("", response_model=LLMSettingsOut)
async def save_settings(
    body: LLMSettingsIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    if not secrets.secrets_enabled():
        raise HTTPException(
            503,
            "服务端未配置 CREDENTIAL_ENC_KEY，无法安全保存 API key",
        )
    provider = body.provider.strip().lower()
    if provider not in PROVIDERS:
        raise HTTPException(400, f"不支持的 provider：{body.provider}")

    model = body.model.strip() or PROVIDERS[provider]["default_model"]
    base_url = body.base_url.strip()
    override = LLMOverride(
        provider=provider,
        api_key=body.api_key.strip(),
        model=model,
        base_url=base_url,
    )

    # Prove it works before storing it. Blocking network call, so off the
    # event loop.
    try:
        await asyncio.to_thread(verify, override)
    except KeyCheckError as e:
        raise HTTPException(400, str(e))

    cfg = await _load(db, user.id)
    if cfg is None:
        cfg = UserLLMConfig(user_id=user.id)
        db.add(cfg)
    cfg.provider = provider
    cfg.api_key_enc = secrets.encrypt(override.api_key)
    cfg.model = model
    cfg.base_url = base_url
    cfg.verified_at = datetime.now(timezone.utc)
    cfg.last_error = ""
    await db.commit()
    await db.refresh(cfg)
    return _to_out(cfg)


@router.post("/test", response_model=LLMSettingsOut)
async def test_settings(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-run the round trip against the stored key.

    Useful after a key has been sitting for a while — quotas lapse and
    keys get revoked outside our view.
    """
    cfg = await _load(db, user.id)
    if cfg is None:
        raise HTTPException(404, "尚未配置")
    override = await load_override(db, user)
    if override is None:
        raise HTTPException(400, "配置已失效，请重新填写 API key")

    try:
        await asyncio.to_thread(verify, override)
    except KeyCheckError as e:
        cfg.last_error = str(e)
        await db.commit()
        await db.refresh(cfg)
        raise HTTPException(400, str(e))

    cfg.verified_at = datetime.now(timezone.utc)
    cfg.last_error = ""
    await db.commit()
    await db.refresh(cfg)
    return _to_out(cfg)


@router.delete("", response_model=LLMSettingsOut)
async def delete_settings(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    cfg = await _load(db, user.id)
    if cfg is None:
        return _to_out(None)
    # The row holds two independent credentials. Deleting the chat key
    # must not silently take the learner's voice key with it.
    if cfg.tts_api_key_enc:
        cfg.provider = ""
        cfg.api_key_enc = ""
        cfg.model = ""
        cfg.base_url = ""
        cfg.verified_at = None
        cfg.last_error = ""
        await db.commit()
        await db.refresh(cfg)
        return _to_out(cfg)
    await db.delete(cfg)
    await db.commit()
    return _to_out(None)


# ---------------------------------------------------------------- TTS half
#
# Same three rules as the chat key above: verified before it is stored,
# encrypted at rest, never sent back to the browser. The difference is what
# happens when it is missing — no 428. A learner without a voice key still
# gets read to, just by the browser's free Web Speech, so silence here is a
# downgrade rather than a blocked feature.


@router.put("/tts", response_model=LLMSettingsOut)
async def save_tts_settings(
    body: TTSSettingsIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    if not secrets.secrets_enabled():
        raise HTTPException(
            503, "服务端未配置 CREDENTIAL_ENC_KEY，无法安全保存 API key",
        )
    cfg = await _load(db, user.id)
    provider = tts_providers.normalize(
        body.provider or (cfg.tts_provider if cfg else "")
    )
    # 换 provider 时不能沿用旧 key —— 那是另一家的凭据。
    switching = bool(cfg and tts_providers.normalize(cfg.tts_provider) != provider)
    api_key = body.api_key.strip()
    if not api_key:
        existing = None if switching else await load_tts_override(db, user)
        if existing is None:
            raise HTTPException(
                400,
                "换 provider 需要填新的 API key" if switching else "API key 不能为空",
            )
        api_key = existing.api_key

    dv, dm = tts_providers.defaults(provider)
    keep = (cfg is not None) and not switching
    voice = body.voice.strip() or (cfg.tts_voice if keep else "") or dv
    model = body.model.strip() or (cfg.tts_model if keep else "") or dm
    group_id = body.group_id.strip() or (cfg.tts_group_id if keep else "") or ""

    # 存之前真合成两个词。音色名写错是最常见的错误，而哪些音色存在只有
    # provider 说了算 —— 让它来答，别在这里维护一份会过期的清单。
    #
    # 例外：配额用满不算"凭据不对"。撞到它恰恰说明 key 通过了认证，而配额
    # 明天就恢复。这时候拒收会造成死锁 —— 好 key 永远存不进去，用户也就
    # 永远配不上这个服务。所以先存下来，把原因记在 last_error 上。
    quota_note = ""
    try:
        await asyncio.to_thread(
            tts_providers.verify, provider, api_key, voice, model, group_id,
        )
    except tts_providers.TTSProviderError as e:
        if not e.credential_ok:
            raise HTTPException(400, str(e))
        quota_note = str(e)

    if cfg is None:
        cfg = UserLLMConfig(user_id=user.id)
        db.add(cfg)
    cfg.tts_provider = provider
    cfg.tts_group_id = group_id
    cfg.tts_api_key_enc = secrets.encrypt(api_key)
    cfg.tts_voice = voice
    cfg.tts_model = model
    # 配额受阻时不算"验证通过" —— verified_at 是"我们亲眼见它工作过"的
    # 时间戳，别拿一次没出声的调用去盖它。
    if not quota_note:
        cfg.tts_verified_at = datetime.now(timezone.utc)
    cfg.tts_last_error = quota_note
    await db.commit()
    await db.refresh(cfg)
    return _to_out(cfg)


@router.post("/tts/test", response_model=LLMSettingsOut)
async def test_tts_settings(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    cfg = await _load(db, user.id)
    creds = await load_tts_override(db, user)
    if cfg is None or creds is None:
        raise HTTPException(400, "尚未配置语音 API key，或配置已失效")
    try:
        await asyncio.to_thread(
            tts_providers.verify, creds.provider, creds.api_key,
            creds.voice, creds.model, creds.group_id,
        )
    except tts_providers.TTSProviderError as e:
        cfg.tts_last_error = str(e)
        await db.commit()
        await db.refresh(cfg)
        raise HTTPException(400, cfg.tts_last_error)

    cfg.tts_verified_at = datetime.now(timezone.utc)
    cfg.tts_last_error = ""
    await db.commit()
    await db.refresh(cfg)
    return _to_out(cfg)


@router.delete("/tts", response_model=LLMSettingsOut)
async def delete_tts_settings(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    cfg = await _load(db, user.id)
    if cfg is None:
        return _to_out(None)
    cfg.tts_api_key_enc = ""
    cfg.tts_group_id = ""
    cfg.tts_voice = ""
    cfg.tts_model = ""
    cfg.tts_verified_at = None
    cfg.tts_last_error = ""
    # Nothing left in the row at all → drop it, matching the chat-side
    # delete so an emptied config doesn't linger as a phantom "configured".
    if not cfg.api_key_enc:
        await db.delete(cfg)
        await db.commit()
        return _to_out(None)
    await db.commit()
    await db.refresh(cfg)
    return _to_out(cfg)
