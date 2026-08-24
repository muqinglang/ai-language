"""
LLM wrapper · task-routed dispatch.

Each LLM-using task (reply / extract_chunks / select_segment / ...) has a
preferred provider chain. Pass `task=` to `_chat()`; the dispatcher walks
the chain for that task and falls through on failure. Tasks not in the
table use the default chain (DeepSeek → OpenAI).

Routing matrix lives in `_TASK_PROVIDERS` below.

Providers:
  - DeepSeek      cheap, Chinese-strong, decent JSON. Default for
                  translation / chunks / classify / summarize, and for the
                  whole-transcript tasks (select_segment / detect_ads) —
                  those downsample via _coalesce_subs, so even a 1.5h
                  podcast fits without a long-context provider.
  - OpenAI gpt-4o-mini   natural English; reserved for user-facing
                  chat tasks (reply / feedback / hint / teach-back) and
                  scenario design where English quality matters most.
  - Anthropic     legacy fallback; not in the new matrix but still hooked
                  in for emergency.

Stubs at the bottom keep the product runnable without any keys set.
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import re

from ..config import settings
from .llm_byok import LLMOverride, humanize_provider_error

log = logging.getLogger("llm")


class BYOKCallFailed(Exception):
    """A learner brought their own key and the call through it failed.

    Raised instead of quietly retrying on the server's providers.  The
    whole point of BYOK is that this learner's traffic is billed to this
    learner — a silent fallback would put exactly the requests they opted
    out of back onto the platform's quota, invisibly, forever.  Better to
    stop and say "your key failed, here's why".

    Carries a message already phrased for the learner; routers surface it
    verbatim and write it to user_llm_configs.last_error so the settings
    page can show what went wrong.
    """


# ---------- Provider detection ----------
def _deepseek_client():
    """DeepSeek speaks the OpenAI Chat Completions dialect."""
    if not settings.deepseek_api_key:
        return None
    try:
        from openai import OpenAI  # type: ignore
        return OpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
        )
    except Exception as e:
        log.warning("deepseek client unavailable: %s", e)
        return None


def _deepseek_only() -> bool:
    return settings.llm_provider == "deepseek_only"


def _anthropic_client():
    if _deepseek_only() or not settings.anthropic_api_key:
        return None
    try:
        import anthropic  # type: ignore
        return anthropic.Anthropic(api_key=settings.anthropic_api_key)
    except Exception as e:
        log.warning("anthropic not available: %s", e)
        return None


def _openai_client():
    if _deepseek_only() or not settings.openai_api_key:
        return None
    try:
        from openai import OpenAI  # type: ignore
        return OpenAI(api_key=settings.openai_api_key)
    except Exception as e:
        log.warning("openai not available: %s", e)
        return None


def _has_provider() -> bool:
    return bool(
        settings.deepseek_api_key
        or settings.anthropic_api_key
        or settings.openai_api_key
    )


# ---------- Task routing ----------
# Each task → ordered tuple of provider names to try. First non-failing
# call wins. Tasks not listed use _DEFAULT_CHAIN. _deepseek_only kill
# switch (prod env var LLM_PROVIDER=deepseek_only) overrides everything.
_TASK_PROVIDERS: dict[str, tuple[str, ...]] = {
    # --- User-facing English (gpt-4o-mini primary) ---
    "reply":              ("openai", "deepseek"),
    "feedback":           ("openai", "deepseek"),
    "hint":               ("openai", "deepseek"),
    "teachback_question": ("openai", "deepseek"),
    "teachback_review":   ("openai", "deepseek"),
    "lookup_word":        ("openai", "deepseek"),
    "scenario":           ("openai", "deepseek"),

    # --- Whole-transcript tasks ---
    # Both see the entire video's subtitles, downsampled by _coalesce_subs
    # (10s bins, then 20s) so a 1.5h podcast lands around 500 lines — well
    # inside DeepSeek's window. Kimi used to lead this pair as the
    # long-context option; the account's model 404'd on every call, so each
    # pick paid a wasted round trip before falling through to DeepSeek.
    "select_segment":     ("deepseek", "openai"),
    "detect_ads":         ("deepseek", "openai"),

    # --- Chinese-strong (DeepSeek primary) ---
    "translate":          ("deepseek", "openai"),
    "translate_subs":     ("deepseek", "openai"),
    "summarize":          ("deepseek", "openai"),
    "extract_chunks":     ("deepseek", "openai"),
    "explain_in_context": ("deepseek", "openai"),
    "pick_sentence_pattern": ("deepseek", "openai"),
    "eval_full_record":   ("openai", "deepseek"),
    "classify":           ("deepseek",),
    "estimate_difficulty": ("deepseek",),
    "detect_accent":      ("deepseek",),
    "featured_words":     ("deepseek",),
}
_DEFAULT_CHAIN: tuple[str, ...] = ("deepseek", "openai")


# DeepSeek v4 models are reasoning models: their thinking tokens are drawn
# from the SAME max_tokens budget as the answer. Measured on extract_chunks
# with a 2.4k-char transcript: ~1900 of the 4000-token budget went to
# reasoning, the JSON got cut mid-string (finish_reason=length) and salvage
# recovered 2 chunks out of 12. Doubling the ask + a floor fixes it — and
# costs nothing extra, since max_tokens is a ceiling, not a spend.
_DEEPSEEK_REASONING_HEADROOM = 1024


def _reasoning_budget(max_tokens: int) -> int:
    """Widen a max_tokens budget so a reasoning model's thinking doesn't
    starve the actual answer."""
    return max_tokens * 2 + _DEEPSEEK_REASONING_HEADROOM


# Why a module global: the platform-key call sites (pipeline, and the two
# public-content generators) all soft-fail to None so an import or a tab
# doesn't hard-crash on a flaky provider. That is right, but it also means
# the *reason* dies here — and "生成失败，请重试" sent to a learner whose
# retry can never work (revoked key, no balance) is worse than useless.
# Callers that surface an error to a human can append this.
_LAST_PROVIDER_ERROR = ""


def last_provider_error() -> str:
    """Why the most recent provider call failed, '' if none has."""
    return _LAST_PROVIDER_ERROR


def _note_provider_error(name: str, detail: str) -> None:
    global _LAST_PROVIDER_ERROR
    detail = (detail or "").strip()
    # Providers echo a masked key ("****346d"); other fields could carry
    # more, so keep it short and strip anything that looks like a key.
    detail = re.sub(r"sk-[A-Za-z0-9_\-]{6,}", "sk-***", detail)
    _LAST_PROVIDER_ERROR = f"{name}: {detail[:300]}" if detail else ""


def _provider_call(
    name: str, system: str, user: str, max_tokens: int, timeout: float,
    no_think: bool = False,
) -> str | None:
    """Single-shot call to one provider by name. Returns text or None.

    `no_think` turns DeepSeek's reasoning off for this one call.  It exists
    for the failure mode where thinking eats the entire budget and the
    answer comes back empty (see pipeline._translate_window): a bounded,
    mechanical task is better served by an answer with no thinking than by
    no answer at all.  Ignored by providers that don't reason.
    """
    extra: dict = {}
    if name == "deepseek":
        c = _deepseek_client()
        model = settings.deepseek_model
        if no_think:
            extra["extra_body"] = {"thinking": {"type": "disabled"}}
        else:
            max_tokens = _reasoning_budget(max_tokens)
    elif name == "openai":
        c = _openai_client()
        model = settings.openai_model
    elif name == "anthropic":
        c = _anthropic_client()
        if c is None:
            return None
        try:
            resp = c.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=max_tokens,
                timeout=timeout,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            return resp.content[0].text if resp.content else None
        except Exception as e:
            log.warning("anthropic call failed: %s", e)
            return None
    else:
        return None

    if c is None:
        return None
    try:
        resp = c.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            timeout=timeout,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            **extra,
        )
        out = resp.choices[0].message.content
        if not out:
            # A 200 with empty content is the reasoning-budget failure mode
            # (see _WHOLE_TRANSCRIPT_NO_THINK). Name it, or it reads as
            # "the provider is fine, our code just did nothing".
            _note_provider_error(name, "返回了空内容（可能是思考把 token 预算吃光）")
        return out
    except Exception as e:
        log.warning("%s call failed: %s", name, e)
        _note_provider_error(name, str(e))
        return None


def _override_client(override: LLMOverride):
    """Build a client from a learner's own credentials, or None."""
    try:
        if override.is_anthropic:
            import anthropic  # type: ignore
            return anthropic.Anthropic(api_key=override.api_key)
        from openai import OpenAI  # type: ignore
        return OpenAI(
            api_key=override.api_key,
            base_url=override.resolved_base_url() or None,
        )
    except Exception as e:
        log.warning("byok client unavailable (%s): %s", override.provider, e)
        return None


