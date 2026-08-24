"""Deterministic proper-noun normalization for ASR-transcribed English.

YouTube auto-captions / Whisper systematically mishear AI brand names
("ChatGPT" → "Chat GBT", "Anthropic" → "entropic", "Claude Code" →
"cloud code"). The learner-facing English (`Subtitle.text_en`, chunk
text, featured words) was never corrected — only the Chinese
translation prompt knew about these.

This module is the single source of truth for those fixes. It is
intentionally a conservative, phrase-anchored regex map rather than an
LLM pass: the English here is studied verbatim by learners, so we only
touch a finite, known set of AI-domain proper nouns and never paraphrase.
Extend `_FIXES` as new brand mishearings show up.
"""

import re

# (pattern, canonical replacement). Order matters: multi-word phrases
# before bare tokens. Word boundaries + phrase anchoring keep unrelated
# text safe. Replacement is the literal canonical spelling, so running
# this on already-correct text is a no-op (idempotent).
_FIXES: list[tuple[re.Pattern[str], str]] = [
    # ChatGPT — "Chat GBT", "Chat GPT", "ChatGBT", "chat g.b.t", "Chat G P T"
    (re.compile(r"\bchat\s*-?\s*g\.?\s*[bp]\.?\s*t\b", re.I), "ChatGPT"),
    # bare GPT mishearings (after the ChatGPT rule has consumed "Chat G_T")
    (re.compile(r"\bGBT\b"), "GPT"),
    (re.compile(r"\bGPD\b"), "GPT"),
    # OpenAI — only the capitalized name form ("Open AI"); lowercase
    # generic prose ("an open ai model") is deliberately left alone.
    (re.compile(r"\bOpen\s+AI\b"), "OpenAI"),
    # Anthropic
    (re.compile(r"\b[Ee]ntropic\b"), "Anthropic"),
    (re.compile(r"\banthropic\b"), "Anthropic"),
    # Claude Code / OpenClaude — mirror the translate-prompt rules
    (re.compile(r"\bcloud codes?\b", re.I), "Claude Code"),
    (re.compile(r"\bclaude code\b", re.I), "Claude Code"),
    (re.compile(r"\bopen claw(?:ed)?\b", re.I), "OpenClaude"),
]


def normalize_proper_nouns(text: str) -> str:
    """Return `text` with known AI proper-noun ASR errors corrected.

    Idempotent and safe to call on already-clean strings. Empty / non-str
    input is returned unchanged.
    """
    if not text or not isinstance(text, str):
        return text
    out = text
    for pat, repl in _FIXES:
        out = pat.sub(repl, out)
    return out


def normalize_list(items: list) -> list:
    """normalize_proper_nouns over a list of strings (non-strings pass
    through). Used for Chunk.similar_expressions / common_collocations."""
    if not items:
        return items
    return [
        normalize_proper_nouns(x) if isinstance(x, str) else x for x in items
    ]
