/**
 * 朗读 —— 全站唯一的出声入口。
 *
 * 原本这套机器长在 Learn.tsx 里，于是 Library / Words 各自写了一份
 * `new SpeechSynthesisUtterance(...)`，绕过了学员配的声音。现在提到这里，
 * 谁要出声都从这儿走。
 *
 * 路由：`/api/tts`（学员自己的 CosyVoice → 平台 ElevenLabs → 503）
 * → 503/402 就降级到浏览器的 Web Speech。降级不是故障，见 docs/AI_CHAT.md。
 */
import { getPreferredVoiceId } from "@/lib/voices";

// Picking a good en-US voice makes the biggest perceptual difference —
// browsers default to whatever the OS ships, which on macOS is often a
// 2000s-era robotic voice like Alex.  Walk the list and prefer neural
// voices that have "Natural" in the name (Microsoft Edge) or the word
// "Google" (Chrome's WaveNet-backed voices).
const VOICE_NAME_PRIORITY = [
  /Google US English/i,
  /Google UK English Female/i,
  /Google UK English Male/i,
  /Microsoft.*Jenny.*Natural/i,
  /Microsoft.*Aria.*Natural/i,
  /Microsoft.*Guy.*Natural/i,
  /Samantha/i,      // macOS — not great but better than Alex
  /Karen/i,         // macOS/AUS — decent
];

let _cachedVoice: SpeechSynthesisVoice | null = null;
function pickBestVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  if (_cachedVoice) return _cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null; // not loaded yet — caller retries later
  for (const rx of VOICE_NAME_PRIORITY) {
    const hit = voices.find((v) => v.lang.toLowerCase().startsWith("en") && rx.test(v.name));
    if (hit) {
      _cachedVoice = hit;
      return hit;
    }
  }
  const anyEn = voices.find((v) => v.lang.toLowerCase().startsWith("en")) ?? voices[0];
  _cachedVoice = anyEn ?? null;
  return _cachedVoice;
}

// Preload voices at module load time.  getVoices() is often empty on
// first call; the voiceschanged event fires once the UA has them ready.
if (typeof window !== "undefined" && window.speechSynthesis) {
  const onVoices = () => {
    _cachedVoice = null; // let pickBestVoice recompute
    pickBestVoice();
  };
  window.speechSynthesis.onvoiceschanged = onVoices;
  pickBestVoice();
}

// Keep the currently-playing ElevenLabs audio element reachable so the
// next speakText() call can stop it first — prevents overlapping
// playbacks when the user clicks 朗读 rapidly.
let _activeAudio: HTMLAudioElement | null = null;
// AbortController for the in-flight /api/tts fetch.  Without this, a
// click on 慢读 while 朗读's fetch was still buffering would resolve
// both fetches in parallel and play two overlapping audios — only the
// second's element ends up in _activeAudio, the first leaks.  We also
// bump _speakGen so any audio whose play() is triggered after a newer
// call started gets discarded instead of joining the chorus.
let _activeAbort: AbortController | null = null;
let _speakGen = 0;

// Sticky session flag: once /api/tts returns 503 (TTS_DISABLED=true on
// k8s / no ElevenLabs key), remember it and skip the fetch on subsequent
// calls. Critical on iOS Safari — speechSynthesis.speak() requires a
// live user-gesture context, and routing through fetch().catch() breaks
// that context (async Promise microtask != user activation). Going
// directly to Web Speech inside the click handler keeps the gesture.
let _ttsServerDisabled = false;

