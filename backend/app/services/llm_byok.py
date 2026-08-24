"""Bring-your-own-key: verify a learner's LLM credentials, and describe them.

Two jobs:

1. `verify()` — actually call the provider before we store anything. A key
   that merely *looks* right is worth nothing; the only proof is a round
   trip. It checks the reply is non-empty, not just that HTTP said 200:
   a reasoning model can spend its whole token budget thinking and return
   an empty string with a perfectly healthy status code (this is exactly
   how deepseek-v4-flash failed here — see llm.py's reasoning-budget note).

2. `LLMOverride` — the value object llm.py takes to route one call through
   the learner's credentials instead of the server's.

Provider errors are translated into something a learner can act on. "401
Unauthorized" tells them nothing; "key 无效或已撤销" tells them what to fix.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

log = logging.getLogger("justspeak.byok")

# Anthropic speaks its own protocol; the rest are OpenAI-compatible and go
# through the openai SDK with a swapped base_url.
PROVIDERS: dict[str, dict] = {
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "models": ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
        "key_url": "https://platform.openai.com/api-keys",
        "hint": "英文最自然，适合对话。国内直连大概率不通，需要自己解决网络。",
        "notes": {
            "gpt-4o-mini": "便宜够用，对话首选",
            "gpt-4o": "更聪明，价格约 gpt-4o-mini 的 20 倍",
            "gpt-4.1-mini": "和 4o-mini 一个档位，长文更稳",
            "gpt-4.1": "最强，也最贵",
        },
    },
    "deepseek": {
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        # v4-pro, not v4-flash: flash routinely spends the entire token
        # budget on reasoning and returns empty content.  Same trap the
        # server-side config comment documents.
        "default_model": "deepseek-v4-pro",
        # deepseek-chat is a legacy alias — it still answers, but it is not
        # in the account's /v1/models listing and it is NOT a reasoning
        # model.  Kept because it is the fast, cheap option; ranked last
        # because its Chinese is visibly rougher (measured: it renders
        # "token" as 「代币」, v4-pro keeps "token").
        "models": ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"],
        "key_url": "https://platform.deepseek.com/api_keys",
        "hint": "国内直连、最便宜，中文解释也好。推荐给大多数人。",
        "notes": {
            "deepseek-v4-pro": "推荐。中文最准，本站默认用的就是它；会先思考，回复稍慢",
            "deepseek-v4-flash": "不建议：思考容易把额度花光，经常返回空内容",
            "deepseek-chat": "最快最省，但中文偏生硬（会把 token 译成「代币」）",
        },
    },
    "anthropic": {
        "label": "Anthropic (Claude)",
        "base_url": "",  # uses the anthropic SDK, not a base_url
        "default_model": "claude-sonnet-5",
        "models": ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"],
        "key_url": "https://console.anthropic.com/settings/keys",
        "hint": "英文表达最讲究。同样需要自己解决网络。",
        "notes": {
            "claude-sonnet-5": "均衡之选",
            "claude-opus-5": "最强，最贵",
            "claude-haiku-4-5": "最快最便宜",
        },
    },
    "custom": {
        "label": "自定义（OpenAI 兼容）",
        "base_url": "",  # the user supplies it
        "default_model": "",
        "models": [],
        "key_url": "",
        "hint": "任何 OpenAI 兼容的接口都行（如各家中转、本地 Ollama）。需要自己填 API 地址和模型名。",
        "notes": {},
    },
}

# How long a verification round trip may take.  Short on purpose — this
# runs while a learner watches a spinner in the settings dialog.
_VERIFY_TIMEOUT = 30.0
# Generous for a one-word answer, but reasoning models draw their thinking
# from the same budget; too small and a working key looks broken.
_VERIFY_MAX_TOKENS = 512

_VERIFY_SYSTEM = "You are a connectivity test. Reply with the single word OK."
_VERIFY_USER = "Say OK."


class KeyCheckError(Exception):
    """A verification failure, already phrased for the learner."""


@dataclass(frozen=True)
class LLMOverride:
    """One learner's credentials, resolved and ready to call."""

    provider: str
    api_key: str
    model: str
    base_url: str = ""

    @property
    def is_anthropic(self) -> bool:
        return self.provider == "anthropic"

    def resolved_base_url(self) -> str:
        return self.base_url or PROVIDERS.get(self.provider, {}).get("base_url", "")


def redact(text: str, secret: str) -> str:
    """Blank out `secret` wherever it appears in `text`.

    Two of the branches below pass provider text through to the learner,
    and one of those ends up stored in user_llm_configs.last_error. Every
    provider we know of masks the key in its own error messages, but "no
    provider does that today" is not a property we control — and a key
    that leaks into a stored error message is a key we handed to the next
    thing that reads that column. Cheap to make impossible.
    """
    if not secret or len(secret) < 8:
        return text
    return text.replace(secret, "«已隐藏的 key»")


