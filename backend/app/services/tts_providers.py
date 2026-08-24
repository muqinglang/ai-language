"""朗读 provider 的注册表 —— 加一家时只改这个文件。

目前只有 MiniMax。CosyVoice（阿里云百炼）曾经在这里，2026-08-22 摘掉了：
它的中文音色念英文发音不准，而这是个练发音的产品 —— 错误的发音不是"音质
差一点"，是会把人教错。留着当选项就等于说"这个也能用"。

留着注册表这层结构是因为它现在就有用：/api/tts 的分派、设置页的表单、
音色清单都照它渲染，换/加 provider 不用改别处。
"""
from __future__ import annotations

from . import tts_minimax

DEFAULT_PROVIDER = "minimax"


class TTSProviderError(Exception):
    """任一 provider 的失败，消息已经写成可以给学员看的样子。

    `credential_ok=True` 表示凭据本身没问题，只是这一刻用不了（配额/限流）。
    保存路径据此决定是拒收还是先存下来 —— 见 tts_minimax.MiniMaxError。
    """

    def __init__(self, message: str, credential_ok: bool = False):
        super().__init__(message)
        self.credential_ok = credential_ok


PROVIDERS = {
    "minimax": {
        "label": "MiniMax",
        "hint": "英文音色本身就是英文母语的，念英文更自然。国内直连。",
        "key_url": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        "voice_list_url": tts_minimax.VOICE_LIST_URL,
        "models": tts_minimax.MODELS,
        "voices": tts_minimax.SUGGESTED_VOICES,
        "default_model": tts_minimax.DEFAULT_MODEL,
        "default_voice": tts_minimax.DEFAULT_VOICE,
        "needs_group_id": True,
        # 合成参数变了就 +1。磁盘缓存按文本+音色+模型做 key，参数不在
        # key 里 —— 不动这个数，已经缓存下来的那批错发音会一直被端出来，
        # 表现成"你改了代码但一点没变"。
        "cache_rev": 2,
    },
}


def is_supported(provider: str) -> bool:
    """这个 provider 现在还在不在。

    和 normalize() 分开：normalize 给"该用哪家"一个答案，这个用来发现
    "存着的那家已经没了"。摘掉 CosyVoice 之后，老配置存的是百炼的 key，
    直接拿去调 MiniMax 只会换回一句"API key 无效" —— 那是误导，得让
    调用方能识别出真正的原因并说清楚。
    """
    return (provider or "").strip().lower() in PROVIDERS


def normalize(provider: str) -> str:
    p = (provider or "").strip().lower()
    return p if p in PROVIDERS else DEFAULT_PROVIDER


def cache_rev(provider: str) -> int:
    """这家 provider 的合成参数版本。见 PROVIDERS 里的注释。"""
    return int(PROVIDERS[normalize(provider)].get("cache_rev") or 1)


def defaults(provider: str) -> tuple[str, str]:
    meta = PROVIDERS[normalize(provider)]
    return meta["default_voice"], meta["default_model"]


def synthesize(
    provider: str, text: str, api_key: str, voice: str, model: str,
    group_id: str = "", timeout: float = 30.0,
) -> bytes:
    """合成一段音频。失败统一抛 TTSProviderError。"""
    p = normalize(provider)
    try:
        return tts_minimax.synthesize(text, api_key, voice, model, group_id, timeout)
    except tts_minimax.MiniMaxError as e:
        raise TTSProviderError(
            redact(p, str(e), api_key), credential_ok=e.credential_ok,
        ) from e


def verify(
    provider: str, api_key: str, voice: str, model: str, group_id: str = "",
) -> None:
    """保存前证明这套配置真的能出声。没见它工作过的凭据不入库。"""
    p = normalize(provider)
    try:
        tts_minimax.verify(api_key, voice, model, group_id)
    except tts_minimax.MiniMaxError as e:
        raise TTSProviderError(
            redact(p, str(e), api_key), credential_ok=e.credential_ok,
        ) from e


def redact(provider: str, text: str, api_key: str) -> str:
    return tts_minimax.redact(text, api_key)