def _override_call(
    override: LLMOverride, system: str, user: str, max_tokens: int, timeout: float,
    no_think: bool = False,
) -> str:
    """One call through the learner's own key. Raises BYOKCallFailed.

    This used to return None and let the caller fall through to the
    server's providers — "the app still works" instead of "the AI tab is
    dead".  That trade is wrong here: the fallback is invisible, so a key
    that lapsed months ago would keep quietly billing the platform for a
    learner who believes they're paying their own way.  Failing loudly is
    the only version the learner can act on.
    """
    c = _override_client(override)
    if c is None:
        raise BYOKCallFailed(
            "服务端无法用你保存的配置建立连接，请到「我的 → 我的 API key」重新保存"
        )
    # Widen exactly as _provider_call does for DeepSeek. This path skipped
    # it for as long as BYOK has existed, which nobody noticed because a
    # starved reasoning model returned "" and the caller quietly re-ran the
    # request on the server's key. With that fallback gone, a learner on
    # deepseek-v4-pro hit "返回了空内容" on the very first scenario call
    # (max_tokens=400 → all 400 spent thinking). Applied to every provider,
    # not just DeepSeek: we can't know which of a learner's models reasons,
    # and max_tokens is a ceiling, not a spend, so over-asking costs nothing.
    max_tokens = _reasoning_budget(max_tokens)
    # Whole-transcript tasks ask for thinking to be switched off entirely
    # (see _WHOLE_TRANSCRIPT_NO_THINK). That instruction has to survive the
    # BYOK path too, or every one of them returns empty the moment the key
    # belongs to a learner instead of the platform — which is exactly what
    # happened to Rephrase the day imports moved onto the admin's own key.
    # Only DeepSeek understands this extra_body; sending it to OpenAI or a
    # random compatible gateway would 400 the request.
    extra: dict = {}
    if no_think and not override.is_anthropic and override.provider == "deepseek":
        extra["extra_body"] = {"thinking": {"type": "disabled"}}
    try:
        if override.is_anthropic:
            resp = c.messages.create(
                model=override.model,
                max_tokens=max_tokens,
                timeout=timeout,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            out = "".join(
                b.text for b in resp.content if getattr(b, "type", "") == "text"
            )
        else:
            resp = c.chat.completions.create(
                model=override.model,
                max_tokens=max_tokens,
                timeout=timeout,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                **extra,
            )
            out = resp.choices[0].message.content or ""
    except BYOKCallFailed:
        raise
    except Exception as e:
        msg = humanize_provider_error(
            override.provider, override.model, e, override.api_key
        )
        log.warning("byok call failed (%s/%s): %s", override.provider, override.model, e)
        raise BYOKCallFailed(f"你的 API key 调用失败：{msg}") from e

    # HTTP 200 with an empty body is a failure too — a reasoning model can
    # spend the entire token budget thinking (this is exactly how
    # deepseek-v4-flash behaves).  Reported as itself rather than as a
    # generic outage, because the fix is "pick another model".
    if not out.strip():
        raise BYOKCallFailed(
            f"模型「{override.model}」返回了空内容（推理型模型常把 token 全花在思考上）。"
            "到「我的 → 我的 API key」换一个模型试试"
        )
    return out


# The credentials in force for the current task, when nobody is passing an
# `override=` down the call chain.
#
# The import pipeline is why this exists. It fans out into ~16 different
# llm.* functions across several modules, and an import is admin work run
# on the admin's own key — threading an `override` parameter through every
# one of them would be a lot of plumbing for a value that never changes
# inside a run. `run_pipeline` sets this once for the whole run instead.
#
# A ContextVar, not a global: concurrent imports (and concurrent requests
# on the same process) must not see each other's key. asyncio.create_task
# and asyncio.to_thread both copy the current context, which is exactly
# how the pipeline's threaded LLM calls inherit it.
_ambient_override: contextvars.ContextVar[LLMOverride | None] = contextvars.ContextVar(
    "justspeak_llm_override", default=None,
)


@contextlib.contextmanager
def use_override(override: LLMOverride | None):
    """Run a block with `override` as the ambient credentials."""
    token = _ambient_override.set(override)
    try:
        yield
    finally:
        _ambient_override.reset(token)


def current_override() -> LLMOverride | None:
    return _ambient_override.get()


def has_credentials(override: LLMOverride | None = None) -> bool:
    """Is there any usable way to call a model right now?

    Checks the explicit override, then the ambient one, then the server's
    own env keys. Call sites use it to decide between "do the LLM step"
    and "skip it gracefully" — they must not check `_has_provider()`
    directly any more, or they'll skip work a learner's key could do.
    """
    return bool(override or _ambient_override.get() or _has_provider())


def _chat(
    system: str,
    user: str,
    max_tokens: int = 800,
    timeout: float = 120,
    admin_tier: bool = True,
    task: str | None = None,
    override: LLMOverride | None = None,
    no_think: bool = False,
) -> str | None:
    """Task-routed chat. Looks up the provider chain for `task` in
    `_TASK_PROVIDERS` and walks it. Returns the first non-empty content
    or None when every provider failed.

    - `_deepseek_only()` (env LLM_PROVIDER=deepseek_only) overrides routing
      and forces every task to DeepSeek. Kept for prod kill-switch parity.
    - `admin_tier=False` (legacy gate) also restricts to DeepSeek; pipeline
      + admin work always run with admin_tier=True so this rarely matters.
    - `timeout` is per provider attempt, not per total wall clock.
    - `override` (a learner's own key) REPLACES the server chain, it does
      not precede it: when a learner has configured a key, every call this
      request makes is billed to them, and a failure raises BYOKCallFailed
      rather than quietly falling back onto the platform's quota.  When no
      override is passed, the ambient one (`use_override`, set by the
      import pipeline) applies — so every call in this process is billed
      to whoever triggered it, and the env keys are only a last resort for
      deployments that still configure them.
    """
    if override is None:
        override = _ambient_override.get()
    if override is not None:
        out = _override_call(override, system, user, max_tokens, timeout, no_think)
        log.info("[chat] task=%s provider=byok:%s ok", task or "_default", override.provider)
        return out

    chain = _TASK_PROVIDERS.get(task or "", _DEFAULT_CHAIN)
    if _deepseek_only() or not admin_tier:
        chain = ("deepseek",)

    for name in chain:
        out = _provider_call(name, system, user, max_tokens, timeout, no_think=no_think)
        if out:
            log.info("[chat] task=%s provider=%s ok", task or "_default", name)
            return out
    log.warning("[chat] task=%s all providers failed (chain=%s)", task or "_default", chain)
    return None


# ---------- 1. Scenario design ----------
_SCENARIO_SYS = """You are a language-learning scenario designer for a Chinese English learner.
Given an episode (title + summary) and a list of target chunks (English expressions the learner should practice),
design a natural conversation scenario where using those chunks feels inevitable.

Respond in JSON with this exact shape:
{"scenario": "<Chinese description of the scenario>",
 "opening": "<English opening question to start the chat>"}
The scenario tells the learner what situation they're role-playing.
The opening is one English sentence that kicks off the conversation."""


def design_scenario(
    title: str, summary: str, target_chunks: list[str],
    override: LLMOverride | None = None,
) -> tuple[str, str]:
    """Return (scenario_description, opening_message)."""
    if has_credentials(override):
        raw = _chat(
            _SCENARIO_SYS,
            f"Episode title: {title}\nSummary: {summary}\nTarget chunks: {target_chunks[:8]}",
            max_tokens=400,
            task="scenario",
            override=override,
        )
        if raw:
            try:
                data = _json_loads(_strip_json(raw))
                return data["scenario"], data["opening"]
            except Exception as e:
                log.warning("scenario parse failed: %s\nraw=%s", e, raw)

    # Stub fallback
    scenario = (
        f"你刚刚看完这期「{title}」，现在要把内容讲给一个还没看过的朋友听。"
        f"在对话里尽量自然地用到这些表达：{', '.join(target_chunks[:5])}."
    )
    opening = "Hey! So you just finished watching this one — what's the thing that stuck with you the most?"
    return scenario, opening


# ---------- 1.5 Topic + Category classification ----------
_CLASSIFY_SYS = """You classify a YouTube video for a Chinese English-learning app.

You receive: title + description summary.

Return ONLY JSON (no markdown, no commentary):
{"category": "<one slug>", "topic": "<one slug>", "subtopic": "<short tag or empty>"}

CATEGORY (the video's FORMAT) — pick exactly one:
- talk         (TED-style polished keynote / lecture)
- interview    (two or more people in conversation, podcast, talk show)
- vlog         (first-person daily life recording)
- tutorial     (step-by-step how-to: "Step 1, Step 2…")
- creator      (single-person YouTube essay / explainer / opinion video — Jeff Su, Mark Tilbury, Ali Abdaal style)
- news         (news anchor, reporter, current events broadcast)
- documentary  (professional production with narration + B-roll, mini-doc)
- review       (product / movie / book review — comparative + evaluative)
- comedy       (stand-up, sketch, satire — performative humor)
- other        (last resort if truly nothing else fits)

TOPIC (the video's SUBJECT) — pick exactly one:
- ai           (LLMs, AGI, AI tools, AI agents, prompt engineering)
- tech         (programming, software, hardware, internet, gadgets)
- business     (startups, entrepreneurship, business strategy)
- investing    (stocks, funds, personal finance, crypto, macro)
- career       (career growth, productivity, remote work, job hunting)
- lifestyle    (daily life, home, social, consumption habits)
- travel       (travel, cross-cultural, relocating)
- food         (recipes, restaurants, food culture)
- health       (fitness, nutrition, sleep, wellness)
- psychology   (self-improvement, emotions, relationships, habits, life lessons)
- science      (physics/chemistry/biology/astronomy/general science)
- education    (study methods, language learning, skill acquisition)
- entertainment(movies, music, games, pop culture, celebrities)
- fashion      (clothing, beauty, style)
- sports       (athletics, sports commentary, games, F1, Olympics)
- outdoor      (hiking, camping, wilderness, van life)
- reading      (book reviews, literary discussion, BookTube)
- other        (last resort)

SUBTOPIC (free-text sub-tag inside the topic, kebab-case ≤24 chars):
- Examples: "cooking" / "shopping" / "morning-routine" / "interview-prep"
  / "negotiation" / "gpt-prompts" / "ai-agents" / "marathon" / "skincare"
- Pick the MOST SPECIFIC honest tag the video centres on. Be concrete.
- Return EMPTY STRING "" when the video genuinely spans multiple
  sub-areas of the topic with no clear focus. Don't invent generic
  tags ("general", "misc", "tips") — empty is better than vague.

Decision tips:
- Single person speaking to camera + opinion/knowledge → creator
- Single person + step-by-step procedure → tutorial
- Two or more people talking → interview
- Pick MOST DOMINANT topic; "other" only if truly multi-topic with no clear focus."""


def classify_episode(title: str, summary: str) -> tuple[str, str, str]:
    """Return (category_slug, topic_slug, subtopic_tag).  Defaults to
    ('other','other','') if the LLM is unavailable or returns garbage.
    Subtopic is free-text kebab (e.g. "cooking", "interview-prep"); empty
    when the LLM can't pin a single focus."""
    if not has_credentials():
        return ("other", "other", "")
    user = f"Title: {title}\n\nSummary: {summary[:1500]}"
    raw = _chat_conversation(_CLASSIFY_SYS, user, max_tokens=120, timeout=30, task="classify")
    if not raw:
        return ("other", "other", "")
    try:
        from .topics import CATEGORY_SLUGS, TOPIC_SLUGS
        data = _json_loads(_strip_json(raw))
        cat = str(data.get("category", "other")).strip().lower()
        top = str(data.get("topic", "other")).strip().lower()
        sub = str(data.get("subtopic", "")).strip().lower()
        if cat not in CATEGORY_SLUGS:
            cat = "other"
        if top not in TOPIC_SLUGS:
            top = "other"
        # Normalise subtopic to safe kebab; reject obvious noise.
        sub = re.sub(r"[^a-z0-9\-]+", "-", sub).strip("-")[:48]
        if sub in {"general", "misc", "other", "various", "n/a", "none"}:
            sub = ""
        return (cat, top, sub)
    except Exception as e:
        log.warning("classify_episode parse failed: %s\nraw=%s", e, raw)
        return ("other", "other", "")


# ---------- Difficulty estimator (Req 1) ----------
_DIFFICULTY_SYS = """You estimate how hard an English transcript is for a Chinese learner.
Score 1-5 by CEFR-anchored heuristic:
1 = A1 (basic everyday words, simple present/past, < 6-word sentences average)
2 = A2 (shopping/travel vocab, common collocations)
3 = B1 (intermediate; idioms appear, varied tenses, 10-12 words avg)
4 = B2 (academic/professional vocabulary, complex clauses)
5 = C1+ (advanced, dense reasoning, idioms+slang+proper nouns)

Look at: vocabulary density, sentence complexity, idiom use, technical jargon, speech rate cues.
Return JSON only: {"difficulty": <int 1-5>}"""


def estimate_difficulty(transcript_en: str) -> int:
    """1-5 CEFR-anchored difficulty. Defaults to 3 if LLM unavailable / parse fails."""
    if not has_credentials() or not transcript_en.strip():
        return 3
    user = f"Transcript:\n{transcript_en[:3000]}"
    raw = _chat_conversation(_DIFFICULTY_SYS, user, max_tokens=40, timeout=30, task="estimate_difficulty")
    if not raw:
        return 3
    try:
        data = _json_loads(_strip_json(raw))
        n = int(data.get("difficulty", 3))
        return max(1, min(5, n))
    except Exception as e:
        log.warning("estimate_difficulty parse failed: %s\nraw=%s", e, raw)
        return 3


# ---------- Accent detector (Req 1) ----------
_ACCENT_SYS = """You identify the speaker's English accent from a transcript.
Allowed values (slugs):
- US: General American
- UK: British (RP / London / Northern English)
- AU: Australian
- CA: Canadian
- IN: Indian English
- ZA: South African
- other: clearly none of the above, mixed, or insufficient evidence

Look for: spelling cues if any, regional vocabulary (mate / quid / lift / lorry / no worries / eh / cheers / fortnight), idioms, named places, channel-name hints. If purely transcribed text without strong markers, default to US.
Return JSON only: {"accent": "<slug>"}"""


def detect_accent(transcript_en: str, channel_name: str = "") -> str:
    """Returns a slug from {US,UK,AU,CA,IN,ZA,other}. Defaults to 'US'."""
    valid = {"US", "UK", "AU", "CA", "IN", "ZA", "other"}
    if not has_credentials() or not transcript_en.strip():
        return "US"
    user = f"Channel: {channel_name}\n\nTranscript:\n{transcript_en[:2500]}"
    raw = _chat_conversation(_ACCENT_SYS, user, max_tokens=30, timeout=30, task="detect_accent")
    if not raw:
        return "US"
    try:
        data = _json_loads(_strip_json(raw))
        a = str(data.get("accent", "US")).strip().upper()
        # LLM might return "other" lowercase or full names
        if a == "OTHER":
            return "US"
        return a if a in valid else "US"
    except Exception as e:
        log.warning("detect_accent parse failed: %s\nraw=%s", e, raw)
        return "US"


# ---------- 2. Conversation reply ----------
_REPLY_SYS = """You are a friendly English conversation partner for a Chinese learner.
Your ONLY rules:
1. Stay in the given scenario.
2. Keep replies short (2–4 sentences) and conversational.
3. If the learner hasn't yet used the target chunks listed as "unused", ask a follow-up question that
   naturally invites them to use one of those chunks — without explicitly telling them to use it.
4. Don't correct grammar unless it blocks meaning.
5. When the learner uses a target chunk well, briefly echo it back in affirmation.

Respond with ONLY the next assistant message (plain English, no JSON)."""


def _reply_prompt(scenario: str, history: list[dict], target_chunks: list[str], unused: list[str]) -> str:
    # Use neutral role labels (A: / B:) and ask for "the reply" instead of
    # "the ASSISTANT message" — models sometimes echo the role prefix into
    # the output when the prompt uses capitalised role names.
    role_label = {"user": "B", "assistant": "A"}
    convo = "\n".join(
        f"{role_label.get(m['role'], m['role'])}: {m['content']}" for m in history[-10:]
    )
    return (
        f"Scenario: {scenario}\n\n"
        f"Target chunks: {target_chunks}\n"
        f"Still unused chunks (push gently toward these): {unused}\n\n"
        f"Conversation so far (A = you, B = the learner):\n{convo}\n\n"
        f"Write A's next reply only — no role label, no quotation marks, just the English sentence."
    )


# Strip any role prefix the model leaked into its output despite instructions.
# Matches e.g. 'ASSISTANT: Hi there' / 'AI:  hello' / 'A: sure.' case-insensitive.
_ROLE_PREFIX_RE = re.compile(r"^\s*(assistant|ai|a|bot)\s*[:：]\s*", re.IGNORECASE)


def _strip_role_prefix(text: str) -> str:
    return _ROLE_PREFIX_RE.sub("", text or "", count=1)


def _chat_conversation(
    system: str,
    user: str,
    max_tokens: int = 300,
    timeout: float = 60,
    admin_tier: bool = True,
    task: str | None = None,
    override: LLMOverride | None = None,
    no_think: bool = False,
) -> str | None:
    """Back-compat alias kept so existing call sites compile during the
    routing migration. Delegates to `_chat(task=...)` — caller should
    pass an explicit `task=` to land on the right provider.

    Without a task, defaults to 'reply' (the original conversation use).
    """
    return _chat(
        system, user,
        max_tokens=max_tokens,
        timeout=timeout,
        admin_tier=admin_tier,
        task=task or "reply",
        override=override,
        no_think=no_think,
    )


def reply(
    scenario: str,
    history: list[dict],
    target_chunks: list[str],
    unused: list[str],
    admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> str:
    if has_credentials(override):
        raw = _chat_conversation(
            _REPLY_SYS,
            _reply_prompt(scenario, history, target_chunks, unused),
            max_tokens=300,
            admin_tier=admin_tier,
            task="reply",
            override=override,
        )
        if raw:
            return _strip_role_prefix(raw.strip())

    # Stub
    if unused:
        hint = unused[0]
        return (
            f"Love that. Here's a follow-up — can you tell me about a moment where you'd naturally say "
            f"\"{hint}\"? Try weaving it into your answer."
        )
    return "Nice — how would you say this differently if you were talking to a close friend vs. a coworker?"


def reply_stream(
    scenario: str,
    history: list[dict],
    target_chunks: list[str],
    unused: list[str],
    admin_tier: bool = True,
    override: LLMOverride | None = None,
):
    """Yield the AI reply token-by-token.

    Provider order mirrors _chat_conversation: OpenAI gpt-4o-mini first
    (more natural dialogue), then DeepSeek, then finally the non-streaming
    fallback yielded as one chunk.  Both OpenAI & DeepSeek speak the same
    OpenAI-compatible streaming protocol, so the inner loop is identical.

    The outer generator strips any leaked role prefix ("ASSISTANT: ", etc)
    from the first tokens — some models echo the role label despite the
    prompt.  We buffer the first ~20 chars, strip once, then pass the
    remaining stream through untouched."""
    user_prompt = _reply_prompt(scenario, history, target_chunks, unused)

    def _stream_content(client, model: str, max_tokens: int = 300):
        """Raw content tokens only — no sentinels.  Caller detects provider
        exhaustion by whether anything was yielded."""
        stream = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            timeout=120,
            stream=True,
            messages=[
                {"role": "system", "content": _REPLY_SYS},
                {"role": "user", "content": user_prompt},
            ],
        )
        for event in stream:
            try:
                delta = event.choices[0].delta
                piece = getattr(delta, "content", None)
            except Exception:
                piece = None
            if piece:
                yield piece

    def _inner():
        # 0. The learner's own key, when they configured one — and then
        #    nothing else.  Steps 1-3 below are the server's keys, and a
        #    learner who brought their own must never silently land on
        #    them (see BYOKCallFailed).  Only the OpenAI-compatible
        #    providers stream; an Anthropic override goes through reply(),
        #    which routes the same override through _chat.
        if override is not None:
            if not override.is_anthropic:
                oc = _override_client(override)
                if oc is not None:
                    got = False
                    try:
                        # Widened for the same reason step 2 widens for
                        # DeepSeek: on a reasoning model a flat 300 goes
                        # entirely to thinking, the stream yields nothing,
                        # and the learner gets the whole reply as one late
                        # blob from the fallback below instead of tokens.
                        for piece in _stream_content(
                            oc, override.model, _reasoning_budget(300)
                        ):
                            got = True
                            yield piece
                    except Exception as e:
                        log.warning("byok stream failed (%s): %s", override.provider, e)
                        # Mid-stream failures can't be turned into a clean
                        # error — the learner already has half a sentence on
                        # screen — so only a failure before the first token
                        # is worth raising over.
                        if not got:
                            raise BYOKCallFailed(
                                "你的 API key 调用失败："
                                + humanize_provider_error(
                                    override.provider, override.model, e,
                                    override.api_key,
                                )
                            ) from e
                    if got:
                        return
            # Non-streaming path (Anthropic, or a stream that produced
            # nothing). reply() raises BYOKCallFailed on its own.
            full = reply(
                scenario, history, target_chunks, unused,
                admin_tier=admin_tier, override=override,
            )
            if full:
                yield full
            return

        # 1. OpenAI (primary for reply per the routing matrix; admin_tier
        #    keeps the legacy gate working for non-admin runs that want
        #    to skip premium providers).
        if admin_tier:
            o = _openai_client()
            if o is not None:
                try:
                    got = False
                    for piece in _stream_content(o, settings.openai_model):
                        got = True
                        yield piece
                    if got:
                        return
                except Exception as e:
                    log.warning("openai stream failed: %s", e)

        # 2. DeepSeek (primary for paying users, fallback for admin)
        d = _deepseek_client()
        if d is not None:
            try:
                got = False
                # Same reasoning-budget widening as _provider_call: with a
                # flat 300 the thinking phase can consume the whole cap and
                # the stream yields zero content tokens.
                for piece in _stream_content(
                    d, settings.deepseek_model, _reasoning_budget(300)
                ):
                    got = True
                    yield piece
                if got:
                    return
            except Exception as e:
                log.warning("deepseek stream failed: %s", e)

        # 3. Final fallback: one-shot reply as a single chunk. No override
        #    here — the override path returned above.
        full = reply(scenario, history, target_chunks, unused, admin_tier=admin_tier)
        if full:
            yield full

    # Outer: buffer the first ~20 chars to detect + strip a leaked role
    # prefix, then stream the rest through untouched.
    buf = ""
    stripped = False
    for piece in _inner():
        if stripped:
            yield piece
            continue
        buf += piece
        if len(buf) >= 20 or "\n" in buf:
            yield _strip_role_prefix(buf)
            buf = ""
            stripped = True
    if buf and not stripped:
        yield _strip_role_prefix(buf)


# ---------- 2.5 Teach-back (Feynman) ----------
_TEACHBACK_QUESTION_SYS = """You write a single short prompt that asks a
Chinese English learner to "teach back" what they just learned, in their
own simple English, as if explaining to a friend who hasn't seen the
video.

Input: episode title + a brief summary + the target chunks they just
practiced.

Output: ONE short English question that invites a 3-4 sentence
explanation, naming the topic explicitly.  No preamble, just the
question.  Examples:
  - "Now imagine your friend hasn't seen this — in your own words, what is a Harness Engineer and why is it a big deal?"
  - "Pretend you're explaining this to a non-investor friend: how is AI changing the way Mark thinks about S&P 500 investing?"
"""


def teachback_question(
    title: str, summary: str, target_chunks: list[str], admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> str:
    if not has_credentials(override):
        return f"In your own words, what was this video about? Try to use {target_chunks[0] if target_chunks else 'one new phrase'} naturally."
    user = f"Title: {title}\n\nSummary: {summary[:1000]}\n\nTarget chunks: {target_chunks}"
    raw = _chat_conversation(
        _TEACHBACK_QUESTION_SYS, user, max_tokens=120, timeout=30,
        admin_tier=admin_tier, task="teachback_question", override=override,
    )
    return (raw or "Now in your own words — what was this video about?").strip()


_TEACHBACK_REVIEW_SYS = """You evaluate a Chinese learner's "teach-back"
explanation of a video.  Goal: assess CLARITY, COMPLETENESS, and natural
English.

Input: the teach-back question, the key ideas the learner SHOULD cover
(extracted from the episode summary), and the learner's spoken/typed
answer.

Return ONLY JSON:
{
  "verdict": "<one short Chinese sentence: '讲清楚了 / 还差XX'>",
  "strengths": ["<short Chinese, one strength>", ...],
  "missed_points": ["<English, one key idea they didn't cover>", ...],
  "suggestion": "<one short Chinese sentence: how to make the explanation tighter>"
}"""


def teachback_review(
    question: str, key_ideas: str, learner_answer: str, admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> dict | None:
    if not learner_answer.strip() or not has_credentials(override):
        return None
    user = (
        f"Question:\n{question}\n\n"
        f"Key ideas (from the episode):\n{key_ideas}\n\n"
        f"Learner's answer:\n{learner_answer}"
    )
    raw = _chat_conversation(
        _TEACHBACK_REVIEW_SYS, user, max_tokens=400, timeout=45,
        admin_tier=admin_tier, task="teachback_review", override=override,
    )
    if not raw:
        return None
    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("teachback parse failed: %s\nraw=%s", e, raw)
        return None
    return {
        "verdict": str(data.get("verdict", "")).strip(),
        "strengths": list(data.get("strengths", []) or []),
        "missed_points": list(data.get("missed_points", []) or []),
        "suggestion": str(data.get("suggestion", "")).strip(),
    }


# ---------- 2.3 Per-turn learning feedback ----------
_FEEDBACK_SYS = """You are an English coach reviewing a Chinese learner's
short reply in a role-play conversation.

You receive:
- the scenario the learner is in
- the AI's previous question
- the learner's reply
- which target chunks the learner was supposed to use

Return ONLY JSON (no markdown):
{
  "praise": "<one short positive sentence about what worked, in Chinese; empty string if nothing notable>",
  "errors": [
    {"original": "<problematic phrase>", "suggestion": "<corrected phrase>", "why": "<short Chinese reason, e.g. 时态/语序/Chinglish>"}
  ],
  "alternatives": ["<one or two more natural alternative phrasings, in English>"],
  "score": <integer 0-5: 0=unintelligible, 5=native-like>
}

Rules:
- Be encouraging, not pedantic — only flag errors that block meaning OR are
  classic Chinese-English transfer mistakes (verb tense, article, word order).
- "errors" can be empty if the reply is fine.
- "alternatives" should sound MORE natural / native, NOT just paraphrase.
- All Chinese explanations stay short (≤ 25 字)."""


def feedback_on_reply(
    scenario: str,
    ai_question: str,
    learner_reply: str,
    target_chunks: list[str],
    admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> dict | None:
    """Return {praise, errors[], alternatives[], score} or None on failure."""
    if not learner_reply.strip() or not has_credentials(override):
        return None
    user = (
        f"Scenario: {scenario}\n"
        f"Target chunks (what the learner is practicing): {target_chunks}\n\n"
        f"AI's question:\n{ai_question}\n\n"
        f"Learner's reply:\n{learner_reply}"
    )
    raw = _chat_conversation(
        _FEEDBACK_SYS, user, max_tokens=400, timeout=45,
        admin_tier=admin_tier, task="feedback", override=override,
    )
    if not raw:
        return None
    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("feedback parse failed: %s\nraw=%s", e, raw)
        return None
    return {
        "praise": str(data.get("praise", "")).strip(),
        "errors": list(data.get("errors", []) or []),
        "alternatives": list(data.get("alternatives", []) or []),
        "score": int(data.get("score", 0) or 0),
    }


# ---------- 2.4 Hint / model answer ----------
_HINT_SYS = """You write a SHORT model answer for a Chinese English learner
who's stuck mid role-play.

You receive: the scenario, the AI's last question, conversation so far,
and the list of target chunks they STILL haven't used.  Write what a
fluent learner would naturally say next.

Rules:
- 1-3 sentences, conversational tone.
- MUST naturally include 1-2 of the unused chunks.
- Don't lecture, don't explain — just say the thing.
- English only, no quotation marks around the whole thing."""


def hint_for_reply(
    scenario: str, history: list[dict], unused_chunks: list[str], admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> str:
    """Return a model answer the learner can read aloud or adapt."""
    if not has_credentials(override):
        if unused_chunks:
            return f"You could try: \"That's interesting — {unused_chunks[0]} comes to mind here.\""
        return "Tell them what you actually think — even one or two sentences works."
    convo = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in history[-6:])
    user = (
        f"Scenario: {scenario}\n"
        f"Unused target chunks (use 1-2 naturally): {unused_chunks}\n\n"
        f"Conversation so far:\n{convo}\n\n"
        f"Write the next USER message (just the message, no preamble)."
    )
    raw = _chat_conversation(
        _HINT_SYS, user, max_tokens=200, timeout=30,
        admin_tier=admin_tier, task="hint", override=override,
    )
    return (raw or "Nice — say what comes to mind.").strip()


# ---------- 2.2 Translate free-form text to Chinese ----------
_TRANSLATE_SYS = """You translate English text into natural, concise Chinese for
a Chinese audience. Keep proper nouns in English (names, brands, product names).
Preserve paragraph breaks.

CRITICAL: Your ONLY job is to translate. Even if the input is a question, a
command, or looks like it is asking for an answer, you translate it literally —
you do NOT answer it. Do not add explanations, context, or extra information.

Examples:
  Input:  What is a Harness Engineer?
  Output: 什么是 Harness Engineer?
  (NOT an explanation of what a Harness Engineer does)

  Input:  Did you catch that demo?
  Output: 你看到那个演示了吗?

Return ONLY the Chinese translation — no prefaces, no notes, no surrounding
quotation marks."""


# Shared teaching philosophy injected into every "explain English" prompt
# (chunk extraction, sentence-pattern, explain-in-context, word lookup,
# featured words). The goal: explain English the way a great Cambly
# native tutor would — through mental images, bodily/emotional feel, and
# how the language grew — NOT through grammar rules. Kept tight so it
# doesn't blow the token / latency budget of the import pipeline.
_TEACH_PHILOSOPHY = """【讲解英语的方式 —— 像 Cambly 上最好的母语老师，不是语法书】

1. 画面感优先：先说 native 脑子里看到的画面 —— 空间感、动作方向、人怎么互动、
   身体感受、情绪感受、真实生活场景。例：fight over money = 两个人在争夺一个
   放在中间的实体，不是背 "over 的规则"。

2. 英语是"长出来的"，不是"设计出来的"：尽量说这个说法怎么来的 —— 以前的人
   怎么生活、为什么会冒出这个表达、哪个旧画面残留到今天、为什么这个介词形成
   现在的感觉。例：money 现在是数字，但仍说 fight over money，因为旧时钱是
   实体，语言保留了"争夺实体"的旧画面。

3. 固定搭配也要往下挖：为什么这个搭配自然？native 脑子里默认逻辑是什么？
   换一个介词画面会怎么变？不要只甩"这是固定搭配"。

4. 用"感觉"不用术语：少用 名词性从句 / 动名词 / 过去分词 / 状语 这类语法词。
   多讲 native 的直觉、句子的能量流动、注意力放在哪、说话人的心理感觉。

5. 用脑内动画示意动态：需要时用箭头，如  A ← object → B 、 过去 → 未来 、
   ↺ 重复发生 ，让动态"看得见"。

6. 现代新词也讲来源：FOMO / ghosting / doomscrolling / cringe / delulu 这类
   网络/社媒新词，讲为什么出现、反映现代人什么心理、被时代怎么推出来。

7. 终极目标：让学习者"感觉到"人类是怎么感受世界、再把这种感觉变成语言的。
   多画面、多感觉、多人类行为、多语言演化，少死规则。每条解释要简洁有画面，
   别写成长篇大论。"""


_WORD_LOOKUP_SYS = _TEACH_PHILOSOPHY + """

You help Chinese learners of English look up a word in context. Follow the
teaching philosophy above: the Chinese gloss should evoke the word's core
mental image / feel, not just a dictionary equivalent.

You receive:
- a single English word (possibly with trailing punctuation, strip it)
- the sentence it appeared in (for disambiguation when the word has many senses)

Respond with ONLY JSON (no markdown):
{
  "word": "<base form, lowercase, no punctuation>",
  "ipa_uk": "<British RP IPA in / /, e.g. /riːd/>",
  "ipa_us": "<US General American IPA in / /, e.g. /riːd/>",
  "inflections": "<词形变化，· 分隔，如 'reads · reading · read'；没有变化或功能词留空字符串>",
  "senses": [
    {
      "pos": "<v. | n. | adj. | adv. | prep. | ... 用通用缩写>",
      "zh": "<这个词性下的中文释义，≤20 字，带出画面/感觉>",
      "en": "<one short CEFR-B1 sentence for this sense>"
    }
  ],
  "definition_en": "<senses[0].en，单独再给一份方便老客户端>",
  "definition_zh": "<senses[0].zh，单独再给一份方便老客户端>",
  "example": "<one natural, vivid real-life example sentence using the word, DIFFERENT from the given one>"
}

Rules:
- `ipa_us` MUST be US General American (rhotic /r/, /ɝ/ not /ɜː/, etc.) wrapped in / /. `ipa_uk` is British RP (non-rhotic, /ɜː/, /ɑː/). If they're identical that's fine — still fill both.
- `senses`: list the word's real distinct senses/parts of speech the way a dictionary does (Eudic-style). Put the sense that best matches the given sentence FIRST. 2–4 senses is typical; a single-sense word gets one entry. Don't pad.
- `inflections`: verb → 三单·现在分词·过去式/过去分词; noun → 复数; adj → 比较级·最高级. Irregular forms spelled out. Function words / words with no inflection → "".
- Keep `en` simple — reuse common words (avoid using rarer words to define a rare one).
- If it's a modern internet/slang word, the gloss may hint why it exists / what feeling it carries."""


_EXPLAIN_IN_CONTEXT_SYS = _TEACH_PHILOSOPHY + """

你是一个帮中国英语学习者深度理解视频字幕的英语教练。学习者会指着视频里
某个单词、词组或整句话问"这是什么意思"。请按上面的方式 —— 用画面、感觉、
语言演化，而不是语法规则 —— 给一个能让人"感觉到"并记住的解释。

你会收到：
- 学习者问的内容（可能是单词、词组，也可能是整句话）
- 视频标题 + 一句话简介 + 话题（旅行 / 健身 / AI 等）
- 这句台词所在的字幕行（query_sub）
- query_sub 前后各 2 句的字幕（context_subs，给你判断说话人当下在干嘛）

输出（严格按这个结构，用中文 Markdown；第一行的 ## 标题必须保留原样）：

## 「{学习者问的原文}」在这段视频里是什么意思

一句话点破：native 脑子里其实看到的是 ___ ；在这个语境下就是 ___ 的意思。

## 脑子里的画面

native 说/听到这个时，脑子里的画面是什么 —— 空间、动作方向、谁对谁做了
什么、身体或情绪的感受。需要时用箭头把动态画出来，例如
 A ← over → B 、 过去 → 现在 、 ↺ 反复 。别用语法术语。

## 这个说法怎么来的

它为什么会长成今天这样：背后的旧生活画面 / 为什么这个介词或词带这种感觉 /
哪个古老画面残留下来。如果是现代网络新词（FOMO、ghosting 这类），讲它为什么
出现、反映现代人什么心理。如果就是个普通词没什么来历，这段可以很短或并入上一段。

## 在 {video topic} 这种场景里

说话人此刻在干嘛、想表达什么感觉。中英混写，越口语越好。

## 例句（学了就能用）

```
英文例句 1
= 中文翻译 1
英文例句 2
= 中文翻译 2
英文例句 3（带变体）
= 中文翻译 3
```
（3-5 句，覆盖不同场景；用 native 真会说的句式，避免教科书味）

## 一个母语者的感觉

1-2 句点出语感 —— 带什么情绪、什么场景说；和一个意思相近但更书面的说法相比，
味道差在哪。

---

规则：
- 全程中文，保留所有英文原文（单词、例句、引语）。
- 像英语很好的中国朋友给你讲，带语气词；别教科书化、别堆语法术语。
- 如果是固定搭配，别只说"这是固定搭配"，要往下挖：为什么自然、换个词画面会怎么变。
- 如果学习者问的是一整句话，重点讲整句的画面 + 注意力流动 + 哪个词最关键 + 怎么自然翻。
- 如果是单个常用词（如 "a"、"the"），直接说"这个词在这里没什么特别含义"，不硬凑。
- 例句用 contractions（I'm/don't/let's）、真实场景。
- 别说"希望对你有帮助"之类废话，直接讲。"""


def explain_in_context(
    query: str,
    episode_title: str,
    episode_summary: str,
    episode_topic: str,
    query_sub_text: str,
    context_subs: list[str],
    admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> str | None:
    """Return a Markdown explanation of `query` grounded in the surrounding
    subtitles + episode metadata. None on LLM failure."""
    query = (query or "").strip()
    if not query or not has_credentials(override):
        return None
    ctx = "\n".join(f"- {s}" for s in context_subs if s)
    user = (
        f"学习者问的：{query}\n\n"
        f"视频标题：{episode_title}\n"
        f"视频简介：{episode_summary}\n"
        f"话题：{episode_topic}\n\n"
        f"问的这句字幕：{query_sub_text}\n\n"
        f"前后字幕：\n{ctx}"
    )
    raw = _chat(
        _EXPLAIN_IN_CONTEXT_SYS, user,
        max_tokens=1400, timeout=90,
        admin_tier=admin_tier, task="explain_in_context",
        override=override,
    )
    if not raw:
        return None
    return _strip_role_prefix(raw.strip())


_SENTENCE_PATTERN_SYS = _TEACH_PHILOSOPHY + """

你帮中国英语学习者从一段视频字幕里找出 1 个"换个主语就能换种说法"的句子，
然后给出 4 种地道改写。**核心目的不是教语法，是教用户开口前的认知触发**：当用户在真实场景里
要说同一件事，他脑子里第一个浮现的画面（人 / 物 / 地点 / 事件）决定了他自然会用哪种英语句式。
（这正是上面"画面感"哲学的应用 —— 不同的脑内画面，长出不同的英语说法。）

你会收到：
- 视频标题 + 一句话简介
- 完整字幕（带行号 #idx 和句子文本）

挑句标准（按优先级）：
1. 主谓宾完整、不是 filler（不要 "Yeah totally" / "I mean..." / 单独一个 "OK"）
2. 这句话能从 4 种心理触发点切入说出来（"我作为动作执行者"、"某个具体的物/人作为主体"、
   "某个地点/时间/事实作为框架"、"某个动作/事件本身作为话题"）
3. 含常见可换主语动词（surprise / make / leave / hit / give / take / catch / strike / bring 等 SVO 灵活的）
4. 句长 6-20 个英文词，太长太短都不好教
5. 是片中相对地道的母语者表达

输出严格 JSON（不能有 ```json 包裹、不能有解释文字）：

{
  "subtitle_idx": <int 字幕行号>,
  "original": "<原句英文，照抄字幕>",
  "variants": [
    {
      "text": "<改写 1，人作主语>",
      "mental_trigger": "<3-10 字，用户脑子里先浮现的具体内容，要写成「带书名号的名词短语」。例如：「我」/「你」/「他」/「我们这群人」>",
      "focus": "<10-30 字中文，'你脑子里先看到这个画面，英语自然就用 ___ 起头'，把脑内画面连到句式选择，讲感觉不讲语法>"
    },
    {
      "text": "<改写 2，物/具体名词作主语>",
      "mental_trigger": "<具体物的名字，例如：「行李箱」/「这家店」/「这个新闻」/「他给的建议」>",
      "focus": "<10-25 字>"
    },
    {
      "text": "<改写 3，地点 / 时间 / 事实作框架，常用 it 句型或介词短语提前>",
      "mental_trigger": "<例如：「那个地点」/「那一刻」/「这件事本身的酷」/「这是真的」>",
      "focus": "<10-25 字>"
    },
    {
      "text": "<改写 4，动名词 / 事件作主语>",
      "mental_trigger": "<例如：「买这件事」/「跑步本身」/「拥有它的过程」/「想到要去」>",
      "focus": "<10-25 字>"
    }
  ],
  "commentary_zh": "<60-120 字中文，告诉用户：碰到这个意思，脑子里先冒出什么画面就决定了你说哪种。中国学生通常先想「人」或「物」，但其实另两种也很常用，多练就能切换视角。多讲画面和感觉，说人话，别教科书化、别堆语法术语>"
}

规则：
- 4 种变体顺序固定：「人作主语」→「物 / 具体名词作主语」→「地点 / 框架（常用 it）」→「事件 / 动名词作主语」。
  **从最具体、最接近中国学生本能的视角开始，到最抽象的最后**。
- mental_trigger 必须是「带书名号的具体名词短语」，不是语法术语。**不要写**「人作主语」「物作主语」
  这种语法标签，**要写**「我」「行李箱」「那家店」这种用户脑子里真的会冒出来的画面。
- 同一个意思的 4 种触发点要彼此真的不一样。如果两种触发点几乎是同一个画面，宁可挑别的句子。
- 变体要保持原意不变，只换视角。不能添加新信息（比如原句没说"昨天"就别加）。
- 变体的 text 必须是地道母语者会说的，不能是直译生造。如果某种触发点实在不通顺，宁可挑别的句子。
- 如果整段字幕里找不到合适的句子（全是 filler），返回 {"original": "", "subtitle_idx": -1, "variants": [], "commentary_zh": ""}。"""


def pick_sentence_pattern(
    title: str,
    summary: str,
    subs: list[tuple[int, str]],
    extra_instruction: str = "",
    override: LLMOverride | None = None,
) -> dict | None:
    """Return one sentence + 4 perspective-shifted variants, or None on failure.

    `subs` is `[(idx, text_en), ...]` — idx is the subtitle row index in the
    episode (used by the frontend to seek to that line on click).

    `extra_instruction` is an optional learner-supplied steer (from the Learn
    page's Rephrase / 换着花样说 box) appended to the user message. The system prompt
    — including the strict JSON output contract — stays fixed so a freeform
    instruction can't break parsing.

    Soft-fails: returns None on any error so pipeline doesn't abort the import."""
    if not has_credentials() or not subs:
        return None
    lines = "\n".join(f"#{idx} {text}" for idx, text in subs if text.strip())
    if not lines.strip():
        return None
    user = (
        f"视频标题：{title}\n"
        f"视频简介：{(summary or '').strip()[:400]}\n\n"
        f"字幕：\n{lines[:6000]}"
    )
    if extra_instruction.strip():
        user += (
            "\n\n用户额外要求（在不破坏上面 JSON 输出格式的前提下尽量满足）：\n"
            f"{extra_instruction.strip()[:500]}"
        )
    raw = _chat_conversation(
        _SENTENCE_PATTERN_SYS, user,
        max_tokens=900, timeout=90,
        task="pick_sentence_pattern", override=override,
        # 输入是整段字幕、输出是一个小 JSON —— 跟选段/章节同一个形状，
        # 思考会把预算吃光然后返回空。实测 deepseek-v4-pro 就是这样挂的。
        no_think=_WHOLE_TRANSCRIPT_NO_THINK,
    )
    if not raw:
        return None
    try:
        data = _json_loads(_strip_json(raw))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    original = str(data.get("original", "")).strip()
    variants_raw = data.get("variants", [])
    if not original or not isinstance(variants_raw, list) or len(variants_raw) < 2:
        return None
    variants: list[dict] = []
    for v in variants_raw[:4]:
        if not isinstance(v, dict):
            continue
        text = str(v.get("text", "")).strip()
        if not text:
            continue
        # mental_trigger is the new field (psychological cue: 「我」/「行李箱」/...);
        # subject_type is kept ONLY for back-compat with old episodes whose
        # ai_metadata.sentence_pattern was generated under the previous prompt.
        # New episodes only fill mental_trigger.
        variants.append({
            "text": text,
            "mental_trigger": str(v.get("mental_trigger", "")).strip()[:48],
            "subject_type": str(v.get("subject_type", "")).strip()[:32],
            "focus": str(v.get("focus", "")).strip()[:120],
        })
    if len(variants) < 2:
        return None
    try:
        sub_idx = int(data.get("subtitle_idx", -1))
    except Exception:
        sub_idx = -1
    return {
        "original": original,
        "subtitle_idx": sub_idx,
        "variants": variants,
        "commentary_zh": str(data.get("commentary_zh", "")).strip()[:400],
    }


_FULL_RECORD_EVAL_SYS = """你给中国英语学习者评估"全片跟读"练习。

输入：
- 原片字幕（learner 应当跟读的目标）
- learner 实际说出的内容（Web Speech 转写，可能有识别错误，宽容判断）
- 用时秒数 + 语速 wpm
- 命中的 chunks / 漏掉的 chunks（chunk = 本集要学的地道短语）

输出 ONLY JSON（无 markdown 代码块）：
{
  "score": <0-10 整数>,
  "summary_zh": "<一句中文总评，≤30 字>",
  "fluency_zh": "<流利度短评，30-60 字中文，提语速/停顿/连贯性>",
  "accuracy_zh": "<内容准确度短评，30-60 字中文，提偏离/错说/漏说>",
  "chunk_zh": "<chunk 利用情况短评，30-60 字中文，鼓励用上漏掉的 chunk>",
  "next_step_zh": "<一句中文行动建议，≤40 字，告诉 learner 下一次重点练什么>"
}

评分尺度：
- 9-10 ≈ 流利近母语 / 内容覆盖完整
- 7-8 ≈ 大部分跟上 / 个别偏离 / 用了大半 chunk
- 5-6 ≈ 跟得磕磕巴巴 / 漏掉重要内容
- 3-4 ≈ 大量空白 / 说不出
- 0-2 ≈ 几乎没说

注意：
- ASR 转写可能把 chunk 写错（如 GPT→GPD），如果语义对就当对
- 不要因为 chunk 没字字命中就扣狠分，重在尝试
- 短评直接、具体，避免空话；至少给 1 条具体建议"""


def eval_full_record(
    original_text: str,
    user_transcript: str,
    duration_sec: float,
    wpm: float,
    chunks_hit: list[str],
    chunks_missed: list[str],
    admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> dict | None:
    """Evaluate a learner's full-episode shadowing recording. Returns dict or None."""
    if not has_credentials(override):
        return None
    if not (user_transcript or "").strip():
        return None
    user = (
        f"原片字幕（目标）：\n{(original_text or '').strip()[:4000]}\n\n"
        f"learner 转写：\n{user_transcript.strip()[:4000]}\n\n"
        f"用时：{duration_sec:.1f} 秒\n"
        f"语速：{wpm:.0f} wpm\n"
        f"命中 chunks（{len(chunks_hit)}）：{', '.join(chunks_hit) or '（无）'}\n"
        f"漏掉 chunks（{len(chunks_missed)}）：{', '.join(chunks_missed) or '（无）'}\n"
    )
    raw = _chat_conversation(
        _FULL_RECORD_EVAL_SYS, user, max_tokens=600, timeout=60,
        admin_tier=admin_tier, task="eval_full_record", override=override,
    )
    if not raw:
        return None
    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("eval_full_record parse failed: %s\nraw=%s", e, raw)
        return None
    if not isinstance(data, dict):
        return None
    try:
        score = int(data.get("score", 0))
    except Exception:
        score = 0
    score = max(0, min(10, score))
    return {
        "score": score,
        "summary_zh": str(data.get("summary_zh", "")).strip()[:80],
        "fluency_zh": str(data.get("fluency_zh", "")).strip()[:200],
        "accuracy_zh": str(data.get("accuracy_zh", "")).strip()[:200],
        "chunk_zh": str(data.get("chunk_zh", "")).strip()[:200],
        "next_step_zh": str(data.get("next_step_zh", "")).strip()[:120],
    }


def _norm_senses(raw_senses) -> list[dict]:
    """Coerce the LLM `senses` field into a clean [{pos,zh,en}] list."""
    out: list[dict] = []
    if not isinstance(raw_senses, list):
        return out
    for s in raw_senses:
        if not isinstance(s, dict):
            continue
        zh = str(s.get("zh", "")).strip()
        en = str(s.get("en", "")).strip()
        if not zh and not en:
            continue
        out.append({
            "pos": str(s.get("pos", "")).strip()[:16],
            "zh": zh[:120],
            "en": en[:300],
        })
        if len(out) >= 6:
            break
    return out


def lookup_word(
    word: str, context: str, admin_tier: bool = True,
    override: LLMOverride | None = None,
) -> dict | None:
    """Return a rich word entry, or None on failure.

    Shape: {word, ipa_uk, ipa_us, ipa, inflections, senses[{pos,zh,en}],
    definition_en, definition_zh, example}. `ipa` + definition_* are kept as
    back-compat mirrors of the US IPA / first sense for older clients."""
    word = (word or "").strip()
    if not word or not has_credentials(override):
        return None
    user = f"word: {word}\ncontext: {context.strip()[:400]}"
    raw = _chat(
        _WORD_LOOKUP_SYS, user, max_tokens=700, timeout=60,
        admin_tier=admin_tier, task="lookup_word", override=override,
    )
    if not raw:
        return None
    try:
        data = _json_loads(_strip_json(raw))
    except Exception:
        return None
    senses = _norm_senses(data.get("senses"))
    ipa_us = str(data.get("ipa_us") or data.get("ipa") or "").strip()
    ipa_uk = str(data.get("ipa_uk") or "").strip()
    # Back-compat mirrors so WordPopup / old rows still render.
    def_en = str(data.get("definition_en", "")).strip() or (
        senses[0]["en"] if senses else "")
    def_zh = str(data.get("definition_zh", "")).strip() or (
        senses[0]["zh"] if senses else "")
    return {
        "word": str(data.get("word", word)).lower(),
        "ipa_uk": ipa_uk,
        "ipa_us": ipa_us,
        "ipa": ipa_us,  # legacy single-IPA field
        "inflections": str(data.get("inflections", "")).strip()[:160],
        "senses": senses,
        "definition_en": def_en,
        "definition_zh": def_zh,
        "example": str(data.get("example", "")).strip(),
    }


_FEATURED_WORDS_SYS = _TEACH_PHILOSOPHY + """

You pick the 6–10 most valuable WORDS (not phrases) for a Chinese learner of English to study from this video clip. Follow the teaching philosophy above: each Chinese gloss should evoke the word's core image/feel, and the example should be a vivid real-life scene.

You receive the episode title, short summary, and the full English transcript.

Selection criteria (all must hold):
- Single words ONLY. No multi-word phrases (those belong to Chunks).
- CEFR level B2+ preferred. Include A few C1/C2 if they appear naturally. Skip A1/A2 basics (is, have, good, etc).
- Prioritise words that are CENTRAL to understanding the clip's message.
- Avoid proper nouns, numbers, pure technical jargon that won't generalise.
- Prefer words with concrete, teachable sense — verbs/adjectives/adverbs beat abstract nouns.
- Order by importance DESCENDING (most important first).

Respond with ONLY JSON (no markdown, no prose):
{
  "words": [
    {
      "word": "<base form, lowercase>",
      "pos": "<adj | n | v | adv>",
      "cefr": "<A2 | B1 | B2 | C1 | C2>",
      "ipa_uk": "<British RP IPA in / />",
      "ipa_us": "<US General American IPA in / />",
      "inflections": "<词形变化，· 分隔，如 'reads · reading · read'；没有就空字符串>",
      "senses": [
        { "pos": "<v. | n. | adj. ...>", "zh": "<该词性中文释义 ≤20 字>", "en": "<one short CEFR-B1 sentence>" }
      ],
      "definition_en": "<senses[0].en，再单独给一份>",
      "definition_zh": "<senses[0].zh，再单独给一份>",
      "example": "<natural, vivid real-life example sentence using the word>",
      "importance": <1–5 integer, 5 = THE word of this clip>
    }
  ]
}

Rules:
- `ipa_us` MUST be US General American (rhotic /r/, /ɝ/ not /ɜː/) in / /. `ipa_uk` is British RP. Fill both even if identical.
- `senses`: list the word's real distinct senses the way a dictionary does, the sense used in THIS clip first. 1–4 entries, don't pad.
- `inflections`: verb → 三单·现在分词·过去式/过去分词; noun → 复数; adj → 比较级·最高级; none → "".
- `definition_en` reuses simpler vocabulary than the word itself.
- Return 6–10 words. Fewer is fine for very short clips."""


def featured_words(
    title: str, summary: str, transcript_en: str,
    override: LLMOverride | None = None,
) -> list[dict]:
    """Return a list of per-episode featured words or empty list on failure.

    Each item matches the FeaturedWord model schema (see models/word.py).
    """
    if not transcript_en.strip() or not has_credentials(override):
        return []
    user = (
        f"Title: {title}\n\n"
        f"Summary: {summary.strip()[:500]}\n\n"
        f"Transcript:\n{transcript_en.strip()[:6000]}"
    )
    raw = _chat_conversation(
        _FEATURED_WORDS_SYS, user, max_tokens=3200, timeout=90,
        task="featured_words", override=override,
        no_think=_WHOLE_TRANSCRIPT_NO_THINK,
    )
    if not raw:
        return []
    try:
        data = _json_loads(_strip_json(raw))
    except Exception:
        return []
    items = data.get("words") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        word = str(it.get("word", "")).strip().lower()
        if not word or len(word) > 64 or " " in word:
            continue
        senses = _norm_senses(it.get("senses"))
        ipa_us = str(it.get("ipa_us") or it.get("ipa") or "").strip()[:128]
        ipa_uk = str(it.get("ipa_uk") or "").strip()[:128]
        def_en = str(it.get("definition_en", "")).strip() or (
            senses[0]["en"] if senses else "")
        def_zh = str(it.get("definition_zh", "")).strip() or (
            senses[0]["zh"] if senses else "")
        out.append({
            "word": word,
            "pos": str(it.get("pos", ""))[:16],
            "cefr": str(it.get("cefr", ""))[:8],
            "ipa": ipa_us,  # legacy single-IPA field
            "ipa_uk": ipa_uk,
            "ipa_us": ipa_us,
            "inflections": str(it.get("inflections", "")).strip()[:160],
            "senses": senses,
            "definition_en": def_en,
            "definition_zh": def_zh,
            "example": str(it.get("example", "")).strip(),
            "importance": max(1, min(5, int(it.get("importance", 3) or 3))),
        })
    return out[:10]


def translate_to_zh(
    text: str, admin_tier: bool = True, override: LLMOverride | None = None,
) -> str:
    """Translate a free-form English blob (episode summary, AI-reply bubble,
    etc.) to Chinese.  Returns empty string if no provider is available."""
    if not text.strip() or not has_credentials(override):
        return ""
    # Cap absurdly long inputs so we don't blow the prompt budget on a
    # description dump. 2000 English words is ~12000 chars — plenty for a
    # YouTube description.
    trimmed = text.strip()[:4000]
    # Wrap the input in explicit delimiters so the model can't confuse
    # "content to translate" with "instruction to follow".  Short inputs
    # like "What is X?" were being answered instead of translated.
    user_prompt = (
        "Translate the English text delimited by triple-quotes into Chinese. "
        "Do NOT answer questions, do NOT add commentary — translate only.\n\n"
        f'"""\n{trimmed}\n"""'
    )
    # Route through the conversation path first: gpt-4o-mini follows the
    # "translate-not-answer" instruction far more reliably than DeepSeek
    # on short question-shaped inputs.  Falls through to DeepSeek if
    # OpenAI is unavailable.
    raw = _chat_conversation(
        _TRANSLATE_SYS, user_prompt, max_tokens=1500,
        admin_tier=admin_tier, task="translate", override=override,
    )
    return (raw or "").strip()


# ---------- 2.5 Pick best learning segment ----------
_SEGMENT_SYS = """You pick the best 2-3 minute segment from a transcript for Chinese learners of English.

You're shown subtitle lines with [start-end] timestamps in seconds. ">>" marks a change of speaker.

LENGTH CONSTRAINT — HARD RULE:
- Window length (end - start) MUST be at least 120 seconds and at most 180 seconds.
- If the transcript is shorter than 120s total, pick from start to end of the transcript.
- A 30s, 60s, or 90s window will be REJECTED. Always reach 120s minimum even if it
  means including slightly less interesting content at the boundary.

CONTENT RULES:
- Start at a COMPLETE sentence boundary — the first line of your window must be the
  BEGINNING of a sentence (capital letter, not a fragment like "of what..." or "to the...").
- Start where the THOUGHT starts, not merely where a sentence starts. In an interview
  that means the ">>" line asking the question, never the answer on its own: a learner
  who hears "Well, I'm currently making just under 18k a month." without the question
  has no idea what is being discussed.
- End at a natural sentence boundary — don't cut off mid-sentence.
- Have clear, well-articulated speech suitable for listening practice.
- Be rich in natural expressions, idioms, collocations, or discourse markers.
- Be self-contained — a listener can follow without earlier context.

AVOID:
- Segments that start mid-sentence (e.g. "of what will hopefully be a 3D network...")
- Pure intros ("hi guys, today we're talking about..."), outros, sponsor reads
- Sections dominated by [Music], [Applause], [Laughter] or inaudible fragments
- Overlapping speakers where individual words are hard to distinguish

Respond with ONLY JSON:
{"start": <int seconds>, "end": <int seconds>, "reason": "<one short Chinese sentence explaining why>"}"""


def _coalesce_subs(subs: list[dict], bin_sec: float = 10.0) -> list[dict]:
    """Merge consecutive subtitle rows into ~bin_sec chunks so a 2h transcript
    still fits in one LLM call without losing coarse structure."""
    if not subs:
        return subs
    out: list[dict] = []
    cur_start = subs[0]["start_sec"]
    cur_end = cur_start
    cur_texts: list[str] = []
    for s in subs:
        if cur_texts and (s["start_sec"] - cur_start) >= bin_sec:
            out.append({"start_sec": cur_start, "end_sec": cur_end, "text_en": " ".join(cur_texts)})
            cur_start = s["start_sec"]
            cur_texts = []
        cur_texts.append(s["text_en"])
        cur_end = s["end_sec"]
    if cur_texts:
        out.append({"start_sec": cur_start, "end_sec": cur_end, "text_en": " ".join(cur_texts)})
    return out


def _hint_preamble(topic_hint: str) -> str:
    """Inject an admin-supplied directive into the segment-picker prompt.

    When the admin imports a 1-hour podcast that covers many things, the
    default "best learning value" picker spreads picks across topics
    randomly. This preamble pins the picker to one sub-area; the picker
    is told to return FEWER than asked rather than pad with off-topic
    content. Empty hint = no change.
    """
    h = (topic_hint or "").strip()
    if not h:
        return ""
    return (
        f"\n\nADMIN DIRECTIVE — HARD: Pick ONLY parts of the video that are about: \"{h}\". "
        f"If fewer than the requested count of qualifying windows exist, return what "
        f"you have. NEVER pad with off-topic content; off-topic segments will be "
        f"rejected. Lines that are clearly not about \"{h}\" (greetings, ads, "
        f"unrelated tangents, sponsor reads) are off-limits.\n"
    )


# Whole-transcript tasks (segment picking, chapter splitting, ad detection)
# run with DeepSeek's reasoning DISABLED, and this is not a tuning knob.
#
# Thinking tokens come out of the same max_tokens as the answer, and on these
# tasks the input is the entire transcript, so the thinking scales with the
# video length while the answer stays one small JSON object. Measured on a
# 62-minute podcast (QXMkkAcWask, 335 coalesced lines):
#
#   budget 1624 (the shipped default) → 1624 reasoning tokens, content ""
#   budget 4000                       → 4000 reasoning tokens, content "", 44s
#   reasoning disabled, budget 300    → valid JSON in 2s
#
# Raising the ceiling does not help, it just buys more thinking. And because
# an empty completion looks exactly like "no answer", every caller degraded
# silently: episodes 42-48 all shipped with `fallback window (no captions
# available)` — the first 150 seconds of the video, which is why clips opened
# mid-sentence on whatever the video happened to be saying at 0:02.
#
# The same failure hit subtitle translation earlier; pipeline._translate_window
# fixed it there the same way.
_WHOLE_TRANSCRIPT_NO_THINK = True


# ---------- 2.4 Locate sponsor reads / ad breaks ----------
# Both segment prompts have said "AVOID sponsor reads" from the start and the
# picker still handed back a window opening on a 35-second WorkOS read. A soft
# instruction competes with "pick the densest English"; an ad read is fluent,
# well-articulated, idiom-rich English, so it scores WELL on every other rule.
# Locating the ads as their own step gives the pipeline concrete ranges it can
# enforce in code (see pipeline._relocate_out_of_ads) instead of hoping.
_AD_SYS = """You locate ADVERTISEMENTS in a video transcript. You are NOT judging content quality.

You're shown subtitle lines with [start-end] timestamps in seconds.

Mark a span as an ad ONLY when the speaker stops discussing the video's actual
subject and starts promoting something. Reliable signals:
- "this episode is brought to you by", "thanks to our sponsor", "today's sponsor is"
- "sign up at <url>", "use code <X>", "link in the description", "first 100 listeners"
- A product pitch with a call to action that has nothing to do with the surrounding
  discussion, followed by a return to the earlier topic ("anyway, back to...")
- Channel self-promotion: subscribe/like asks, Patreon, newsletter, course pitches

Do NOT mark:
- The host genuinely discussing or reviewing a product as the topic of the video
- Someone naming their own company while explaining what they do
- Brief brand mentions inside a normal argument
When unsure, DO NOT mark it. A missed ad is far cheaper than deleting real content.

Give each span generous boundaries: start at the first word of the transition INTO
the ad and end at the last word before the discussion resumes.

Respond with ONLY a JSON array (empty array if there are no ads):
[{"start": <int seconds>, "end": <int seconds>, "what": "<what is being advertised>"}]"""


def detect_ad_spans(subtitles: list[dict]) -> list[dict]:
    """Find sponsor reads / promos in a transcript.

    Returns `[{start, end, what}]` in seconds, or `[]` when there are none,
    no provider is configured, or anything fails — callers treat an empty
    list as "no ad information", never as "verified ad-free".
    """
    if not subtitles or not has_credentials():
        return []

    work = subtitles
    if len(subtitles) > 900:
        work = _coalesce_subs(subtitles, bin_sec=10.0)
    if len(work) > 1500:
        work = _coalesce_subs(work, bin_sec=20.0)

    lines = "\n".join(
        f"[{int(s['start_sec'])}-{int(s['end_sec'])}] {s['text_en']}" for s in work
    )
    raw = _chat(
        _AD_SYS, f"Subtitles:\n{lines}", max_tokens=500, task="detect_ads",
        no_think=_WHOLE_TRANSCRIPT_NO_THINK,
    )
    if not raw:
        return []
    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("ad detection parse failed: %s\nraw=%s", e, raw[:300])
        return []
    if not isinstance(data, list):
        return []

    spans: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            start, end = int(item["start"]), int(item["end"])
        except Exception:
            continue
        # A "10 minute ad" is the model having mislabelled the actual content;
        # dropping it beats blanking out a third of the video.
        if end - start < 5 or end - start > 300:
            log.warning("ignoring implausible ad span %s-%s", start, end)
            continue
        spans.append({
            "start": max(0, start),
            "end": end,
            "what": str(item.get("what", ""))[:80],
        })
    spans.sort(key=lambda s: s["start"])
    log.info("ad spans detected: %s", spans)
    return spans


def _forbidden_block(ad_spans: list[dict]) -> str:
    """Restate detected ads as explicit numeric ranges for the picker.

    The prompt already forbids sponsor reads in the abstract; concrete
    timestamps are what the model actually acts on.
    """
    if not ad_spans:
        return ""
    ranges = ", ".join(f"{s['start']}-{s['end']}s" for s in ad_spans)
    return (
        "\n\nFORBIDDEN RANGES — these are advertisements, already identified. "
        f"Your window MUST NOT overlap any of them, not even by a second: {ranges}. "
        "Lines inside these ranges are prefixed [AD] below. Treat them as if they "
        "did not exist; if an ad sits in the middle of otherwise good material, "
        "pick a window entirely on one side of it.\n"
    )


def _mark_ad_lines(work: list[dict], ad_spans: list[dict]) -> str:
    """Render the subtitle listing with [AD] prefixes on ad lines."""
    out = []
    for s in work:
        start, end = int(s["start_sec"]), int(s["end_sec"])
        is_ad = any(start < a["end"] and end > a["start"] for a in ad_spans)
        tag = "[AD] " if is_ad else ""
        out.append(f"[{start}-{end}] {tag}{s['text_en']}")
    return "\n".join(out)


# ---------- 2.5a Chapter the whole video before picking inside one ----------
# "Start at a complete sentence" was never the real requirement. A clip can
# open on a grammatically perfect sentence and still be incomprehensible,
# because it is the ANSWER to a question asked thirty seconds earlier, or the
# third point of an argument whose premise is outside the window. That is what
# "从半路开始突然解释" describes, and no amount of sentence-boundary snapping
# fixes it — the unit of comprehension is the topic, not the sentence.
#
# So the picker no longer chooses a window over the raw timeline. It first has
# the model lay out the video's topic structure, then picks a window INSIDE one
# chapter, and the code clamps the result to that chapter's bounds. A window
# that would straddle a topic change is now unrepresentable rather than merely
# discouraged. The coverage rule (chapters must reach the end, not cluster at
# the front) is borrowed from the youtube-digest extension's overview prompt,
# which had to solve the same "model stops chaptering after 10 minutes" problem.
_TOPIC_OUTLINE_SYS = """You split a video transcript into CHAPTERS — the self-contained topic units it is actually made of.

You're shown subtitle lines with [start-end] timestamps in seconds. ">>" marks a change of speaker.

A chapter boundary is where the conversation genuinely moves on: a new question is asked, a new topic is introduced, a story ends and another begins. It is NOT a pause or a sentence end.

RULES:
- Chapters MUST cover the whole video from start to finish, in order, without gaps or overlaps.
- Your LAST chapter MUST start after {late_threshold} seconds. Do not stop partway through.
- Use as many chapters as the content genuinely has — typically 6-20 for a long video.
- Each chapter must begin at the line that OPENS the topic (the question, not the answer).
- Mark a chapter `"ad": true` when it is a sponsor read, self-promotion, or channel plug.

Respond with ONLY a JSON array, ONE COMPACT OBJECT PER LINE, no indentation:
[{"start": <int seconds>, "end": <int seconds>, "title": "<short English title>", "ad": false},
{"start": ..., "end": ..., "title": "...", "ad": false}]"""


def outline_topic_units(subtitles: list[dict], duration_sec: int = 0) -> list[dict]:
    """Lay out the video's topic structure as ordered, gap-free chapters.

    Named "topic units" only because split_into_chapters() further down is
    already taken by the user-facing chapter-navigation feature, which has a
    different contract (60-300s, bilingual titles, shipped to the player).
    These chapters exist purely so the segment picker has topic bounds to
    stay inside, and are never persisted.

    Returns [{start, end, title, ad}] sorted by start, or [] on any failure —
    callers must treat an empty list as "no structure information" and fall
    back to picking over the raw timeline.
    """
    if not subtitles or not has_credentials():
        return []
    if len(subtitles) < 5:
        return []

    work = subtitles
    if len(subtitles) > 900:
        work = _coalesce_subs(subtitles, bin_sec=10.0)
    if len(work) > 1500:
        work = _coalesce_subs(work, bin_sec=20.0)

    total = duration_sec or int(work[-1]["end_sec"])
    lines = "\n".join(
        f"[{int(s['start_sec'])}-{int(s['end_sec'])}] {s['text_en']}" for s in work
    )
    sys_prompt = _TOPIC_OUTLINE_SYS.replace("{late_threshold}", str(int(total * 0.75)))
    raw = _chat(
        sys_prompt, f"Video length: {total}s\nSubtitles:\n{lines}",
        max_tokens=2500, timeout=120, task="select_segment",
        no_think=_WHOLE_TRANSCRIPT_NO_THINK,
    )
    if not raw:
        log.warning("chaptering returned nothing; picker will use the raw timeline")
        return []
    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        # A chapter list cut off mid-object still describes the part of the
        # video it reached, and the picker only needs somewhere valid to pick
        # from. Losing the tail biases picks earlier; losing everything drops
        # us back to picking blind over the raw timeline, which is worse.
        data = _salvage_truncated_chunk_array(raw)
        if data is None:
            log.warning("chapter parse failed: %s\nraw=%s", e, raw[:300])
            return []
        log.warning("chapter JSON truncated (%s); salvaged %d complete chapters",
                    e, len(data))
    if not isinstance(data, list):
        return []

    chapters: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            start, end = int(item["start"]), int(item["end"])
        except Exception:
            continue
        if end <= start:
            continue
        chapters.append({
            "start": max(0, start),
            "end": min(end, total) if total else end,
            "title": str(item.get("title", "")).strip()[:80],
            "ad": bool(item.get("ad")),
        })
    chapters.sort(key=lambda c: c["start"])
    log.info("chaptered into %d units (%d flagged as ads)",
             len(chapters), sum(1 for c in chapters if c["ad"]))
    return chapters


# A chapter shorter than this cannot host a 2-minute clip with any room to
# breathe, so the picker skips it rather than padding across the boundary it
# was created to respect.
_MIN_CHAPTER_SEC = 100
# How close to a chapter's opening a pick has to be before we just use the
# opening. Sized to one or two sentences of speech, not a topic's worth.
_CHAPTER_HEAD_SNAP_SEC = 25


def _usable_chapters(chapters: list[dict], ad_spans: list[dict]) -> list[dict]:
    """Chapters long enough to hold a clip and not overlapping a known ad."""
    out = []
    for c in chapters:
        if c.get("ad") or c["end"] - c["start"] < _MIN_CHAPTER_SEC:
            continue
        if any(c["start"] < a["end"] and c["end"] > a["start"] for a in ad_spans):
            continue
        out.append(c)
    return out


def _clamp_to_chapter(seg: dict, chapter: dict) -> dict:
    """Force a picked window inside its chapter, keeping the length if we can.

    The clamp is the mechanical half of the chapter design: the prompt asks
    for a window inside one chapter, this guarantees it. A window that has
    drifted past the chapter's end slides back rather than being truncated,
    so we keep the requested duration whenever the chapter is long enough.

    A pick that lands just inside the chapter's opening is pulled back to the
    opening itself. Those few seconds are usually the sentence that says what
    the topic IS, and starting after them is how a clip ends up opening on a
    grammatically perfect sentence that still continues a thought the listener
    never heard ("Um but if you're first starting out, you're going to have
    to." — have to what?). Beyond _CHAPTER_HEAD_SNAP_SEC the model is choosing
    a genuinely later moment, and we leave it alone.
    """
    c_start, c_end = chapter["start"], chapter["end"]
    length = max(1, seg["end"] - seg["start"])
    start = max(c_start, min(seg["start"], c_end - 1))
    if start - c_start <= _CHAPTER_HEAD_SNAP_SEC:
        start = c_start
    end = start + length
    if end > c_end:
        end = c_end
        start = max(c_start, end - length)
    return {**seg, "start": start, "end": end}


def select_learning_segment(
    subtitles: list[dict],
    topic_hint: str = "",
    ad_spans: list[dict] | None = None,
    chapters: list[dict] | None = None,
) -> dict | None:
    """Given subtitles [{start_sec, end_sec, text_en}, ...], return
    {start, end, reason} or None to fall back to whole video. Optional
    topic_hint biases the LLM toward one sub-area (see _hint_preamble);
    chapters (from outline_topic_units) confine the pick to one topic."""
    picks = select_learning_segments(
        subtitles, 1, topic_hint=topic_hint, ad_spans=ad_spans, chapters=chapters,
    )
    return picks[0] if picks else None


# ---------- 2.6 Pick N best non-overlapping learning segments ----------
_SEGMENT_MULTI_SYS = """You pick the {n} best non-overlapping segments from a transcript for Chinese English learners.

LENGTH CONSTRAINT — HARD RULE:
- Each segment's (end - start) MUST be at least 120 seconds and at most 180 seconds.
- 30s, 60s, 90s segments will be REJECTED. Always reach 120s minimum.

">>" marks a change of speaker.

Each segment MUST:
- Start at a COMPLETE sentence boundary (capital letter, beginning of a sentence — NOT a fragment)
- Start where the THOUGHT starts: in an interview, the question, never the bare answer
- End at a natural sentence boundary
- Have clear, well-articulated speech suitable for listening practice
- Be rich in natural expressions, idioms, collocations, or discourse markers
- Be self-contained (listener can follow without earlier context)
- AVOID intros, outros, sponsor reads, and sections dominated by [Music]/[Applause]

Additional rules:
- Segments MUST NOT overlap
- Spread them across the video (don't cluster in the first 10 minutes)
- Order them chronologically (lowest start time first)

Respond with ONLY a JSON array of exactly {n} objects:
[{{"start": <int seconds>, "end": <int seconds>, "reason": "<one short Chinese sentence>"}}]"""


_SEGMENT_IN_CHAPTERS_SYS = """You pick the {n} best learning segment(s) for Chinese English learners, each one taken from INSIDE a single chapter of the video.

You're shown the video's chapters, then the transcript with [start-end] timestamps in seconds. ">>" marks a change of speaker.

HARD RULES:
- Each segment must lie entirely inside ONE chapter. Never span two chapters — a window that crosses a topic change is unusable no matter how good the English is.
- Length (end - start) must be 120-180 seconds. If the chapter is shorter than 120s, pick a different chapter.
- Pick {n} DIFFERENT chapters, one segment each.
- Start where the thought starts. In an interview that means the QUESTION, never the answer on its own — a learner who hears the answer without the question has no idea what is being discussed.
- End on a finished thought.

Prefer chapters with clear, well-articulated speech that is rich in everyday expressions, idioms, collocations and discourse markers. Skip chapters that are sponsor reads, intros, outros, or dominated by [Music]/[Applause].

Respond with ONLY a JSON array of exactly {n} objects:
[{"chapter": <int chapter number>, "start": <int seconds>, "end": <int seconds>, "reason": "<one short Chinese sentence>"}]"""


def _chapter_menu(chapters: list[dict]) -> str:
    return "\n".join(
        f"#{i} [{c['start']}-{c['end']}] {c['title']}" for i, c in enumerate(chapters)
    )


def _pick_within_chapters(
    n: int, usable: list[dict], lines: str, topic_hint: str, ad_spans: list[dict],
) -> list[dict]:
    """Ask for n windows, each confined to one chapter; clamp what comes back."""
    prompt = (
        _SEGMENT_IN_CHAPTERS_SYS.replace("{n}", str(n))
        + _hint_preamble(topic_hint)
        + _forbidden_block(ad_spans)
    )
    user = f"CHAPTERS:\n{_chapter_menu(usable)}\n\nSubtitles:\n{lines}"
    raw = _chat(
        prompt, user, max_tokens=200 + 200 * n, timeout=120, task="select_segment",
        no_think=_WHOLE_TRANSCRIPT_NO_THINK,
    )
    if not raw:
        return []
    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("chapter-confined pick parse failed: %s\nraw=%s", e, raw[:400])
        return []
    if not isinstance(data, list):
        return []

    picked: list[dict] = []
    used_chapters: set[int] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item["chapter"])
            seg = {
                "start": int(item["start"]),
                "end": int(item["end"]),
                "reason": str(item.get("reason", "")),
            }
        except Exception:
            continue
        if not (0 <= idx < len(usable)) or idx in used_chapters or seg["end"] <= seg["start"]:
            continue
        used_chapters.add(idx)
        clamped = _clamp_to_chapter(seg, usable[idx])
        clamped["chapter_title"] = usable[idx]["title"]
        picked.append(clamped)
    picked.sort(key=lambda s: s["start"])
    return picked[:n]


def select_learning_segments(
    subtitles: list[dict],
    n: int = 1,
    topic_hint: str = "",
    ad_spans: list[dict] | None = None,
    chapters: list[dict] | None = None,
) -> list[dict]:
    """Pick N non-overlapping segments from a transcript.

    Returns a list of {start, end, reason} dicts sorted by start time, or []
    when the model gives us nothing usable — the pipeline then falls back to a
    blind window, which is a visibly worse clip, so both paths retry once.

    With `chapters` (from outline_topic_units) the pick is confined to one
    chapter per segment and clamped in code; without them it falls back to
    choosing freely over the timeline. Optional topic_hint biases toward one
    sub-area; ad_spans (from detect_ad_spans) are declared off-limits.
    """
    if not subtitles or not has_credentials():
        return []
    if len(subtitles) < 5:
        return []

    # For long videos (1-2h podcasts have 1500+ lines), downsample to stay well
    # under provider context limits. 10s bins → ~720 rows for a 2h video.
    work = subtitles
    if len(subtitles) > 900:
        work = _coalesce_subs(subtitles, bin_sec=10.0)
    if len(work) > 1500:
        work = _coalesce_subs(work, bin_sec=20.0)

    ad_spans = ad_spans or []
    lines = _mark_ad_lines(work, ad_spans)

    usable = _usable_chapters(chapters or [], ad_spans)
    if len(usable) >= n:
        for attempt in (1, 2):
            picked = _pick_within_chapters(n, usable, lines, topic_hint, ad_spans)
            if picked:
                log.info("picked %d segment(s) inside chapters: %s",
                         len(picked), [(s["start"], s["end"]) for s in picked])
                return picked
            log.warning("chapter-confined pick attempt %d/2 came back empty", attempt)
    elif chapters:
        log.warning("only %d usable chapters for %d segment(s); picking freely",
                    len(usable), n)

    # No chapters (or they were unusable): pick over the raw timeline.
    prompt = (
        (_SEGMENT_SYS if n == 1 else _SEGMENT_MULTI_SYS.replace("{n}", str(n)))
        + _hint_preamble(topic_hint)
        + _forbidden_block(ad_spans)
    )
    for attempt in (1, 2):
        raw = _chat(
            prompt, f"Subtitles:\n{lines}", max_tokens=300 + 300 * n,
            timeout=120, task="select_segment",
            no_think=_WHOLE_TRANSCRIPT_NO_THINK,
        )
        if raw:
            break
        log.warning("flat segment pick attempt %d/2 returned nothing", attempt)
    if not raw:
        return []

    try:
        data = _json_loads(_strip_json(raw))
        # The single-segment prompt answers with one object, the multi one
        # with an array; accept either shape from either prompt.
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            return []
        segments: list[dict] = []
        for item in data:
            start = int(item["start"])
            end = int(item["end"])
            # Allow shorter segments through here too — _enforce_segment_bounds
            # in pipeline.py will pad them up to at least 120s. Filtering them
            # out here would lose the LLM's *positional* signal entirely.
            if end > start:
                segments.append({
                    "start": start,
                    "end": end,
                    "reason": item.get("reason", ""),
                })
        segments.sort(key=lambda s: s["start"])
        # Remove overlaps: keep each segment only if it starts after the previous ends
        deduped: list[dict] = []
        for seg in segments:
            if deduped and seg["start"] < deduped[-1]["end"]:
                continue
            deduped.append(seg)
        return deduped[:n]
    except Exception as e:
        log.warning("segment pick parse failed: %s\nraw=%s", e, raw[:500])
        return []


# ---------- 2.6b Split a whole video into N coherent 2-3min segments ----------
_FULL_SPLIT_SYS = """You split a complete YouTube video into multiple coherent learning segments for Chinese English learners.

INPUT: the full English transcript (with [start-end] second markers on each line).

OUTPUT: a JSON array of segments covering the whole video end-to-end, in order.

HARD CONSTRAINTS:
- Each segment duration MUST be between 120 and 180 seconds.
  - Floor 120s: never produce 60s or 90s segments; merge short ones up.
  - Ceiling 180s: split long monologues; never go past 200s.
- Each segment MUST start at a sentence boundary (capitalised word, start of an utterance).
- Each segment MUST end at a sentence boundary (period / question / exclamation / clear pause).
- Segments MUST NOT overlap and MUST be chronological.
- Segments together SHOULD cover roughly the whole video. It is fine to skip a clear intro/outro at the very start or very end if it's pure greeting / sponsor read / outro music — otherwise include it.

PREFERRED CUTS (use when possible WITHOUT breaking the 120-180s window):
- Topic transitions ("Alright, so let's talk about...", "Now, the next thing is...")
- Speaker hands off, scene changes, "OK moving on", clear new question in an interview.
- Long pauses or hard cuts in the transcript.
- AVOID cutting in the middle of an argument, a list, a story, or a quote.

TITLES:
- Give each segment a short, content-rich Chinese title (≤ 18 字), describing what this segment is actually about.
- Avoid generic titles ("第一段", "开头"). Be specific: "Claude Code 的安装流程", "他为什么转行做 AI".
- Reserve "导入 / 引入" only when the segment really is an intro.

OUTPUT FORMAT — ONLY JSON, no markdown fences:
[
  {"start": <int seconds>, "end": <int seconds>, "title": "<short Chinese title>", "topic_zh": "<one-sentence Chinese topic blurb, ≤30 字>"}
]

HARD LIMIT: at most 20 segments. If the natural split would produce more, merge adjacent short ones until you fit 20."""


def split_full_video(
    subtitles: list[dict], max_segments: int = 20, topic_hint: str = "",
) -> list[dict]:
    """Split the full transcript into ordered 2-3min segments.

    Returns a list of {start, end, title, topic_zh}.  Empty list on failure
    (caller falls back to mechanical sentence-boundary splitting).
    Optional topic_hint biases the splitter toward one sub-area."""
    if not subtitles or not has_credentials():
        return []
    if len(subtitles) < 5:
        return []

    work = subtitles
    if len(subtitles) > 900:
        work = _coalesce_subs(subtitles, bin_sec=10.0)
    if len(work) > 1500:
        work = _coalesce_subs(work, bin_sec=20.0)

    lines = "\n".join(f"[{int(s['start_sec'])}-{int(s['end_sec'])}] {s['text_en']}" for s in work)
    sys = _FULL_SPLIT_SYS + f"\n\nNote: max_segments for this video is {max_segments}." + _hint_preamble(topic_hint)
    raw = _chat_conversation(
        sys, f"Subtitles:\n{lines}",
        max_tokens=2200, timeout=120,
        task="select_segment",
        no_think=_WHOLE_TRANSCRIPT_NO_THINK,
    )
    if not raw:
        return []

    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("full-split parse failed: %s\nraw=%s", e, raw[:500])
        return []
    if not isinstance(data, list):
        return []

    segments: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            start = int(item["start"])
            end = int(item["end"])
        except Exception:
            continue
        if end <= start:
            continue
        title = str(item.get("title", "")).strip()[:80]
        topic_zh = str(item.get("topic_zh", "")).strip()[:120]
        segments.append({
            "start": start,
            "end": end,
            "title": title,
            "topic_zh": topic_zh,
        })
    segments.sort(key=lambda s: s["start"])

    # Remove overlaps: keep each segment only if it starts after the previous ends.
    deduped: list[dict] = []
    for seg in segments:
        if deduped and seg["start"] < deduped[-1]["end"]:
            continue
        deduped.append(seg)
    return deduped[:max_segments]


# ---------- 2.6c Split a full video into chapter navigation markers ----------
#
# Distinct from `split_full_video`: chapters are *navigation only*. They live
# inside ONE Episode (import_mode='chapters'), don't gate the AI conversation
# or chunk extraction, and are allowed to be shorter (60s) for fast-paced
# tutorials and longer (300s) for monologues — split_full_video's 120-180s
# learning-window constraint doesn't apply here.
_CHAPTERS_SYS = """You break a full YouTube video into chapter markers for Chinese English learners to navigate.

INPUT: the full English transcript (with [start-end] second markers on each line).

OUTPUT: a JSON array of chapters covering the whole video end-to-end, in chronological order.

HARD CONSTRAINTS:
- Each chapter duration MUST be between 60 and 300 seconds.
- Each chapter MUST start and end at a sentence boundary.
- Chapters MUST NOT overlap and MUST be chronological.
- Together they SHOULD cover roughly the whole video (you may skip a pure intro greeting / sponsor read / outro).
- Produce between 5 and 15 chapters total. If the natural split would produce more, merge short adjacent ones.

CHAPTER BREAKS — use real topic boundaries:
- Topic transitions ("Alright, so next...", "Now, the next thing is...")
- Speaker hand-offs / question changes in interviews
- "OK moving on", "Let's talk about...", clear new section
- AVOID cutting mid-argument, mid-list, mid-story, or mid-quote.

TITLES & SUMMARY:
- title_en: short English title (≤ 60 chars), specific to the content of THIS chapter, not generic.
- title_zh: short Chinese title (≤ 18 字), same constraints.
- summary_zh: 1 sentence Chinese summary of what's discussed in this chapter (≤ 50 字).
- Avoid "第一段", "开头", "Intro" unless the chapter really is a pure introduction.

OUTPUT FORMAT — ONLY JSON, no markdown fences:
[
  {"start": <int seconds>, "end": <int seconds>, "title_en": "<short English title>", "title_zh": "<short Chinese title>", "summary_zh": "<one-sentence Chinese summary>"}
]"""


def split_into_chapters(
    subtitles: list[dict], full_duration_sec: int = 0,
) -> list[dict]:
    """Split the full transcript into ordered chapter navigation markers.

    Returns a list of {start, end, title_en, title_zh, summary_zh}.  Empty
    list on failure — caller must handle (chapters mode is degenerate without
    chapters, so the pipeline should hard-fail rather than ship a chapters
    episode with zero chapters).
    """
    if not subtitles or not has_credentials():
        return []
    if len(subtitles) < 5:
        return []

    work = subtitles
    if len(subtitles) > 900:
        work = _coalesce_subs(subtitles, bin_sec=10.0)
    if len(work) > 1500:
        work = _coalesce_subs(work, bin_sec=20.0)

    lines = "\n".join(f"[{int(s['start_sec'])}-{int(s['end_sec'])}] {s['text_en']}" for s in work)
    sys = _CHAPTERS_SYS
    if full_duration_sec:
        sys += f"\n\nVideo total duration: {full_duration_sec} seconds."
    raw = _chat_conversation(
        sys, f"Subtitles:\n{lines}",
        max_tokens=2500, timeout=120,
        task="split_chapters",
        no_think=_WHOLE_TRANSCRIPT_NO_THINK,
    )
    if not raw:
        return []

    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("chapters parse failed: %s\nraw=%s", e, raw[:500])
        return []
    if not isinstance(data, list):
        return []

    chapters: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            start = int(item["start"])
            end = int(item["end"])
        except Exception:
            continue
        if end <= start:
            continue
        chapters.append({
            "start": start,
            "end": end,
            "title_en": str(item.get("title_en", "")).strip()[:255],
            "title_zh": str(item.get("title_zh", "")).strip()[:255],
            "summary_zh": str(item.get("summary_zh", "")).strip()[:500],
        })
    chapters.sort(key=lambda c: c["start"])

    # Strip overlaps so the UI scrub-bar timeline behaves predictably.
    deduped: list[dict] = []
    for ch in chapters:
        if deduped and ch["start"] < deduped[-1]["end"]:
            continue
        deduped.append(ch)
    # Hard cap matches the prompt's 5-15 range upper bound.
    return deduped[:15]


# ---------- 2.7 Summarize a clip for learners ----------
_CLIP_SUMMARY_SYS = """You write the Chinese intro card that a friend would type to recommend this clip to a Chinese English-learner buddy.

You receive the clip transcript, plus when available the creator's name and the clip title.

Write TWO things:
- "en": 1-2 sentences plain factual English summary of what THIS clip is about (used by classifier; just be accurate, no flavor needed)
- "zh": the friend-style Chinese intro — THIS is the one users see

Rules for the Chinese intro ("zh"):
- Open with the creator's name when given (e.g. "Mel Robbins 又来开炮了……" / "Ali 这次聊的是……" / "Mary 今天讲了个挺扎心的话题……").
- Sound like one friend talking to another over coffee — casual, natural, a bit opinionated. NOT like a press release or course syllabus.
- Show what's actually said, including a punchy quote or specific claim from the clip when there is one — do not summarize abstractly.
- 2-4 short sentences total, mix lengths, no bullet points.
- DO NOT use "本集 / 本片段 / 本段视频 / 在这个视频中 / In this clip" or any other "this clip discusses…" boilerplate. Just describe the content directly, the way you'd describe it to a friend who asked "看了什么有意思的？".
- If the creator name is unknown, open with the topic itself ("讲离婚那点破事的播客……") rather than with "这个视频…".
- Avoid translating fixed English terms (chunks the learner is supposed to encounter): keep them in English (e.g. "emotional immaturity"), the friendly tone is in the Chinese around them.

Respond with ONLY JSON:
{"en": "<English summary>", "zh": "<Chinese intro in friend tone>"}"""


def summarize_clip(
    transcript_en: str,
    creator_name: str = "",
    title: str = "",
) -> tuple[str, str]:
    """Generate (en_summary, zh_summary) for a clip's transcript.

    creator_name (optional): the YouTube creator / Speaker name. When set,
        the Chinese intro will open with the creator's name in a casual,
        friend-recommending-friend tone. When empty, the intro opens with
        the topic instead (still casual, just no name hook).
    title (optional): the clip title; folded into context so the LLM can
        echo specifics if the transcript alone is too vague.

    Returns ("", "") if no provider available."""
    if not transcript_en.strip() or not has_credentials():
        return "", ""
    trimmed = transcript_en[:3000]
    ctx_lines: list[str] = []
    if creator_name.strip():
        ctx_lines.append(f"Creator: {creator_name.strip()}")
    if title.strip():
        ctx_lines.append(f"Title: {title.strip()}")
    ctx_lines.append(f"Transcript:\n{trimmed}")
    raw = _chat(_CLIP_SUMMARY_SYS, "\n\n".join(ctx_lines), max_tokens=500, task="summarize")
    if not raw:
        return "", ""
    try:
        data = _json_loads(_strip_json(raw))
        return data.get("en", ""), data.get("zh", "")
    except Exception as e:
        log.warning("clip summary parse failed: %s", e)
        return "", ""


# ---------- 2.8 Per-episode lesson brief ----------
# A pre-generated, structured "study card" displayed above the AI chat.
# Generated ONCE per Episode at pipeline stage 5 (or on admin re-trigger),
# stored in ai_metadata["lesson_brief"], read by the frontend's
# LessonBriefCard component.  Replaces the old pattern of regenerating
# scenario-flavored intro text on every conversation start.
_LESSON_BRIEF_SYS = """You write a structured "Lesson Brief" — a learning roadmap that a Chinese English learner reads BEFORE chatting with the AI tutor about this clip.

Inputs you receive:
- The 2-3 minute clip transcript
- The list of "target chunks" (multi-word expressions) the learner should practice using
- Optionally: the creator's name and clip title

Produce JSON with FOUR fields. The whole brief is rendered in Chinese with embedded English terms — never translate the chunks themselves.

1. "core_points" — 2-3 takeaways. Each is the speaker's actual position or claim, NOT a generic "this video talks about X" wrapper. Format: array of objects:
   {"en": "<original phrasing or close paraphrase, ≤15 words>",
    "zh": "<Chinese sentence stating the same point with the English term inline when natural>"}

2. "target_chunks_hint" — 3-5 chunks (chosen FROM the provided target list) that fit naturally into the discussion question below. Each entry is a Chinese-explained chip:
   {"text": "<chunk text exactly as in target list>",
    "zh": "<Chinese gloss, 4-10 chars, what the chunk means>"}
   Order them by how likely the learner is to need them when answering.

3. "speaking_prompts" — 3-4 specific guidance bullets that progressively unpack the discussion question. They are scaffolding hints for the learner. Each is a short Chinese sentence (8-20 chars) describing what to talk about; embed the English term if natural. Example shape: ["描述一个让你 emotional exhaustion 的人", "分享你是否曾试图改变或影响对方", ...]
   Output as an array of strings.

4. "discussion_question" — ONE central open-ended prompt that ties the clip to the learner's life. Use real English the AI tutor will actually open the conversation with:
   {"en": "<single English question, ≤20 words>",
    "zh": "<Chinese gloss with key English terms inline>"}

Hard rules:
- Do NOT invent claims that aren't in the transcript. Quote or close-paraphrase.
- Keep all English terms in English (chunks, named concepts).  Chinese is for connective tissue.
- No emojis in the JSON values; the frontend adds icons.
- Return ONLY the JSON object — no preamble.

Schema:
{
  "core_points": [{"en": "...", "zh": "..."}, ...],
  "target_chunks_hint": [{"text": "...", "zh": "..."}, ...],
  "speaking_prompts": ["...", "..."],
  "discussion_question": {"en": "...", "zh": "..."}
}"""


def _normalize_lesson_brief(data: dict, target_chunks: list[str]) -> dict | None:
    """Coerce the LLM's lesson_brief JSON into the schema we expect.

    Drops malformed entries instead of failing the whole brief — a partial
    brief still beats no brief.  Also clamps target_chunks_hint['text'] to
    only chunks that actually appear in the provided target list (so the
    UI's chip-with-tooltip can resolve to a real Chunk row)."""
    if not isinstance(data, dict):
        return None
    target_set = {c.strip(): c.strip() for c in target_chunks}

    cp_in = data.get("core_points") or []
    core_points: list[dict] = []
    for c in cp_in if isinstance(cp_in, list) else []:
        if not isinstance(c, dict):
            continue
        en = str(c.get("en", "")).strip()
        zh = str(c.get("zh", "")).strip()
        if en or zh:
            core_points.append({"en": en, "zh": zh})

    hint_in = data.get("target_chunks_hint") or []
    chunks_hint: list[dict] = []
    for h in hint_in if isinstance(hint_in, list) else []:
        if not isinstance(h, dict):
            continue
        text = str(h.get("text", "")).strip()
        zh = str(h.get("zh", "")).strip()
        if not text:
            continue
        # Only keep chunks the LLM didn't hallucinate. Match case-insensitively
        # but preserve the original target text so the frontend chip lookup
        # against episode.chunks works.
        match = next(
            (orig for orig in target_set if orig.lower() == text.lower()),
            None,
        )
        if match is None:
            continue
        chunks_hint.append({"text": match, "zh": zh})

    prompts_in = data.get("speaking_prompts") or []
    speaking_prompts: list[str] = [
        str(p).strip() for p in (prompts_in if isinstance(prompts_in, list) else [])
        if str(p).strip()
    ]

    dq_in = data.get("discussion_question") or {}
    discussion_question = None
    if isinstance(dq_in, dict):
        en = str(dq_in.get("en", "")).strip()
        zh = str(dq_in.get("zh", "")).strip()
        if en or zh:
            discussion_question = {"en": en, "zh": zh}

    # Refuse to persist a brief with nothing in it — caller treats None as
    # "skip persisting" and leaves ai_metadata.lesson_brief absent.
    if not core_points and not chunks_hint and not speaking_prompts and not discussion_question:
        return None
    return {
        "core_points": core_points,
        "target_chunks_hint": chunks_hint,
        "speaking_prompts": speaking_prompts,
        "discussion_question": discussion_question,
    }


def generate_lesson_brief(
    transcript_en: str,
    target_chunks: list[str],
    creator_name: str = "",
    title: str = "",
) -> dict | None:
    """Generate the structured Lesson Brief shown above the AI chat.

    Returns the validated dict on success, None on any failure (no
    provider, empty transcript, parse error, all-empty validation).
    Callers persist the result into Episode.ai_metadata['lesson_brief'].

    Soft-fail by design: if the LLM is having a bad day, the episode
    still ships without a brief and the admin can re-run via the
    regenerate-lesson-brief endpoint.
    """
    if not transcript_en.strip() or not target_chunks or not has_credentials():
        return None
    ctx_lines: list[str] = []
    if creator_name.strip():
        ctx_lines.append(f"Creator: {creator_name.strip()}")
    if title.strip():
        ctx_lines.append(f"Title: {title.strip()}")
    ctx_lines.append("Target chunks: " + " | ".join(target_chunks[:20]))
    ctx_lines.append(f"Transcript:\n{transcript_en[:4000]}")
    raw = _chat(_LESSON_BRIEF_SYS, "\n\n".join(ctx_lines), max_tokens=900, task="summarize")
    if not raw:
        return None
    try:
        data = _json_loads(_strip_json(raw))
    except Exception as e:
        log.warning("lesson brief parse failed: %s\nraw=%s", e, raw[:300])
        return None
    return _normalize_lesson_brief(data, target_chunks)


# ---------- 3. Chunk extraction ----------
_CHUNK_SYS = _TEACH_PHILOSOPHY + """

You extract "chunks" from English transcripts for Chinese learners.
A chunk is a 2-6 word multi-word expression that:
- is NOT a single common word,
- has a clear pragmatic or functional meaning,
- would surprise a Chinese learner who studied from textbooks (i.e. textbooks don't teach it well),
- a native speaker uses without thinking.

Extract __MIN_COUNT__-__MAX_COUNT__ chunks from the given transcript. Pick the most natural and high-value ones; do not pad with weak items just to hit the upper bound.

Respond with JSON: an array of objects, each with:
{
  "text": "<the chunk exactly as it appears>",
  "chunk_type": "idiomatic" | "collocation" | "discourse" | "functional" | "cultural",
  "why_explanation": "<中文，2-4 句，按上面的方式：先说 native 脑子里的画面/感觉，再说它为什么会长成这样（旧画面 / 为什么这个介词带这种感觉 / 现代新词为何出现）。需要时用 A ← x → B 这类箭头。别讲语法术语，别只甩'固定搭配'>",
  "usage_scenario": "<中文，什么真实生活场景下会脱口而出，带画面>",
  "similar_expressions": ["<other ways to say the same thing>"],
  "common_collocations": ["<what words typically follow or precede>"],
  "pronunciation_tip": "<Chinese, any linking/reduction note>",
  "difficulty": 1-5
}

每条 why_explanation 要简洁有画面，别写成长篇大论（这会拖慢导入）。"""


def _normalize_chunks(data: list) -> list[dict]:
    """Coerce a raw list of chunk dicts into our schema, dropping rows that
    don't even have a `text` field (a partial last item from a salvaged truncation)."""
    out: list[dict] = []
    for c in data:
        if not isinstance(c, dict) or not c.get("text"):
            continue
        out.append(dict(
            text=c["text"],
            chunk_type=c.get("chunk_type", "collocation"),
            why_explanation=c.get("why_explanation", ""),
            usage_scenario=c.get("usage_scenario", ""),
            similar_expressions=c.get("similar_expressions", []),
            common_collocations=c.get("common_collocations", []),
            pronunciation_tip=c.get("pronunciation_tip", ""),
            difficulty=int(c.get("difficulty", 3)),
        ))
    return out


def _salvage_truncated_chunk_array(raw: str) -> list[dict] | None:
    """When DeepSeek's JSON array is cut off mid-string by max_tokens, recover
    the chunks BEFORE the broken item. Strategy:
      1. Find the last `},` (end of a complete dict followed by separator).
      2. Replace everything after it with `]` to close the array.
      3. json.loads that.
    Returns the parsed list or None if salvage fails.
    """
    s = _strip_json(raw)
    # Need the array opener so we don't try to salvage non-array output.
    open_idx = s.find("[")
    if open_idx < 0:
        return None
    last_complete = s.rfind("},", open_idx)
    if last_complete < 0:
        return None
    candidate = s[: last_complete + 1] + "]"
    try:
        data = _json_loads(candidate)
        if isinstance(data, list):
            return data
    except Exception:
        return None
    return None


def extract_chunks(text_en: str, max_count: int = 12) -> list[dict]:
    """Extract chunks from a transcript.

    max_count caps the upper bound.  Defaults to 12 (the historical 8-12
    target for 2-3 min segment clips).  Chapters-mode imports pass 18 to get
    a denser harvest from the longer full-video transcript.  We scale the
    LLM token budget linearly with max_count so the response doesn't get
    truncated mid-string for the larger ask.
    """
    if has_credentials():
        min_count = max(6, int(max_count * 0.7))  # ~8 for default, ~13 for 18
        # Plain .replace() rather than str.format() because the schema
        # example inside _CHUNK_SYS has literal { / } braces that would
        # confuse the format parser ("unknown field name ...").
        sys = (
            _CHUNK_SYS
            .replace("__MIN_COUNT__", str(min_count))
            .replace("__MAX_COUNT__", str(max_count))
        )
        # 4000 tokens fits ~10-12 chunks; bump proportionally for larger asks
        # (chapters mode at 18 uses ~6000) so the salvage path stays rare.
        max_tokens = int(4000 * max_count / 12)
        raw = _chat(sys, f"Transcript:\n{text_en}", max_tokens=max_tokens, task="extract_chunks")
        if raw:
            try:
                data = _json_loads(_strip_json(raw))
                if isinstance(data, list):
                    return _normalize_chunks(data)
            except Exception as e:
                # Common case: DeepSeek hit the token cap mid-string. Try to
                # salvage the chunks completed before the cut so the user gets
                # 6-8 chunks instead of 0.
                salvaged = _salvage_truncated_chunk_array(raw)
                if salvaged:
                    log.warning(
                        "chunk JSON truncated (%s); salvaged %d complete chunks",
                        e, len(salvaged),
                    )
                    normalized = _normalize_chunks(salvaged)
                    if normalized:
                        return normalized
                log.warning("chunk parse failed: %s\nraw=%s", e, raw[:500])

    # Stub fallback — match canned phrases
    candidates = [
        ("end up doing", "idiomatic", "表示事情最后落成这个结果，带有'本来不打算但最终这样'的语气。",
         "讲事情没按计划、最终变成另一种结果。"),
        ("the way I see it", "functional", "委婉表达自己的观点，留出不同意的空间。", "给建议时。"),
        ("kind of like", "collocation", "打比方的口语填充，把陌生概念类比成熟悉的东西。", "解释新概念。"),
        ("keeps asking me", "discourse", "用 keeps 强调事情反复发生带来的无奈感。", "抱怨一个常见问题。"),
    ]
    out = []
    for text, ctype, why, scenario in candidates:
        if text.lower() in text_en.lower():
            out.append(
                dict(
                    text=text,
                    chunk_type=ctype,
                    why_explanation=why,
                    usage_scenario=scenario,
                    similar_expressions=[],
                    common_collocations=[],
                    pronunciation_tip="",
                    difficulty=3,
                )
            )
    return out


# ---------- helpers ----------
def _json_loads(s: str):
    """json.loads with `strict=False`.

    Reasoning models (deepseek-v4-flash in particular) regularly emit a raw
    newline inside a JSON string value — e.g. a multi-line
    `pronunciation_tip`. Strict JSON forbids unescaped control characters, so
    the default parser blows up with "Invalid control character at ..." and we
    throw away a perfectly good response. `strict=False` accepts them verbatim.
    """
    return json.loads(s, strict=False)


def _strip_json(s: str) -> str:
    """Strip ```json fences if the model wrapped its output."""
    s = s.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s.rsplit("```", 1)[0]
    return s.strip()