def humanize_provider_error(
    provider: str, model: str, err: Exception, api_key: str = "",
) -> str:
    """Turn a provider exception into something the learner can act on."""
    status = getattr(err, "status_code", None)
    text = redact(str(err), api_key)
    low = text.lower()

    if status == 401 or "invalid_api_key" in low or "unauthorized" in low:
        return "key 无效或已撤销，请检查是否复制完整"
    if status == 403 or "permission" in low:
        return f"该 key 没有调用 {model} 的权限"
    # Providers disagree on the status for an unknown model — OpenAI 404s,
    # DeepSeek 400s with the valid names in the body. Match on the message
    # too, and pass their text through: "supported names are X or Y" is
    # more useful than anything we could write.
    if status == 404 or "model_not_found" in low or "does not exist" in low:
        return f"模型名「{model}」不存在，请确认拼写或换一个模型"
    if "model" in low and ("supported" in low or "not found" in low or "unknown" in low):
        detail = re.sub(r"\s+", " ", text)
        m = re.search(r"'message': '([^']+)'", detail) or re.search(r'"message": "([^"]+)"', detail)
        hint = m.group(1) if m else detail[:160]
        return f"模型名「{model}」有问题：{hint}"
    if status == 429 or "rate limit" in low or "quota" in low:
        return "额度用尽或请求太频繁，稍后再试"
    if status == 402 or "insufficient" in low or "balance" in low:
        return "账户余额不足"
    if "timeout" in low or "timed out" in low:
        return "连接超时，请检查网络或 API 地址"
    if "connect" in low or "ssl" in low or "name resolution" in low:
        return "连不上服务器，请检查 API 地址是否正确"
    # Trim provider noise — a raw traceback in a settings dialog helps nobody,
    # but hiding it entirely makes odd failures unfixable.
    brief = re.sub(r"\s+", " ", text)[:160]
    log.warning("byok verify failed provider=%s model=%s: %s", provider, model, text)
    return f"调用失败：{brief}"


def _verify_openai_compatible(key: str, model: str, base_url: str) -> str:
    from openai import OpenAI  # type: ignore

    client = OpenAI(api_key=key, base_url=base_url or None, timeout=_VERIFY_TIMEOUT)
    resp = client.chat.completions.create(
        model=model,
        max_tokens=_VERIFY_MAX_TOKENS,
        messages=[
            {"role": "system", "content": _VERIFY_SYSTEM},
            {"role": "user", "content": _VERIFY_USER},
        ],
    )
    return (resp.choices[0].message.content or "").strip()


def _verify_anthropic(key: str, model: str) -> str:
    import anthropic  # type: ignore

    client = anthropic.Anthropic(api_key=key, timeout=_VERIFY_TIMEOUT)
    resp = client.messages.create(
        model=model,
        max_tokens=_VERIFY_MAX_TOKENS,
        system=_VERIFY_SYSTEM,
        messages=[{"role": "user", "content": _VERIFY_USER}],
    )
    parts = [b.text for b in resp.content if getattr(b, "type", "") == "text"]
    return "".join(parts).strip()


def verify(override: LLMOverride) -> None:
    """Prove the credentials work, or raise KeyCheckError explaining why not.

    Blocking — call it from a worker thread, not the event loop.
    """
    if not override.api_key.strip():
        raise KeyCheckError("请填写 API key")
    if not override.model.strip():
        raise KeyCheckError("请填写模型名")
    if override.provider == "custom" and not override.resolved_base_url():
        raise KeyCheckError("自定义 provider 需要填写 API 地址")

    try:
        if override.is_anthropic:
            reply = _verify_anthropic(override.api_key, override.model)
        else:
            reply = _verify_openai_compatible(
                override.api_key, override.model, override.resolved_base_url()
            )
    except ImportError as e:
        raise KeyCheckError(f"服务端缺少 {override.provider} 的 SDK（{e}）") from e
    except Exception as e:
        raise KeyCheckError(
            humanize_provider_error(
                override.provider, override.model, e, override.api_key
            )
        ) from e

    # HTTP 200 is not success.  A reasoning model that burns its whole
    # budget on thinking returns an empty string with a clean status code,
    # and would then fail silently on every real conversation.
    if not reply:
        raise KeyCheckError(
            f"模型「{override.model}」返回了空内容"
            "（推理型模型常把 token 全花在思考上）。"
            "换一个模型试试，比如 deepseek-v4-pro 或 gpt-4o-mini"
        )
