import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, CircleNotch, Eye, EyeSlash, Microphone, Sparkle, Square } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import type { VjsPlayerHandle } from "@/components/VjsPlayer";

// Browser SpeechRecognition — Web Speech API has two names depending
// on browser. We use continuous + interim for live transcript; iOS
// Safari drops the session at ~60s so we restart it on `onend` while
// still recording.
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

function getSR(): (new () => SR) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

type Phase = "idle" | "countdown" | "recording" | "done" | "denied";

type EvalResult = {
  score: number;
  summary_zh: string;
  fluency_zh: string;
  accuracy_zh: string;
  chunk_zh: string;
  next_step_zh: string;
};

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function FullVideoRecorder({
  episodeId,
  videoDurationSec,
  chunks,
  playerRef,
}: {
  episodeId: number;
  videoDurationSec: number;
  chunks: { id: number; text: string }[];
  playerRef: React.MutableRefObject<VjsPlayerHandle | null>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [countdown, setCountdown] = useState(3);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [revealSubs, setRevealSubs] = useState(false);
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SR | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  const finalRef = useRef("");
  const audioUrlRef = useRef<string | null>(null);

  const hasSR = getSR() != null;

  // Cleanup on unmount: stop streams, revoke object URLs.
  useEffect(() => {
    return () => {
      stoppingRef.current = true;
      try { recognitionRef.current?.abort(); } catch { /* ignore */ }
      try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (tickRef.current) window.clearInterval(tickRef.current);
      if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  // Listen to the underlying <video> element's `ended` event so we
  // auto-stop recording when the clip naturally finishes. We grab the
  // element on demand because video.js may swap it in/out.
  useEffect(() => {
    if (phase !== "recording") return;
    const vid = document.querySelector("video");
    if (!vid) return;
    const onEnded = () => stopRecording();
    vid.addEventListener("ended", onEnded);
    return () => vid.removeEventListener("ended", onEnded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function startCountdown() {
    setEvalResult(null);
    setEvalError("");
    setFinalTranscript("");
    setInterimTranscript("");
    finalRef.current = "";
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setAudioUrl(null);
    setElapsedMs(0);
    setCountdown(3);
    setPhase("countdown");
    let n = 3;
    countdownTimerRef.current = window.setInterval(() => {
      n -= 1;
      if (n <= 0) {
        if (countdownTimerRef.current) {
          window.clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
        beginRecording();
      } else {
        setCountdown(n);
      }
    }, 1000);
  }

  async function beginRecording() {
    setErrorMsg("");
    stoppingRef.current = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("mic denied", err);
      setPhase("denied");
      setErrorMsg("无法获取麦克风权限。请在浏览器地址栏的权限设置里允许后重试。");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];

    const preferred = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    let mimeType: string | undefined;
    for (const m of preferred) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
        mimeType = m;
        break;
      }
    }
    const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      setAudioUrl(url);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    mediaRecorderRef.current = mr;

    // Start Web Speech in parallel for live transcript.
    const SRCtor = getSR();
    if (SRCtor) {
      const r = new SRCtor();
      r.lang = "en-US";
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i] as ArrayLike<{ transcript: string }> & { isFinal: boolean };
          const txt = res[0]?.transcript ?? "";
          if (res.isFinal) {
            finalRef.current = (finalRef.current + " " + txt).trim();
          } else {
            interim += txt;
          }
        }
        setFinalTranscript(finalRef.current);
        setInterimTranscript(interim);
      };
      r.onerror = (e) => {
        console.warn("SR error", e.error);
      };
      r.onend = () => {
        // iOS Safari ends the session every ~60s. While we're still
        // recording, restart it so the transcript keeps accumulating.
        if (!stoppingRef.current) {
          try { r.start(); } catch { /* ignore restart races */ }
        }
      };
      try { r.start(); } catch { /* ignore */ }
      recognitionRef.current = r;
    }

    // Drive the main video from 0.
    try {
      playerRef.current?.seek(0);
      playerRef.current?.play();
    } catch { /* ignore */ }

    mr.start(250);
    startedAtRef.current = performance.now();
    tickRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current);
    }, 200);
    setPhase("recording");
  }

  function stopRecording() {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
    try { playerRef.current?.pause(); } catch { /* ignore */ }
    setElapsedMs((ms) => ms || (performance.now() - startedAtRef.current));
    setInterimTranscript("");
    setPhase("done");
  }

  function reset() {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setAudioUrl(null);
    setFinalTranscript("");
    setInterimTranscript("");
    finalRef.current = "";
    setEvalResult(null);
    setEvalError("");
    setElapsedMs(0);
    setPhase("idle");
  }

  // ----- Stats computed at "done" -----
  const transcriptLower = finalTranscript.toLowerCase();
  const wordCount = finalTranscript.trim() ? finalTranscript.trim().split(/\s+/).length : 0;
  const durationSec = Math.max(1, Math.round(elapsedMs / 1000));
  const wpm = Math.round((wordCount / durationSec) * 60);
  const chunksHit = chunks.filter((c) => transcriptLower.includes(c.text.toLowerCase()));
  const chunksMissed = chunks.filter((c) => !transcriptLower.includes(c.text.toLowerCase()));

  async function runEval() {
    setEvalLoading(true);
    setEvalError("");
    try {
      const r = await api.evalFullRecord(episodeId, {
        transcript: finalTranscript,
        duration_sec: durationSec,
        wpm,
        chunks_hit: chunksHit.map((c) => c.text),
        chunks_missed: chunksMissed.map((c) => c.text),
      });
      setEvalResult(r);
    } catch (err) {
      console.warn("eval failed", err);
      setEvalError("AI 点评暂时不可用，稍后再试。");
    } finally {
      setEvalLoading(false);
    }
  }

  return (
    <div className="card p-3 md:p-4 mt-2">
      {phase === "idle" && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
              <Microphone size={14} weight="bold" className="text-[#285e48]" />
              录制全片 · Shadowing 模式
            </div>
            <div className="text-2xs text-ink-3 mt-0.5">
              视频会从 0 秒重播 · 全程跟读 · 字幕默认隐藏
            </div>
          </div>
          <button
            onClick={startCountdown}
            disabled={!hasSR}
            className="btn-primary text-sm shrink-0 inline-flex items-center gap-1.5"
            title={hasSR ? "" : "你的浏览器不支持语音识别，建议用 Chrome / Edge"}
          >
            <Microphone size={14} weight="bold" />
            开始录制 ({fmtMs(videoDurationSec * 1000)})
          </button>
        </div>
      )}

      {phase === "countdown" && (
        <div className="text-center py-6">
          <div className="text-5xl font-bold text-[#285e48] tabular-nums">{countdown}</div>
          <div className="text-xs text-ink-3 mt-2">准备好，深呼吸…</div>
        </div>
      )}

      {phase === "recording" && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-600">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              录制中 · {fmtMs(elapsedMs)} / {fmtMs(videoDurationSec * 1000)}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRevealSubs((v) => !v)}
                className="text-2xs text-ink-2 hover:text-ink inline-flex items-center gap-1"
                title={revealSubs ? "隐藏字幕（推荐）" : "显示字幕"}
              >
                {revealSubs ? <Eye size={13} /> : <EyeSlash size={13} />}
                {revealSubs ? "隐藏字幕" : "显示字幕"}
              </button>
              <button
                onClick={stopRecording}
                className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-semibold inline-flex items-center gap-1 hover:bg-red-600"
              >
                <Square size={12} weight="bold" />
                停止
              </button>
            </div>
          </div>
          {(finalTranscript || interimTranscript) && (
            <div className="text-xs text-ink-2 leading-[1.55] bg-ink-1/5 rounded-lg px-2.5 py-2 max-h-24 overflow-y-auto">
              <span>{finalTranscript}</span>
              {interimTranscript && (
                <span className="text-ink-3"> {interimTranscript}</span>
              )}
            </div>
          )}
          {!hasSR && (
            <div className="text-2xs text-ink-3">
              ⚠️ 当前浏览器不识别语音，仅录音。建议下次用 Chrome / Edge / Safari。
            </div>
          )}
        </div>
      )}

      {phase === "denied" && (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-red-600">{errorMsg}</div>
          <button
            onClick={() => setPhase("idle")}
            className="text-xs text-brand hover:underline self-start"
          >
            返回
          </button>
        </div>
      )}

      {phase === "done" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
            <span>用时 <strong className="text-ink">{fmtMs(elapsedMs)}</strong></span>
            <span>{wordCount} 词</span>
            <span>{wpm} wpm</span>
            <span>命中 chunks <strong className="text-ink">{chunksHit.length} / {chunks.length}</strong></span>
          </div>

          {audioUrl && (
            <audio controls src={audioUrl} className="w-full h-9" />
          )}

          {finalTranscript ? (
            <div>
              <div className="text-2xs text-ink-3 mb-1">你说的</div>
              <div className="text-xs text-ink leading-[1.6] bg-white border border-line rounded-lg px-3 py-2 max-h-40 overflow-y-auto whitespace-pre-wrap">
                {finalTranscript}
              </div>
            </div>
          ) : (
            <div className="text-2xs text-ink-3">没有识别到语音内容。</div>
          )}

          {chunks.length > 0 && (
            <div>
              <div className="text-2xs text-ink-3 mb-1">本集 chunks</div>
              <div className="flex flex-wrap gap-1.5">
                {chunks.map((c) => {
                  const hit = transcriptLower.includes(c.text.toLowerCase());
                  return (
                    <span
                      key={c.id}
                      className={`text-2xs px-2 py-0.5 rounded-full border ${
                        hit
                          ? "bg-green-50 border-green-200 text-green-700"
                          : "bg-red-50 border-red-200 text-red-700"
                      }`}
                    >
                      {hit ? "✓" : "✕"} {c.text}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={runEval}
              disabled={evalLoading || !finalTranscript}
              className="btn-primary text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {evalLoading ? (
                <CircleNotch size={13} weight="bold" className="animate-spin" />
              ) : (
                <Sparkle size={13} weight="bold" />
              )}
              {evalLoading ? "AI 点评中…" : evalResult ? "重新点评" : "AI 点评"}
            </button>
            <button
              onClick={reset}
              className="text-xs px-3 py-1.5 rounded-lg border border-line bg-white hover:bg-ink-1/5 inline-flex items-center gap-1.5"
            >
              <ArrowCounterClockwise size={12} weight="bold" />
              重录
            </button>
          </div>

          {evalError && <div className="text-xs text-red-600">{evalError}</div>}

          {evalResult && (
            <div className="card p-3 bg-[#f4f9f6] border-[#cfe3d6] flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-[#285e48]">{evalResult.score}</span>
                <span className="text-2xs text-ink-3">/ 10</span>
                <span className="text-xs text-ink ml-1">{evalResult.summary_zh}</span>
              </div>
              <div className="flex flex-col gap-1 text-xs leading-[1.55] text-ink-2">
                {evalResult.fluency_zh && <p><strong className="text-ink">流利度：</strong>{evalResult.fluency_zh}</p>}
                {evalResult.accuracy_zh && <p><strong className="text-ink">准确度：</strong>{evalResult.accuracy_zh}</p>}
                {evalResult.chunk_zh && <p><strong className="text-ink">Chunk 利用：</strong>{evalResult.chunk_zh}</p>}
                {evalResult.next_step_zh && (
                  <p className="text-[#285e48] font-medium">下一步：{evalResult.next_step_zh}</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