// 学员是否配了自己的朗读声音（MiniMax / CosyVoice）。配了就**不**降级到
// 浏览器系统音 —— 那是 TA 特意花 key 换掉的声音，某一行临时失败时用机器音
// 顶替，只会让人以为音色被偷偷改了。失败原因后端已写进 tts_last_error，
// 设置页可见，所以宁可这一行不出声也不是静默降级。
//
// 来源有两个，互补：
//   1. 设置页加载到 tts_configured 时写进 localStorage（跨会话保留，覆盖
//      "fetch 直接网络失败、拿不到响应头"的情况）；
//   2. 后端在 BYOK 失败的 502 上带 X-TTS-Byok-Failed 头，运行时确认。
let _ownVoiceConfigured = false;
try {
  _ownVoiceConfigured =
    typeof localStorage !== "undefined" &&
    localStorage.getItem("justspeak_tts_byok") === "1";
} catch { /* ignore */ }

/** 设置页在读到 tts_configured 后调用，让出声逻辑知道该不该用系统音兜底。 */
export function setOwnVoiceConfigured(v: boolean) {
  _ownVoiceConfigured = v;
  try { localStorage.setItem("justspeak_tts_byok", v ? "1" : "0"); } catch { /* ignore */ }
}

/** 朗读失败时的兜底：没配自己声音 → 浏览器系统音念；配了 → 不顶替，
 *  收掉 UI 的"朗读中"状态并广播事件，方便上层提示"朗读失败"。 */
function _fallbackOrSilence(text: string, opts?: { rate?: number; onEnd?: () => void }) {
  if (_ownVoiceConfigured) {
    try { window.dispatchEvent(new CustomEvent("justspeak:tts-failed")); } catch { /* ignore */ }
    opts?.onEnd?.();
    return;
  }
  _speakWebSpeech(text, opts);
}

// iOS Safari requires at least one speak() call from a user gesture
// before it will play anything programmatically later. primeWebSpeech()
// fires a zero-volume empty utterance the first time the user interacts,
// unlocking subsequent calls (including auto-speak from effects).
let _webSpeechPrimed = false;
export function primeWebSpeech() {
  if (_webSpeechPrimed) return;
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  _webSpeechPrimed = true;
  try {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch { /* ignore — prime is best-effort */ }
}

// iOS Safari problem: ElevenLabs audio plays through `new Audio(blobUrl).play()`,
// but that .play() call sits inside `fetch().then()` — by the time the
// promise resolves, the user-gesture context is gone and iOS rejects the
// play(), firing `audio.onerror` which then falls back to Web Speech.
// Net effect: user picks Matilda in Me page, still hears the iOS default
// SpeechSynthesis voice on iPhone.
//
// Fix: keep one HTMLAudioElement around, prime it with a 1-frame silent
// MP3 inside the first user gesture (interact()).  Once that .play() has
// resolved at least once in gesture-context, iOS treats the element as
// unlocked and subsequent .play() calls work even from async chains.
// We then reuse that same element for every speakText() call.
let _primedAudio: HTMLAudioElement | null = null;
let _audioPrimed = false;
// 1x1 frame silent MP3 (88 bytes base64) — small enough to inline; just
// needs to be a valid audio buffer iOS will accept for the unlock play().
const _SILENT_MP3 =
  "data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID///////////////////////////////////////////8AAAA5TEFNRTMuMTAwAaUAAAAAAAAAABRAJAJAQgAAQAAAAnGzn3kRAAAAAAAAAAAAAAAAAAAA";
export function primeAudio() {
  if (_audioPrimed) return;
  if (typeof window === "undefined") return;
  try {
    const a = new Audio(_SILENT_MP3);
    a.preload = "auto";
    // Calling play() inside the user-gesture is the magic step.  We
    // don't care if the silent track plays through — we just need iOS
    // to register the element as gesture-unlocked.
    const p = a.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        a.pause();
        a.currentTime = 0;
        _audioPrimed = true;
      }).catch(() => { /* outside gesture or older iOS — best effort */ });
    } else {
      _audioPrimed = true;
    }
    _primedAudio = a;
  } catch { /* ignore */ }
}

