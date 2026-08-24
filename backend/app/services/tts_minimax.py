"""MiniMax T2A —— 朗读的另一个 provider（和 CosyVoice 并列）。

为什么加它：CosyVoice 的中文音色念英文是"中国人说英语"的味道，而这个
产品朗读的全是英文。MiniMax 有一批本身就是英文的音色
（English_Graceful_Lady 等），在这件事上是更对的工具。

为什么不直接替掉 CosyVoice：学员已经配好、验证过、正在用的凭据不该因为
我们加了个新选项就作废。两个 provider 并列，各自存自己的 key。

协议（实测 https://api.minimaxi.com/v1/t2a_v2，从杭州 ECS 0.18s 可达）：

    POST /v1/t2a_v2
    Authorization: Bearer <key>
    {"model": "speech-02-hd", "text": ...,
     "voice_setting": {"voice_id": ..., "speed": 1.0},
     "audio_setting": {"format": "mp3", "sample_rate": 32000}}

**认证失败也返回 HTTP 200**，真实状态在 base_resp.status_code（0 = 成功）。
照着"200 即成功"写会拿到一段空音频，然后在播放时才炸 —— 所以下面每次都
先看 base_resp。

音频是 **hex 字符串**（不是 base64，也不是 URL），在 data.audio。
"""
from __future__ import annotations

import binascii
import logging

import httpx

log = logging.getLogger("tts.minimax")

# 国内直连节点。api.minimax.io 是国际站，从阿里云走也通但慢一个数量级
# （1.17s vs 0.18s，实测）。
ENDPOINT = "https://api.minimaxi.com/v1/t2a_v2"

DEFAULT_MODEL = "speech-02-hd"
DEFAULT_VOICE = "English_Graceful_Lady"

MODELS = [
    {"id": "speech-02-hd", "label": "speech-02-hd（音质更好）"},
    {"id": "speech-02-turbo", "label": "speech-02-turbo（更快更便宜）"},
]

# 和 CosyVoice 那份一样：候选，不是权威清单。MiniMax 也在不断加音色，
# 写死一份过时的清单会把合法音色挡在外面。表单里音色是可输入的，保存时
# 真合成一次由 provider 裁决。
SUGGESTED_VOICES = [
    "English_Graceful_Lady",
    "English_Insightful_Speaker",
    "English_radiant_girl",
    "English_Persuasive_Man",
]

VOICE_LIST_URL = "https://platform.minimaxi.com/document/T2A%20V2"


# 这些码代表"认证通过了，但这次用不了" —— 配额、限流、余额。
_QUOTA_CODES = {1002, 1008, 2056}


class MiniMaxError(Exception):
    """一次合成失败，消息已经写成可以直接给学员看的样子。

    `credential_ok` 区分两类失败，这个区别很实在：

      False —— 凭据本身不对（key 无效、音色不存在）。这种绝不能存。
      True  —— 凭据是好的，只是这一刻用不了（配额用满、限流）。撞到
               2056 恰恰证明 key 通过了认证 —— 认证不过根本谈不上配额。

    为什么要分：保存前必须验证，而验证要真合成一次。如果不分，一个配额
    用满的账户就会陷入死锁 —— 好 key 永远存不进去，用户也就永远配不上
    这个服务，而配额明天就恢复了。
    """

    def __init__(self, message: str, credential_ok: bool = False):
        super().__init__(message)
        self.credential_ok = credential_ok


