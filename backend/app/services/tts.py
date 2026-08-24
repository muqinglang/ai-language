"""ElevenLabs TTS proxy with disk cache + per-key rotation.

Every call is keyed by sha256(text + voice_id + model) and cached under
/app/media/tts/{hash}.mp3 so repeated playbacks of the same sentence
don't rack up the per-character bill.

The `synthesize()` function is deliberately sync (uses httpx.Client)
because it's called from the FastAPI handler inside asyncio.to_thread
— the ElevenLabs REST call takes ~500-1500ms and we don't want to
block the event loop.

Multi-key rotation (added 2026):
- `ELEVENLABS_API_KEYS=sk_a,sk_b,sk_c` chains keys.  When a key returns
  401/402/429 it goes into a 1-hour per-key cooldown and we retry the
  same request with the next key.  This is meant for stacking free-tier
  accounts to extend monthly character headroom before falling back to
  Web Speech.
- `ELEVENLABS_API_KEY` (singular) still works; if both are set, the
  plural form wins.

Quota signaling:
- Returns `(audio | None, quota_out: bool)` from synthesize_with_status.
- `quota_out=True` only when ALL keys are cooled and the request had to
  give up — the router 402s, the frontend caches that and falls back to
  Web Speech for the rest of the session.
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

import httpx

from ..config import settings
from . import tts_providers

log = logging.getLogger("tts")

_CACHE_DIR = Path("/app/media/tts")
_CACHE_DIR.mkdir(parents=True, exist_ok=True)

_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"

# Per-key cooldown.  When a key returns 401/402/429 we record the wall
# time here and skip the key for `_QUOTA_COOLDOWN_SEC` seconds.  Reset
# on process restart.  Keyed by raw API key string (which is fine — this
# dict never leaves the process).
_QUOTA_COOLDOWN_SEC = 3600.0
_key_cooldowns: dict[str, float] = {}


def _cache_key(text: str, voice_id: str, model: str, provider: str = "") -> str:
    h = hashlib.sha256()
    h.update(text.encode("utf-8"))
    h.update(b"\x00")
    h.update(voice_id.encode("utf-8"))
    h.update(b"\x00")
    h.update(model.encode("utf-8"))
    if provider:
        # Only mixed in for non-ElevenLabs providers, so every file
        # cached before CosyVoice existed keeps its name and stays warm.
        h.update(b"\x00")
        h.update(provider.encode("utf-8"))
    return h.hexdigest()


def _cache_path(key: str) -> Path:
    return _CACHE_DIR / f"{key}.mp3"


def _all_keys() -> list[str]:
    """All configured keys, plural form winning when both are set.

    Plural form is comma-separated, whitespace-stripped, blanks dropped.
    Order is preserved — first key tried first.
    """
    if settings.elevenlabs_api_keys:
        keys = [k.strip() for k in settings.elevenlabs_api_keys.split(",") if k.strip()]
        if keys:
            return keys
    if settings.elevenlabs_api_key:
        return [settings.elevenlabs_api_key]
    return []


def _key_cooled(key: str, now: float | None = None) -> bool:
    ts = _key_cooldowns.get(key)
    if ts is None:
        return False
    n = now if now is not None else time.time()
    return (n - ts) < _QUOTA_COOLDOWN_SEC


def is_configured() -> bool:
    # tts_disabled is an explicit prod kill-switch so even if a key is
    # in env by accident, the endpoint returns 503 and the frontend
    # falls back to Web Speech.  Used on the mainland-facing deploy.
    if settings.tts_disabled:
        return False
    return bool(_all_keys())


def is_quota_out() -> bool:
    """True when ALL configured keys are inside cooldown.

    Caller (router) returns 402 in that case so the frontend skips the
    fetch and falls back to Web Speech for the rest of the session.
    """
    keys = _all_keys()
    if not keys:
        return False
    now = time.time()
    return all(_key_cooled(k, now) for k in keys)


def synthesize_byok_cached(
    provider: str,
    text: str,
    api_key: str,
    voice: str,
    model: str,
    group_id: str = "",
    timeout: float = 30.0,
) -> bytes | str:
    """学员自己 key 的朗读，走和 ElevenLabs 同一个磁盘缓存。

    Returns mp3 bytes on success, or the error *message* (a str) on
    failure — the caller needs the text to store on the learner's config
    row, and raising through `asyncio.to_thread` would lose the
    already-humanised message in a traceback.

    The cache is shared across learners on purpose: it is keyed by the
    text, not the account, so a cache hit costs nobody anything. It never
    spends one learner's quota on another's request — only the miss
    calls the provider, and the miss is billed to whoever triggered it.
    """
    text = (text or "").strip()
    if not text:
        return "没有要合成的文本"
    prov = tts_providers.normalize(provider)
    # 版本号进 key：合成参数改了（比如给 MiniMax 加 language_boost），
    # 老文件就该作废，而不是继续端出改之前的发音。
    cache_id = _cache_key(text, voice, model, provider=f"{prov}#{tts_providers.cache_rev(prov)}")
    path = _cache_path(cache_id)
    if path.is_file():
        try:
            return path.read_bytes()
        except Exception as e:
            log.warning("tts cache read failed %s: %s", path, e)

    try:
        audio = tts_providers.synthesize(
            provider, text, api_key, voice, model, group_id, timeout,
        )
    except tts_providers.TTSProviderError as e:
        return str(e)
    except Exception as e:  # pragma: no cover - defensive
        log.warning("%s unexpected failure: %s", provider, e)
        return tts_providers.redact(provider, f"语音合成失败：{e}", api_key)

    if not audio:
        return "语音合成返回为空"
    try:
        path.write_bytes(audio)
    except Exception as e:
        log.warning("tts cache write failed %s: %s", path, e)
    return audio


def synthesize(
    text: str,
    voice_id: str | None = None,
    model: str | None = None,
    timeout: float = 30.0,
) -> bytes | None:
    """Return mp3 bytes for the given text, or None if all keys fail.

    Backwards-compatible wrapper around `synthesize_with_status()`.
    """
    audio, _quota_out = synthesize_with_status(text, voice_id, model, timeout)
    return audio


def synthesize_with_status(
    text: str,
    voice_id: str | None = None,
    model: str | None = None,
    timeout: float = 30.0,
) -> tuple[bytes | None, bool]:
    """Synthesize with per-key rotation.

    Returns (audio | None, quota_out: bool):
    - (bytes, False)  → success (cache hit OR live with at least one key)
    - (None,  True)   → every configured key responded 401/402/429
                       this round — frontend should fall back permanently
    - (None,  False)  → transient failure (5xx, network, decode) on the
                       first key tried; the next call may succeed without
                       poisoning anyone's cooldown
    """
    text = (text or "").strip()
    if not text or not is_configured():
        return (None, False)

    voice = voice_id or settings.elevenlabs_voice_id
    mdl = model or settings.elevenlabs_model
    cache_id = _cache_key(text, voice, mdl)
    path = _cache_path(cache_id)
    if path.is_file():
        try:
            return (path.read_bytes(), False)
        except Exception as e:
            log.warning("tts cache read failed %s: %s", path, e)

    keys = _all_keys()
    saw_quota = False
    for idx, api_key in enumerate(keys):
        if _key_cooled(api_key):
            continue
        try:
            resp = httpx.post(
                _ENDPOINT.format(voice_id=voice),
                headers={
                    "xi-api-key": api_key,
                    "accept": "audio/mpeg",
                    "content-type": "application/json",
                },
                json={
                    "text": text,
                    "model_id": mdl,
                    # Defaults tuned for clear, moderately expressive reading.
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.75,
                        "style": 0.0,
                        "use_speaker_boost": True,
                    },
                },
                timeout=timeout,
            )
        except Exception as e:
            log.warning("elevenlabs request failed (key#%d): %s", idx, e)
            # Transient — don't burn other keys for what may be a flaky
            # network on this single attempt.
            return (None, False)

        sc = resp.status_code
        if sc in (401, 402, 429):
            # Quota / auth / rate-limit on this key only.  Cool it and
            # try the next one in the chain.
            _key_cooldowns[api_key] = time.time()
            saw_quota = True
            log.warning(
                "elevenlabs key#%d returned %d → 1h cooldown; %s",
                idx, sc,
                "rotating to key#%d" % (idx + 1) if idx + 1 < len(keys) else "no more keys",
            )
            continue
        if sc != 200:
            log.warning("elevenlabs key#%d returned %d: %s", idx, sc, resp.text[:200])
            # Non-quota error — don't burn other keys.
            return (None, False)

        # Success
        audio = resp.content
        try:
            path.write_bytes(audio)
        except Exception as e:
            log.warning("tts cache write failed %s: %s", path, e)
        return (audio, False)

    # Walked the whole chain without a 200.  If at least one key replied
    # with 401/402/429, treat the whole call as quota_out so the
    # frontend caches the cooldown.  Otherwise it's all-cooled-already.
    return (None, saw_quota or is_quota_out())