/** 摘掉一个 audio 元素上的所有回调。
 *
 *  必须在动 src 之前摘 —— 把 src 设成空串会让浏览器走一遍 media load
 *  算法，拿不到源就异步 fire 一个 error。而 onerror 里写着"降级到浏览器
 *  朗读"，于是每次打断都会莫名其妙冒出一句机器音念上一段文本。
 *  这就是"自己的 key 念完一遍、浏览器又念一遍"的来源。 */
function _detach(a: HTMLAudioElement) {
  a.onended = null;
  a.onerror = null;
  a.onplaying = null;
}

function _stopActiveAudio() {
  if (_activeAudio) {
    const a = _activeAudio;
    _activeAudio = null;
    try {
      _detach(a);
      a.pause();
      // 共用的是同一个 iOS 已解锁的元素，所以只能清空、不能丢掉。
      a.removeAttribute("src");
      a.load();
    } catch { /* ignore */ }
  }
}

function _speakWebSpeech(text: string, opts?: { rate?: number; onEnd?: () => void }) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = opts?.rate ?? 0.95;
  const voice = pickBestVoice();
  if (voice) u.voice = voice;
  if (opts?.onEnd) u.onend = opts.onEnd;
  window.speechSynthesis.speak(u);
}

/**
 * Public hard-stop for any speakText() in flight or playing.
 *
 * Three things can be making sound or about to make sound:
 *   1. An <audio> element loaded with ElevenLabs mp3 (`_activeAudio`)
 *   2. An in-flight `/api/tts` fetch (`_activeAbort`)
 *   3. A SpeechSynthesisUtterance queued in the browser
 *
 * speakText() already does (1) + (2) + (3) at its own start, so the
 * audio you just kicked off doesn't pile on top of the previous one.
 * stopSpeaking() exposes that same teardown for *non-speak* events
 * that should also silence audio: send / redo / reset / mic start /
 * tab change / video play.  Without it, AI is still finishing its
 * last reply when the user moves on, and you get two voices at once.
 */
