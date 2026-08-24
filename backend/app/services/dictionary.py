"""Tiered fallback for /words/lookup.

Order on the route is: LLM (context-aware) → on failure check our
cache for a prior good answer → on miss call Free Dictionary API
(community English dictionary, no API key) → on miss raise 502.
Every success — LLM or fallback — writes the cache. Once a word has
been looked up once and the LLM trio went down, subsequent looks-up
serve a cached answer instead of "查询失败".

Free Dictionary returns English-only payloads, so cache rows carry
`source` ("llm" | "dict") and the frontend renders a "中文释义待补"
hint when the served row is dict-sourced.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import DictionaryCache

log = logging.getLogger("dictionary")

_FREE_DICT_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"
_HTTP_TIMEOUT = 6.0  # seconds — keep aggressive; this is already a fallback path

# Youdao's undocumented dictionary JSON endpoint. Free, no API key, and
# domestic (fast + no GFW from the Hangzhou ECS). Gives Chinese senses,
# US/UK IPA, and a bilingual example — everything the quick popup shows —
# so it replaces the paid LLM as the *primary* for word lookups. It's an
# unofficial endpoint, so if it ever changes the route still falls through
# to the LLM and then Free Dictionary.
_YOUDAO_URL = "https://dict.youdao.com/jsonapi"
# A browser-ish UA; the endpoint 403s some default client UAs.
_YOUDAO_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_POS_RE = re.compile(r"^([a-zA-Z]+\.)\s*(.*)$", re.S)


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


async def youdao_lookup(word: str) -> dict | None:
    """Map Youdao's 英汉 (ec) payload onto our WordLookupOut shape.

    Returns Chinese senses + IPA + a bilingual example, or None on
    network error / missing `ec` block (rare/unknown token → caller
    falls back to the LLM). Youdao normalises inflected forms itself
    (``dictates`` → dictate senses), so no lemmatisation is needed here.
    """
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as c:
            r = await c.get(
                _YOUDAO_URL,
                params={"q": word},
                headers={"User-Agent": _YOUDAO_UA},
            )
    except Exception as e:
        log.info("youdao network error for %s: %s", word, e)
        return None
    if r.status_code != 200:
        return None
    try:
        data = r.json()
    except Exception:
        return None

    ec = (data or {}).get("ec") or {}
    words = ec.get("word") or []
    if not words:
        return None
    w0 = words[0] or {}

    ipa_us = (w0.get("usphone") or "").strip()
    ipa_uk = (w0.get("ukphone") or "").strip()

    senses: list[dict] = []
    zh_parts: list[str] = []
    for tr in w0.get("trs") or []:
        try:
            line = (tr["tr"][0]["l"]["i"] or [""])[0]
        except (KeyError, IndexError, TypeError):
            continue
        line = (line or "").strip()
        if not line:
            continue
        # Drop proper-noun / transliteration senses ("【名】（Gentle）（英）金特尔
        # （人名）") — noise for a learner clicking a common word.
        if line.startswith("【名】") or "（人名）" in line or "(人名)" in line:
            continue
        m = _POS_RE.match(line)
        pos, zh = (m.group(1), m.group(2).strip()) if m else ("", line)
        senses.append({"pos": pos, "zh": zh, "en": ""})
        zh_parts.append(line)
        if len(senses) >= 6:
            break

    if not senses:
        return None

    # Bilingual example from blng_sents_part, if present.
    example = ""
    pair = ((data.get("blng_sents_part") or {}).get("sentence-pair") or [])
    if pair:
        eng = _strip_tags((pair[0] or {}).get("sentence-eng") or "")
        zh = ((pair[0] or {}).get("sentence-translation") or "").strip()
        if eng:
            example = f"{eng} — {zh}" if zh else eng

    ipa = ipa_us or ipa_uk
    return {
        "word": _strip_tags(str((ec.get("word") or [{}])[0].get("return-phrase", {}).get("l", {}).get("i", word))) or word,
        "ipa_uk": ipa_uk,
        "ipa_us": ipa_us,
        "ipa": ipa,              # legacy mirror — US preferred
        "inflections": "",
        "senses": senses,
        # Youdao 英汉 has no English gloss; carry the Chinese as the
        # primary meaning (definition_en stays empty — the popup renders
        # definition_zh as the headline when en is blank).
        "definition_en": "",
        "definition_zh": " · ".join(zh_parts),
        "example": example,
    }


async def load_cached(db: AsyncSession, word: str) -> dict | None:
    """Return the cached payload (with `source` injected) or None."""
    row = await db.get(DictionaryCache, word)
    if row is None:
        return None
    data = dict(row.data or {})
    data["source"] = row.source or "llm"
    return data


async def save_cache(db: AsyncSession, word: str, data: dict, source: str) -> None:
    """Upsert the latest-good payload for `word`."""
    payload = {k: v for k, v in data.items() if k != "source"}
    row = await db.get(DictionaryCache, word)
    if row is None:
        row = DictionaryCache(word=word, data=payload, source=source)
        db.add(row)
    else:
        row.data = payload
        row.source = source
    await db.commit()


async def free_dict_lookup(word: str) -> dict | None:
    """Map Free Dictionary's response onto our WordLookupOut shape.

    English-only — definition_zh / senses[i].zh stay empty so the
    frontend can flag the row as "中文释义待补". Returns None on 404 /
    network error / unrecognised payload.
    """
    url = _FREE_DICT_URL.format(word=word.lower())
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as c:
            r = await c.get(url)
    except Exception as e:
        log.info("free dict network error for %s: %s", word, e)
        return None
    if r.status_code != 200:
        return None
    try:
        entries: list[Any] = r.json()
    except Exception:
        return None
    if not isinstance(entries, list) or not entries:
        return None

    first = entries[0]
    # IPA — Free Dictionary mixes UK/US in `phonetics[]` without labels.
    # Take the first non-empty text; treat it as ipa_us by default since
    # the platform's audience defaults to a US accent target.
    ipa_us = ""
    for p in first.get("phonetics") or []:
        t = (p or {}).get("text") or ""
        if t:
            ipa_us = t
            break

    senses: list[dict] = []
    first_example = ""
    for m in first.get("meanings") or []:
        pos = (m or {}).get("partOfSpeech") or ""
        for d in (m.get("definitions") or [])[:3]:
            en = (d or {}).get("definition") or ""
            if not en:
                continue
            senses.append({"pos": pos, "zh": "", "en": en})
            if not first_example:
                first_example = (d or {}).get("example") or ""
            if len(senses) >= 6:
                break
        if len(senses) >= 6:
            break

    if not senses:
        return None

    return {
        "word": first.get("word") or word,
        "ipa_uk": "",
        "ipa_us": ipa_us,
        "ipa": ipa_us,           # legacy mirror
        "inflections": "",
        "senses": senses,
        # Legacy back-compat fields the frontend may still read.
        "definition_en": senses[0]["en"],
        "definition_zh": "",
        "example": first_example,
    }