def _explain(status_code: int, msg: str) -> str:
    """把 MiniMax 的错误码翻成一句学员能照着做的话。"""
    msg = (msg or "").strip()
    if status_code in (1004, 1004001):
        return "API key 无效，请检查是否复制完整"
    if status_code == 1008:
        return "账户余额不足，请到 MiniMax 控制台充值"
    if status_code == 2056:
        # MiniMax 的套餐额度有 5 小时窗口和周窗口两层，而"已购积分"是另一个
        # 池子。官方 FAQ 说积分会自动补充套餐超出的部分、也能在没有套餐席位
        # 时单独使用 —— 所以有积分还撞到这个码，通常是 ① 5 小时窗口刚好用满
        # ② 积分挂在另一个 Group 下而请求没带 GroupId。两条都写出来，比只
        # 回一句"用量上限"有用。
        return (
            "MiniMax 套餐用量已达上限。若你账户里有积分：先确认 5 小时/周"
            "窗口是否刚好用满（会自动恢复），再检查是否需要在下面填 GroupId"
            "（积分挂在某个 Group 下时，不带 GroupId 会算到别处）"
        )
    if status_code == 2013:
        return f"参数被拒绝：{msg}。最常见的是音色名写错了"
    if status_code == 1002:
        return "调用太频繁，稍后再试"
    if status_code == 1039:
        return "触发了内容风控，换一句试试"
    return f"合成失败（{status_code}）：{msg}" if msg else f"合成失败（{status_code}）"


def synthesize(
    text: str,
    api_key: str,
    voice: str = "",
    model: str = "",
    group_id: str = "",
    timeout: float = 30.0,
) -> bytes:
    """mp3 bytes，计在 `api_key` 名下。失败抛 MiniMaxError。"""
    text = (text or "").strip()
    if not text:
        raise MiniMaxError("没有要合成的文本")
    if not api_key:
        raise MiniMaxError("缺少 API key")

    url = ENDPOINT
    # 部分国内账号要求带 GroupId；不填就不带，让 provider 自己说需不需要。
    if group_id.strip():
        url = f"{ENDPOINT}?GroupId={group_id.strip()}"

    payload = {
        "model": model or DEFAULT_MODEL,
        "text": text,
        "stream": False,
        "voice_setting": {
            "voice_id": voice or DEFAULT_VOICE,
            "speed": 1.0,
            "vol": 1.0,
            "pitch": 0,
        },
        "audio_setting": {"format": "mp3", "sample_rate": 32000, "channel": 1},
        # 不给这个，模型自己猜语言，孤零零一个英文单词最容易猜错 ——
        # 实测 "niche" 被念成 "nike"。单词卡上就是一个词、没有上下文，
        # 正是最需要显式绑定语言的场景。这个站朗读的全是英文，所以写死。
        "language_boost": "English",
    }
    try:
        resp = httpx.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
    except Exception as e:
        raise MiniMaxError(f"连不上 MiniMax：{e}") from e

    try:
        body = resp.json()
    except Exception:
        raise MiniMaxError(f"返回不是 JSON（HTTP {resp.status_code}）")

    # 关键：HTTP 200 不代表成功。
    base = body.get("base_resp") or {}
    code = int(base.get("status_code") or 0)
    if code != 0:
        # 配额类错误 = key 是好的，只是这会儿用不了。
        raise MiniMaxError(
            _explain(code, str(base.get("status_msg") or "")),
            credential_ok=code in _QUOTA_CODES,
        )
    if resp.status_code != 200:
        raise MiniMaxError(f"合成失败（HTTP {resp.status_code}）")

    audio_hex = ((body.get("data") or {}).get("audio")) or ""
    if not audio_hex:
        # 200 + status_code 0 却没有音频 = 接口形状变了。说出来，别返回
        # 一段静音让人以为是音量问题。
        raise MiniMaxError("返回里没有音频数据（接口格式可能变了）")
    try:
        return binascii.unhexlify(audio_hex)
    except Exception as e:
        raise MiniMaxError(f"音频解码失败：{e}") from e


_VERIFY_TEXT = "Hello there."


def verify(api_key: str, voice: str = "", model: str = "", group_id: str = "") -> None:
    """保存前证明这套配置真的能合成。和 llm_byok.verify 同一条规矩：
    没见它工作过的凭据不入库。"""
    audio = synthesize(_VERIFY_TEXT, api_key, voice, model, group_id, timeout=30.0)
    if not audio:
        raise MiniMaxError("合成成功但没有返回音频，请换一个音色再试")


def redact(text: str, api_key: str) -> str:
    if api_key and api_key in text:
        text = text.replace(api_key, "sk-***")
    return text
