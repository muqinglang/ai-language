import { useEffect, useRef, useState } from "react";
import { Eye, EyeSlash, Info, Microphone, Play, SpeakerHigh, Square, WarningCircle, X } from "@phosphor-icons/react";

// Module-level cache: decode the video audio ONCE per episode page.
// Keyed by video URL so re-navigating an episode reuses the buffer.
const videoBufferCache = new Map<string, AudioBuffer>();
let sharedCtx: AudioContext | null = null;

function getCtx() {
  if (!sharedCtx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new AC();
  }
  return sharedCtx;
}

async function decodeVideoBuffer(videoUrl: string): Promise<AudioBuffer> {
  const cached = videoBufferCache.get(videoUrl);
  if (cached) return cached;
  const res = await fetch(videoUrl);
  const ab = await res.arrayBuffer();
  const ctx = getCtx();
  const buf = await ctx.decodeAudioData(ab.slice(0));
  videoBufferCache.set(videoUrl, buf);
  return buf;
}

function sliceBuffer(buf: AudioBuffer, startMs: number, endMs: number): AudioBuffer {
  const ctx = getCtx();
  const sr = buf.sampleRate;
  const startSample = Math.max(0, Math.floor((startMs / 1000) * sr));
  const endSample = Math.min(buf.length, Math.floor((endMs / 1000) * sr));
  const len = Math.max(1, endSample - startSample);
  const out = ctx.createBuffer(buf.numberOfChannels, len, sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    out.getChannelData(ch).set(src.subarray(startSample, endSample));
  }
  return out;
}