export function stopSpeaking() {
  if (typeof window === "undefined") return;
  _stopActiveAudio();
  if (_activeAbort) {
    try { _activeAbort.abort(); } catch { /* ignore */ }
    _activeAbort = null;
  }
  // Bump generation so any fetch resolving after this call discards
  // its audio in the speakText then-handler.
  _speakGen++;
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

// Public API: speak text via ElevenLabs (backend proxy) with a
// transparent fallback to Web Speech.  Playback is always through an
// <audio> element when the backend returns mp3; rate is applied via
// audio.playbackRate so the 🐢 slow-read button still works.  If the
// backend returns 503 (no key) or any error, we fall through to
// SpeechSynthesis — all existing features keep working exactly as
// before.  WordPopup intentionally does NOT use this; it has its own
// cheap Web-Speech path for single-word clicks.
export function speakText(
  text: string,
  opts?: { rate?: number; onEnd?: () => void },
) {
  if (typeof window === "undefined") return;
  // Stop anything currently playing AND abort any in-flight fetch from
  // a prior speakText() call.  Without aborting the fetch, a click on
  // 慢读 while 朗读's fetch is still buffering would let both audios
  // play simultaneously when their fetches resolve.
  _stopActiveAudio();
  if (_activeAbort) {
    try { _activeAbort.abort(); } catch { /* ignore */ }
    _activeAbort = null;
  }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  if (!text.trim()) return;

  // 只在"已知后端没有可用声音"时直奔 Web Speech：在 iOS 上走一遍
  // fetch().catch() 会丢掉用户手势上下文，之后连 Web Speech 都发不出声。
  //
  // 这里曾经还有一个 webSpeechOnly 逃生舱，单词点击走它，理由是"高频、
  // 单词朗读用不上高音质、ElevenLabs 太贵"。前两条是借口，第三条是真的
  // —— 但那是平台在付钱的年代。现在朗读花的是学员自己配的 CosyVoice
  // 额度，是 TA 特意配来换个好听声音的，没有理由在单词上偷偷降级成机器音。
  if (_ttsServerDisabled) {
    _fallbackOrSilence(text, opts);
    return;
  }

  const token = localStorage.getItem("justspeak_token") || "";
  const rate = opts?.rate ?? 0.95;
  const ctrl = new AbortController();
  _activeAbort = ctrl;
  // 这一次到底出没出声。出过声就绝不再降级 —— 补读只会把同一句话
  // 用另一个声音再念一遍。
  let heard = false;
  // Capture the generation at call time so a fetch that resolves *after*
  // a newer speakText() call started can discard its audio.
  const myGen = ++_speakGen;

  fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text, voice_id: getPreferredVoiceId() }),
    signal: ctrl.signal,
  })
    .then(async (r) => {
      if (r.status === 502 && r.headers.get("X-TTS-Byok-Failed") === "1") {
        // 后端确认：挂掉的是学员自己配的声音（MiniMax/CosyVoice），不是
        // "没配声音"。记下来 —— 即便 localStorage 那边没标记，这次也不会
        // 拿浏览器系统音顶替。降级判断见 _fallbackOrSilence。
        setOwnVoiceConfigured(true);
        throw new Error("tts 502 byok");
      }
      if (r.status === 503 || r.status === 402) {
        // 503: server not configured. 402: ElevenLabs quota exhausted /
        // rate-limited / key invalid (backend cooldown). Either way,
        // don't try again this session — go directly to Web Speech to
        // preserve iOS user-gesture context on subsequent clicks.
        //
        // 走到这个分支 = 请求没进 BYOK 声音分支 = 学员没有自己的声音。
        // 清掉可能过期的 _ownVoiceConfigured（比如在别的设备删了声音），
        // 让系统音兜底重新生效，不至于既没自己的声音又静音。
        setOwnVoiceConfigured(false);
        _ttsServerDisabled = true;
        throw new Error(`tts ${r.status}`);
      }
      if (!r.ok) throw new Error(`tts ${r.status}`);
      // If a newer speakText() call has started, discard this response.
      if (myGen !== _speakGen) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      // Reuse the gesture-primed audio element when it exists — that
      // element is iOS-unlocked, so .play() works even from this async
      // chain.  Fresh `new Audio()` would be locked again on iOS.
      const audio = _primedAudio ?? new Audio();
      audio.src = url;
      audio.playbackRate = rate;
      _activeAudio = audio;
      audio.onplaying = () => { heard = true; };
      audio.onended = () => {
        _detach(audio);
        URL.revokeObjectURL(url);
        if (_activeAudio === audio) _activeAudio = null;
        opts?.onEnd?.();
      };
      audio.onerror = () => {
        _detach(audio);
        URL.revokeObjectURL(url);
        if (_activeAudio === audio) _activeAudio = null;
        // 已经出过声，或者已经有更新的一次朗读接手了 —— 都不补读。
        if (heard || myGen !== _speakGen) return;
        _fallbackOrSilence(text, opts);
      };
      await audio.play();
    })
    .catch((e) => {
      // AbortError is the expected signal that a newer call superseded
      // us — quietly drop, do NOT fall back to Web Speech (the new call
      // is already speaking).
      if ((e as { name?: string })?.name === "AbortError") return;
      if (myGen !== _speakGen) return;
      // 声音已经放出去了，失败的只是 play() 的收尾，不需要再念一遍。
      if (heard) return;
      // Backend unavailable / key unset / network error → Web Speech,
      // 但配了自己声音的学员不降级系统音（见 _fallbackOrSilence）。
      // Note: on iOS, if this is the FIRST call of the session, the user
      // gesture has already been lost by the time we hit this catch and
      // iOS will silently ignore speechSynthesis.speak(). That's why we
      // cache _ttsServerDisabled above — subsequent calls go direct.
      _fallbackOrSilence(text, opts);
    });
}