function drawWaveform(canvas: HTMLCanvasElement, buf: AudioBuffer, color: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  ctx.fillStyle = color;
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    const base = x * step;
    const end = Math.min(data.length, base + step);
    for (let i = base; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - (max + 1) / 2) * h;
    const y2 = (1 - (min + 1) / 2) * h;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

// Minimal SpeechRecognition typing so we can parallel-run STT while
// MediaRecorder captures audio.  The browser exposes either SR or
// webkitSR (Chrome/Edge).  Safari <15 has neither → we hide the
// transcript panel gracefully.
type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function getRecorderSR(): (new () => SR) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function SentenceRecorder({
  videoUrl,
  startMs,
  endMs,
  text,
  textZh,
  onClose,
}: {
  videoUrl: string;
  startMs: number;
  endMs: number;
  text: string;
  textZh?: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "done" | "denied" | "loading">(
    "loading"
  );
  const [errorMsg, setErrorMsg] = useState("");
  const [recordSecs, setRecordSecs] = useState(0);
  const [waveformDecodeFailed, setWaveformDecodeFailed] = useState(false);
  const recordTimerRef = useRef<number | null>(null);
  const origCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const userCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const origBufRef = useRef<AudioBuffer | null>(null);
  const userBufRef = useRef<AudioBuffer | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SR | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const userUrlRef = useRef<string | null>(null);
  const [userUrl, setUserUrl] = useState<string | null>(null);
  const [origUrl, setOrigUrl] = useState<string | null>(null);
  // Live STT transcript of what the browser heard the learner say.
  // Seeing this next to the original is how they notice L/N, R/L slips.
  const [userTranscript, setUserTranscript] = useState("");
  // Default-HIDE the English original.  Forces the learner to listen
  // first; they can opt into revealing.  Preference persists.
  const [revealText, setRevealText] = useState(() => {
    try { return localStorage.getItem("shadow-reveal-text") === "1"; } catch { return false; }
  });
  const sttAvailable = getRecorderSR() != null;

  // Load original audio on mount — capped at 15s so a slow/stuck fetch
  // doesn't leave the user staring at the loading spinner forever.  On
  // timeout we still enter "idle" so recording is available; just no
  // original-audio waveform / playback.
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      if (alive && origBufRef.current == null) {
        setErrorMsg("原音加载超时，仍可录音对比识别结果");
        setPhase("idle");
      }
    }, 15000);
    (async () => {
      try {
        const full = await decodeVideoBuffer(videoUrl);
        if (!alive) return;
        const slice = sliceBuffer(full, startMs, endMs);
        origBufRef.current = slice;
        // encode slice to WAV blob for <audio> playback.  Setting origUrl
        // mounts the canvas section; the waveform draw happens in the
        // dedicated useEffect below, after the canvas exists in the DOM.
        const wavBlob = audioBufferToWav(slice);
        setOrigUrl(URL.createObjectURL(wavBlob));
        setPhase("idle");
      } catch (e) {
        setErrorMsg("无法加载原音频：" + (e as Error).message);
        setPhase("idle");
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [videoUrl, startMs, endMs]);

  // Draw the original waveform once the canvas has actually been mounted.
  // The buffer is decoded async; on first render origUrl is null, so the
  // canvas section isn't in the DOM yet and origCanvasRef is null.  Earlier
  // we tried to draw inline right after decode and silently no-op'd, which
  // is why the 原音 box rendered empty.  Drawing here, keyed on origUrl,
  // guarantees the canvas exists when we paint.
  useEffect(() => {
    if (origUrl && origBufRef.current && origCanvasRef.current) {
      drawWaveform(origCanvasRef.current, origBufRef.current, "#64748b");
    }
  }, [origUrl]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
      if (recordTimerRef.current) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      if (userUrlRef.current) URL.revokeObjectURL(userUrlRef.current);
    };
  }, []);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      setUserTranscript("");
      setRecordSecs(0);
      setWaveformDecodeFailed(false);
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        userUrlRef.current = url;
        setUserUrl(url);
        // Decode for waveform.  Safari often produces Opus-in-webm it
        // can't re-decode; in that case we gracefully skip the waveform
        // but keep the <audio> playback via the object URL.
        try {
          const ab = await blob.arrayBuffer();
          const buf = await getCtx().decodeAudioData(ab);
          userBufRef.current = buf;
          if (userCanvasRef.current) {
            drawWaveform(userCanvasRef.current, buf, "#f97316");
          }
        } catch {
          setWaveformDecodeFailed(true);
        }
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setPhase("done");
      };
      mediaRecorderRef.current = mr;
      mr.start();
      // Tick a 1s counter for the recording-time indicator.  Stopped
      // inside mr.onstop above.
      recordTimerRef.current = window.setInterval(() => {
        setRecordSecs((s) => s + 1);
      }, 1000);

      // Parallel STT on the same mic so the learner can see what the
      // browser heard — revealing L/N / R/L / V/W pronunciation slips
      // they can't catch by ear.  Graceful no-op on Safari < 15.
      const SRCtor = getRecorderSR();
      if (SRCtor) {
        const rec = new SRCtor();
        rec.lang = "en-US";
        rec.continuous = true;
        rec.interimResults = true;
        let finalText = "";
        rec.onresult = (e) => {
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            const piece = r[0].transcript;
            if (r.isFinal) finalText += piece;
            else interim += piece;
          }
          setUserTranscript((finalText + interim).trim());
        };
        rec.onerror = () => { /* ignore; transcript just stays blank */ };
        rec.onend = () => { recognitionRef.current = null; };
        try {
          rec.start();
          recognitionRef.current = rec;
        } catch {
          // Already started / not allowed — fall through silently.
        }
      }

      setPhase("recording");
    } catch {
      setPhase("denied");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* already stopped */ }
      recognitionRef.current = null;
    }
  }

  function toggleReveal() {
    const next = !revealText;
    setRevealText(next);
    try {
      if (next) localStorage.setItem("shadow-reveal-text", "1");
      else localStorage.removeItem("shadow-reveal-text");
    } catch { /* private mode */ }
  }

  const diffTokens = buildDiffTokens(text, userTranscript);

  return (
    <div
      className="fixed inset-0 bg-ink/35 backdrop-blur-[2px] z-50 grid place-items-center p-4 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-[#fafcfa] border border-[#dcebe1] shadow-xl shadow-[#00000014] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — warm bar with title + show/hide + close */}
        <div className="px-5 pt-4 pb-3 flex items-start gap-3 border-b border-[#dcebe1] bg-gradient-to-b from-[#f4f9f6] to-[#fafcfa]">
          <div className="flex-1 min-w-0">
            <div className="text-2xs uppercase tracking-[0.14em] text-ink-3 font-semibold mb-1">
              跟读练习
            </div>
            {revealText ? (
              <>
                <div className="text-base text-ink leading-[1.5]">{text}</div>
                {textZh && (
                  <div className="text-xs text-ink-3 leading-[1.5] mt-0.5">{textZh}</div>
                )}
              </>
            ) : (
              <div className="inline-flex items-center gap-1.5 text-sm text-ink-2">
                <SpeakerHigh size={14} className="text-ink-3" />
                先靠听原音再跟读 · 录完对照识别结果
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0 -mr-1 -mt-0.5">
            <button
              onClick={toggleReveal}
              className="w-8 h-8 grid place-items-center rounded-lg text-ink-3 hover:bg-white hover:text-ink transition-colors duration-150 ease-spring"
              title={revealText ? "隐藏原文" : "显示原文"}
            >
              {revealText ? <EyeSlash size={15} /> : <Eye size={15} />}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 grid place-items-center rounded-lg text-ink-3 hover:bg-white hover:text-ink transition-colors duration-150 ease-spring"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3.5">
          {errorMsg && (
            <div className="inline-flex items-start gap-1.5 text-xs text-[#285e48] bg-[#f0f6f2] border border-[#c9dfd0] rounded-lg px-2.5 py-2">
              <Info size={13} className="shrink-0 mt-px" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Original waveform */}
          {origUrl && (
            <section>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-2xs uppercase tracking-[0.12em] text-ink-3 font-semibold">原音</span>
                <button
                  onClick={() => {
                    const a = new Audio(origUrl);
                    a.play();
                  }}
                  className="inline-flex items-center gap-1 text-2xs text-brand hover:underline"
                >
                  <Play size={11} weight="fill" /> 播放
                </button>
              </div>
              <canvas
                ref={origCanvasRef}
                width={480}
                height={48}
                className="w-full h-12 bg-[#f8f4ee] rounded-lg"
              />
            </section>
          )}

          {/* User recording waveform (when available) */}
          {(phase === "done" || phase === "recording") && (
            <section>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-2xs uppercase tracking-[0.12em] text-ink-3 font-semibold">你的录音</span>
                {userUrl && (
                  <button
                    onClick={() => {
                      const a = new Audio(userUrl);
                      a.play();
                    }}
                    className="inline-flex items-center gap-1 text-2xs text-brand hover:underline"
                  >
                    <Play size={11} weight="fill" /> 播放
                  </button>
                )}
              </div>
              {waveformDecodeFailed ? (
                <div className="text-2xs text-ink-3 italic px-2 py-3 bg-[#f8f4ee] rounded-lg text-center">
                  此浏览器不支持波形渲染，录音仍可播放
                </div>
              ) : (
                <canvas
                  ref={userCanvasRef}
                  width={480}
                  height={48}
                  className="w-full h-12 bg-[#eef5f0] rounded-lg"
                />
              )}
            </section>
          )}

          {/* Live STT transcript with word-level diff against the original.
              Words the learner pronounced differently from the script are
              shown with a red underline so pronunciation slips stand out. */}
          {(phase === "recording" || userTranscript) && sttAvailable && (
            <section>
              <div className="text-2xs uppercase tracking-[0.12em] text-ink-3 font-semibold mb-1.5">
                识别结果{phase === "recording" && <span className="normal-case tracking-normal ml-1 text-brand font-semibold">· 实时</span>}
              </div>
              <div className="text-sm text-ink leading-[1.55] min-h-[1.8rem] bg-white border border-[#dcebe1] rounded-lg px-3 py-2">
                {userTranscript ? (
                  diffTokens.map((t, i) => (
                    <span
                      key={i}
                      className={
                        t.diff
                          ? "underline decoration-red-500 decoration-[1.5px] underline-offset-2"
                          : ""
                      }
                    >
                      {t.text}
                      {i < diffTokens.length - 1 ? " " : ""}
                    </span>
                  ))
                ) : (
                  <span className="text-ink-3 italic">（说话后识别会出现在这里…）</span>
                )}
              </div>
            </section>
          )}
          {!sttAvailable && phase === "done" && (
            <div className="text-2xs text-ink-3 italic">
              当前浏览器不支持实时识别（建议 Chrome / Edge）
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 pb-5 pt-1 flex items-center gap-2">
          {phase === "loading" && (
            <button
              disabled
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 rounded-xl bg-ink/10 text-ink-3 cursor-wait"
            >
              加载原音…
            </button>
          )}
          {phase === "idle" && (
            <button
              onClick={startRecording}
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand/90 transition-colors duration-150 ease-spring"
            >
              <Microphone size={15} weight="bold" /> 开始录音
            </button>
          )}
          {phase === "recording" && (
            <button
              onClick={stopRecording}
              className="flex-1 inline-flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-xl bg-red-500 text-white animate-pulse"
            >
              <Square size={12} weight="fill" />
              <span>停止 · {String(Math.floor(recordSecs / 60)).padStart(2, "0")}:{String(recordSecs % 60).padStart(2, "0")}</span>
            </button>
          )}
          {phase === "done" && (
            <button
              onClick={startRecording}
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand/90 transition-colors duration-150 ease-spring"
            >
              <Microphone size={15} weight="bold" /> 再录一次
            </button>
          )}
          {phase === "denied" && (
            <div className="flex-1 inline-flex items-start gap-1.5 text-xs text-[#285e48] bg-[#f0f6f2] border border-[#c9dfd0] rounded-xl px-3 py-2.5">
              <WarningCircle size={14} className="shrink-0 mt-px" />
              <span>
                麦克风被拒绝。点地址栏的🔒图标 → 麦克风 → 允许，然后刷新。
              </span>
            </div>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl text-sm text-ink-2 hover:bg-[#f0f3f0]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// Case/punctuation-insensitive token compare — flags any word the STT
// heard that doesn't appear at the same position in the expected text.
// Dumb positional diff is good enough for single-sentence shadow
// reading; fancier Levenshtein alignment isn't worth the complexity.
function buildDiffTokens(expected: string, spoken: string): { text: string; diff: boolean }[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z']+/g, "");
  const exp = expected.trim().split(/\s+/).map(norm).filter(Boolean);
  const got = spoken.trim().split(/\s+/);
  return got.map((w, i) => ({
    text: w,
    diff: exp[i] != null && exp[i] !== norm(w),
  }));
}

// Minimal AudioBuffer → 16-bit PCM WAV converter. Lets us play the sliced
// segment via <audio> without rebuilding the video element.
function audioBufferToWav(buf: AudioBuffer): Blob {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const samples = buf.length;
  const bytesPerSample = 2;
  const dataSize = samples * numCh * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * bytesPerSample, true);
  view.setUint16(32, numCh * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}
