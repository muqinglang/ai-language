import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUUpLeft, ArrowsClockwise, BookOpen, BookmarkSimple, CaretDown, CaretLeft, CaretRight, ChatText, Check, Clock, Confetti, Copy, Eye, EyeSlash, FilmStrip, Gauge, GraduationCap, Highlighter, Info, Key, Lightbulb, MagnifyingGlass, Microphone, NotePencil, PaperPlaneTilt, Pencil, Play, Playlist, Plus, Question, Repeat, Robot, Scissors, Sparkle, SpeakerHigh, Square, Star, Translate, WarningCircle, Wrench, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { DifficultyBar } from "@/components/EpisodeCard";
import { SentenceRecorder } from "@/components/SentenceRecorder";
import { HowToModal } from "@/components/HowToModal";
import { TOPIC_META } from "@/lib/topicMeta";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { getPreferredVoiceId, getVoiceById, getVoiceInitials } from "@/lib/voices";
import { VjsPlayer, type VjsPlayerHandle } from "@/components/VjsPlayer";
import { primeAudio, primeWebSpeech, speakText, stopSpeaking } from "@/lib/speak";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadingCritter } from "@/components/LoadingCritter";
import { NeedApiKey } from "@/components/NeedApiKey";
import { DictationRow } from "@/components/DictationRow";
import {
  api,
  currentUser,
  errorDetail,
  isByokRequired,
  type AISegment,
  type Chunk,
  type Conversation,
  type LessonBrief,
  type Note,
  type Subtitle,
  type Vocabulary,
} from "@/lib/api";

/** 学员触发的模型调用失败时的两种结局：428 是少了一步设置（给入口），
 *  其余才是真出错（显示后端带回来的原因）。分开是因为红色报错框会让人
 *  以为功能坏了，而它只是需要一个 key。 */
function LlmCallError({ error, fallback }: { error: unknown; fallback: string }) {
  if (isByokRequired(error)) return <NeedApiKey message={error.message} />;
  return (
    <div className="text-sm text-red-600">
      {error instanceof Error && error.message ? error.message : fallback}
    </div>
  );
}

type Mode = "en" | "bi" | "zh" | "cloze" | "reading" | "listen";
const MODES: { k: Mode; label: string }[] = [
  { k: "listen", label: "Listen" },
  { k: "en", label: "EN" },
  { k: "bi", label: "EN + ZH" },
  { k: "zh", label: "ZH" },
  { k: "cloze", label: "Cloze" },
  { k: "reading", label: "Reading" },
];

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

// Extract the 11-char YouTube video id from any common URL shape.
// Used by the next-segment CTA to look up the surrounding Collection.
function extractYouTubeId(url: string | undefined | null): string {
  if (!url) return "";
  const beId = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (beId) return beId[1];
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(shorts|embed)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  } catch { /* not a URL */ }
  return "";
}

// Sentinel cached when a bubble translation fails. Kept distinct from a
// real result so the UI can keep offering a retry instead of treating
// the failure as a finished translation.
const TRANSLATE_FAIL = "（翻译失败）";

// Chunk styling (used both inline in subtitles and in the chunk panel).
const CHUNK_COLORS: Record<string, string> = {
  idiomatic: "bg-chunk-1",
  collocation: "bg-chunk-2",
  discourse: "bg-chunk-3",
  functional: "bg-chunk-4",
  cultural: "bg-chunk-1",
};

// Match chunks against text; longest-first so 'kicking things off' beats 'kicking'.
// Used by the chunk panel; subtitle rows render via renderRichSubtitle().
function highlightChunks(text: string, chunks: Chunk[]): React.ReactNode[] {
  if (!chunks.length) return [text];
  const sorted = [...chunks].sort((a, b) => b.text.length - a.text.length);
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  outer: while (rest.length) {
    for (const c of sorted) {
      const i = rest.toLowerCase().indexOf(c.text.toLowerCase());
      if (i === 0) {
        nodes.push(
          <b
            key={key++}
            className={`${CHUNK_COLORS[c.chunk_type] ?? "bg-chunk-1"} px-1 py-0.5 rounded cursor-pointer font-medium`}
            title={c.why_explanation}
          >
            {rest.slice(0, c.text.length)}
          </b>,
        );
        rest = rest.slice(c.text.length);
        continue outer;
      }
    }
    const nextSpace = rest.indexOf(" ");
    if (nextSpace < 0) {
      nodes.push(rest);
      break;
    }
    nodes.push(rest.slice(0, nextSpace + 1));
    rest = rest.slice(nextSpace + 1);
  }
  return nodes;
}

// Render a subtitle row's English text with three layered effects:
// - Chunks → coloured background (yellow/green/etc per chunk_type)
// - Words inside vocabSet → blue highlight, so the user notices "I've
//   saved this one before"
// - Every word is clickable → opens the lookup popup
// Chunks take priority: if a word is INSIDE a chunk, the chunk colour
// wins (chunks are usually 2-4 words, the chunk itself IS the lesson).
function renderRichSubtitle(
  text: string,
  chunks: Chunk[],
  vocabSet: Set<string>,
  onWordClick: (word: string) => void,
  // Optional chunk-level click target: when supplied, every highlighted
  // chunk gets a small Info icon at its trailing edge that opens the
  // ChunkPopup. Words inside the chunk still trigger word lookup.
  onChunkClick?: (chunk: Chunk) => void,
  // User-marked phrases for THIS line (the AI didn't pick them). Rendered
  // with a distinct brand dotted underline + a small ✕ to unmark, so they
  // never visually collide with AI chunk fills or the blue vocab pill.
  userChunks?: { id: number; text: string }[],
  onUserChunkRemove?: (id: number) => void,
): React.ReactNode[] {
  const sortedChunks = [...chunks].sort((a, b) => b.text.length - a.text.length);
  const sortedUserChunks = [...(userChunks ?? [])].sort(
    (a, b) => b.text.length - a.text.length,
  );
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  const stripPunct = (w: string) => w.replace(/[^A-Za-z'-]/g, "").toLowerCase();

  while (rest.length) {
    // 0) user-marked phrase wins over an AI chunk if they overlap — it's
    //    the learner's explicit pick, so honour it first.
    let matchedUser: { id: number; text: string } | null = null;
    for (const u of sortedUserChunks) {
      if (u.text && rest.toLowerCase().startsWith(u.text.toLowerCase())) {
        matchedUser = u;
        break;
      }
    }
    if (matchedUser) {
      const piece = rest.slice(0, matchedUser.text.length);
      const uc = matchedUser;
      nodes.push(
        <span
          key={key++}
          className="bg-[#eaf3ec] text-brand rounded px-1 py-0.5 font-medium underline decoration-dotted decoration-2 underline-offset-2 decoration-brand/60"
          title="我标记的重点"
        >
          {piece.split(/(\s+)/).map((tok, i) => {
            if (!tok.trim()) return <span key={i}>{tok}</span>;
            return (
              <span
                key={i}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onWordClick(tok);
                }}
                className="cursor-pointer"
              >
                {tok}
              </span>
            );
          })}
          {onUserChunkRemove && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUserChunkRemove(uc.id);
              }}
              className="inline-flex items-center justify-center align-text-bottom ml-0.5 w-3.5 h-3.5 rounded-full text-brand/70 hover:text-white hover:bg-brand transition-colors duration-150 ease-spring"
              title="取消标记"
              aria-label={`取消标记「${uc.text}」`}
            >
              <X size={11} weight="bold" />
            </button>
          )}
        </span>,
      );
      rest = rest.slice(matchedUser.text.length);
      continue;
    }
    // 1) try chunk match anchored at start
    let matchedChunk: Chunk | null = null;
    for (const c of sortedChunks) {
      if (rest.toLowerCase().startsWith(c.text.toLowerCase())) {
        matchedChunk = c;
        break;
      }
    }
    if (matchedChunk) {
      const piece = rest.slice(0, matchedChunk.text.length);
      const chunkForCb = matchedChunk;
      nodes.push(
        <b
          key={key++}
          className={`${CHUNK_COLORS[matchedChunk.chunk_type] ?? "bg-chunk-1"} px-1 py-0.5 rounded font-medium`}
          title={matchedChunk.why_explanation}
        >
          {piece.split(/(\s+)/).map((tok, i) => {
            if (!tok.trim()) return <span key={i}>{tok}</span>;
            return (
              <span
                key={i}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onWordClick(tok);
                }}
                className="cursor-pointer"
              >
                {tok}
              </span>
            );
          })}
          {onChunkClick && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChunkClick(chunkForCb);
              }}
              className="inline-flex items-center justify-center align-text-bottom ml-0.5 w-3.5 h-3.5 rounded-full text-ink-3 hover:text-brand hover:bg-white/60 transition-colors duration-150 ease-spring"
              title={`查看 chunk「${chunkForCb.text}」详细解释`}
              aria-label={`查看 chunk ${chunkForCb.text} 详细解释`}
            >
              <Info size={11} weight="bold" />
            </button>
          )}
        </b>,
      );
      rest = rest.slice(matchedChunk.text.length);
      continue;
    }
    // 2) leading whitespace passes through
    const wsMatch = rest.match(/^\s+/);
    if (wsMatch) {
      nodes.push(<span key={key++}>{wsMatch[0]}</span>);
      rest = rest.slice(wsMatch[0].length);
      continue;
    }
    // 3) one word
    const wordMatch = rest.match(/^\S+/);
    if (!wordMatch) break;
    const tok = wordMatch[0];
    const baseLower = stripPunct(tok);
    const isVocab = baseLower.length > 0 && vocabSet.has(baseLower);
    nodes.push(
      <span
        key={key++}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onWordClick(tok);
        }}
        className={
          isVocab
            ? "cursor-pointer bg-blue-50 text-blue-700 rounded px-0.5 hover:bg-blue-100"
            : "cursor-pointer hover:underline hover:decoration-dotted"
        }
        title={isVocab ? "已加入生词本" : undefined}
      >
        {tok}
      </span>,
    );
    rest = rest.slice(tok.length);
  }
  return nodes;
}


// =================================================================
// Subtitle row — wired to mediaRef so all 4 buttons work
// =================================================================
function SubRow({
  sub,
  active,
  chunks,
  mode,
  vocabSet,
  onSeek,
  onCopy,
  onExplain,
  onAddNote,
  noteCount = 0,
  onWordClick,
  onChunkClick,
  userChunks,
  onUserChunkRemove,
  onRecord,
  isLooping,
  onToggleLoop,
  rowRef,
  onRangePick,
  rangeRole,
  rangePending,
  dict,
}: {
  sub: Subtitle;
  active: boolean;
  chunks: Chunk[];
  mode: Mode;
  vocabSet: Set<string>;
  onSeek: () => void;
  onCopy: () => void;
  onExplain: () => void;
  onAddNote: () => void;
  noteCount?: number;
  onWordClick?: (word: string, sub: Subtitle) => void;
  onChunkClick?: (chunk: Chunk) => void;
  userChunks?: { id: number; text: string }[];
  onUserChunkRemove?: (id: number) => void;
  onRecord?: () => void;
  isLooping?: boolean;
  onToggleLoop?: () => void;
  rowRef?: (el: HTMLDivElement | null) => void;
  // Range-select (chapters mode). onRangePick toggles this row as the
  // segment start / commits the end. rangeRole marks ONLY the two ends:
  // "start" = pending or committed start row, "end" = committed end row
  // (middle rows stay null — no tint, so the playing-row highlight is
  // never fought). rangePending = a start row is already chosen.
  onRangePick?: () => void;
  rangeRole?: "start" | "end" | null;
  rangePending?: boolean;
  // Listen-mode dictation (Parent owns the per-line attempt + result so
  // it survives row unmount on scroll). When undefined, the listen-mode
  // body falls back to the old "请只用耳朵" placeholder.
  dict?: {
    revealed: boolean;
    onReplay: () => void;
    onToggleReveal: () => void;
  };
}) {
  // Brief ✓ feedback after copy so the tap registers visibly.
  const [copied, setCopied] = useState(false);
  // "纯听" mode hides both English and Chinese — user listens without any
  // crutch. Row number and timestamp stay visible so you can still click
  // to seek / repeat.
  const showEn = mode !== "zh" && mode !== "listen";
  const showZh = mode === "bi" || mode === "zh";

  let enContent: React.ReactNode = sub.text_en;
  if (showEn) {
    if (mode === "cloze") {
      enContent = sub.text_en.replace(/\b(\w{4,})\b/g, "____");
    } else {
      // Unified renderer: chunks (yellow/etc) + saved vocab (blue) + every
      // word clickable for lookup.  Active row uses the row's bg-[#f2f8f4]
      // for "current" feedback; we no longer overlay an extra phrase
      // highlight, which was visually noisy on top of the row tint.
      enContent = renderRichSubtitle(
        sub.text_en,
        chunks,
        vocabSet,
        (w) => onWordClick?.(w, sub),
        onChunkClick,
        userChunks,
        onUserChunkRemove,
      );
    }
  }

  // Visual cue: if this row ends a sentence (trailing .!?), add a little
  // extra bottom margin so the next row reads as a fresh paragraph.
  const endsSentence = /[.!?]\s*$/.test(sub.text_en);

  // Pinned favourite star stays visible; other actions are hover-only so
  // the default reading view stays clean.
  const toolBtn = "w-7 h-7 hover:bg-[#eaf3ec] hover:text-brand rounded grid place-items-center";
  // Selected range is shown ONLY at its two ends (a left accent cap on
  // the start / end rows), never as a middle tint — so it never competes
  // with the playing row's own highlight. start covers both the pending
  // start and the committed start row.
  const isRangeEnd = rangeRole === "start" || rangeRole === "end";
  const rangeCls = isRangeEnd ? "border-l-2 border-l-brand" : "";
  return (
    <div
      ref={rowRef}
      data-sub-id={sub.id}
      onClick={onSeek}
      className={`group py-3 px-3 -mx-3 border-b border-[#f3f4f8] last:border-0 transition-colors duration-150 ease-spring cursor-pointer ${
        active ? "bg-[#f2f8f4]" : "hover:bg-[#f5f7f4]"
      } ${rangeCls} ${endsSentence ? "mb-3" : ""}`}
    >
      <div className="flex gap-2.5 items-start">
        <span
          className={`w-6 h-6 rounded-full grid place-items-center text-2xs mt-0.5 shrink-0 ${
            active ? "bg-brand text-white" : "bg-[#f0f3f0] text-ink-2"
          }`}
        >
          {sub.seq}
        </span>
        <div className="flex-1 min-w-0">
          {showEn && (
            <div className={`text-sm leading-[1.6] ${active ? "font-semibold" : "font-medium"}`}>
              {enContent}
            </div>
          )}
          {showZh && <div className="text-xs text-ink-2 mt-1 leading-[1.55]">{sub.text_zh}</div>}
          {mode === "listen" && (
            dict ? (
              <DictationRow
                truth={sub.text_en}
                revealed={dict.revealed}
                isCurrent={active}
                onReplay={dict.onReplay}
                onToggleReveal={dict.onToggleReveal}
              />
            ) : (
              <div className="text-xs text-ink-3 italic leading-[1.5]">
                · 听 · 看这一行时请只用耳朵 ·
              </div>
            )
          )}
          <div className="text-2xs text-ink-3 mt-1.5 flex items-center gap-2.5">
            <span>{fmt(sub.start_ms)} – {fmt(sub.end_ms)}</span>
            {isRangeEnd && (
              <span className="px-1.5 py-0.5 rounded-full bg-[#eaf3ec] text-[#285e48] font-semibold">
                {rangeRole === "start" ? "起点" : "结束"}
              </span>
            )}
            <span className="flex gap-0.5 ml-auto">
              <span
                className={`flex gap-0.5 transition-opacity ${
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                {onRangePick && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRangePick();
                    }}
                    className={`w-7 h-7 rounded grid place-items-center transition-colors duration-150 ease-spring ${
                      isRangeEnd
                        ? "bg-brand text-white"
                        : "hover:bg-[#eaf3ec] hover:text-brand"
                    }`}
                    title={
                      rangeRole === "start"
                        ? "取消起始句"
                        : rangeRole === "end"
                          ? "结束句（点其它句可改）"
                          : rangePending
                            ? "把这句设为学习区间的结束句"
                            : "把这句设为学习区间的起始句"
                    }
                    aria-label="选段标记"
                  >
                    <Scissors
                      size={14} weight={isRangeEnd ? "bold" : "regular"}
                    />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek();
                  }}
                  className={toolBtn}
                  title="从这里播放"
                >
                  <Play size={14} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRecord?.();
                  }}
                  className={toolBtn}
                  title="跟读录音"
                >
                  <Microphone size={14} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLoop?.();
                  }}
                  className={`w-7 h-7 rounded grid place-items-center transition-colors duration-150 ease-spring ${
                    isLooping
                      ? "bg-brand text-white"
                      : "hover:bg-[#eaf3ec] hover:text-brand"
                  }`}
                  title={isLooping ? "取消循环本句" : "循环本句"}
                  aria-pressed={!!isLooping}
                >
                  <Repeat size={14} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopy();
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  }}
                  className={toolBtn}
                  title="复制英文"
                >
                  {copied ? (
                    <Check size={14} weight="bold" className="text-emerald-600" />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onExplain();
                  }}
                  className={toolBtn}
                  title="解释这句话（无需选中文字）"
                >
                  <Question size={14} />
                </button>
              </span>
              {/* Note pencil is pinned (not hover-gated) so annotated
                  lines are scannable at a glance — brand-filled with a
                  count when notes exist, quiet hover-only outline when
                  none so the clean reading view is preserved. */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAddNote();
                }}
                className={`relative w-7 h-7 rounded grid place-items-center transition-colors duration-150 ease-spring ${
                  noteCount > 0
                    ? "text-brand bg-[#eaf3ec] hover:bg-[#dcebe1]"
                    : "opacity-0 group-hover:opacity-100 hover:bg-[#eaf3ec] hover:text-brand"
                }`}
                title={noteCount > 0 ? `查看 / 添加笔记（${noteCount}）` : "添加笔记"}
                aria-label={noteCount > 0 ? `查看或添加笔记，共 ${noteCount} 条` : "添加笔记"}
              >
                <Pencil size={14} weight={noteCount > 0 ? "bold" : "regular"} />
                {noteCount > 1 && (
                  <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-brand text-white text-2xs font-bold grid place-items-center">
                    {noteCount}
                  </span>
                )}
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// =================================================================
// Reading view — flatten all subtitles into article-style paragraphs.
// Same chunk colours / vocab highlights / per-word lookups as SubRow,
// but no per-line UI (timestamps, buttons, row numbers) so the eye
// can skim continuous prose. Clicking any sentence still seeks to it
// and the active sentence keeps the row tint so the learner can
// follow the audio.
// =================================================================
function ReadingView({
  subs,
  chunks,
  vocabSet,
  activeId,
  onSeek,
  onWordClick,
  onChunkClick,
  userChunksBySub,
  onUserChunkRemove,
  rowRefSetter,
}: {
  subs: Subtitle[];
  chunks: Chunk[];
  vocabSet: Set<string>;
  activeId: number | null;
  onSeek: (sub: Subtitle) => void;
  onWordClick: (word: string, sub: Subtitle) => void;
  onChunkClick?: (chunk: Chunk) => void;
  userChunksBySub?: Map<number, { id: number; text: string }[]>;
  onUserChunkRemove?: (id: number) => void;
  rowRefSetter: (id: number, el: HTMLElement | null) => void;
}) {
  // Group consecutive subs into paragraphs of ~4 sentences each, always
  // breaking on a sentence-ending punctuation so paragraphs read cleanly.
  const paragraphs = useMemo(() => {
    const out: Subtitle[][] = [];
    let cur: Subtitle[] = [];
    let sentenceCount = 0;
    for (const s of subs) {
      cur.push(s);
      if (/[.!?]["')\]]?\s*$/.test(s.text_en)) sentenceCount++;
      if (sentenceCount >= 4) {
        out.push(cur);
        cur = [];
        sentenceCount = 0;
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }, [subs]);

  return (
    <div className="text-base leading-[1.85] text-ink">
      {paragraphs.map((para, pi) => (
        <p key={pi} className="mb-4 first:mt-2">
          {para.map((s, si) => {
            const isActive = activeId === s.id;
            return (
              <span
                key={s.id}
                ref={(el) => rowRefSetter(s.id, el)}
                data-sub-id={s.id}
                onClick={() => onSeek(s)}
                className={`cursor-pointer rounded px-0.5 transition-colors duration-150 ease-spring ${
                  isActive ? "bg-[#f2f8f4]" : "hover:bg-[#f5f7f4]"
                }`}
                title={`${fmt(s.start_ms)}  ·  点击从这句开始播放`}
              >
                {renderRichSubtitle(
                  s.text_en,
                  chunks,
                  vocabSet,
                  (w) => onWordClick(w, s),
                  onChunkClick,
                  userChunksBySub?.get(s.id),
                  onUserChunkRemove,
                )}
                {si < para.length - 1 ? " " : ""}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}


// =================================================================
// Notes / Favorite / AI tabs (unchanged from previous version)
// =================================================================
function NotesTab({ episodeId }: { episodeId: number }) {
  const qc = useQueryClient();
  const { data: notes } = useQuery({
    queryKey: ["notes", episodeId],
    queryFn: () => api.listNotes({ episode_id: episodeId }).then((r) => r.items),
  });
  const [draft, setDraft] = useState("");
  // Click a card → open it in a modal. Inline expand caused two bugs:
  // long bodies clipped under the parent's overflow:hidden, and many
  // siblings made the bottom cards unreachable since the list itself
  // wasn't scrollable.
  const [modalNote, setModalNote] = useState<
    { id: number; content: string; created_at?: string | null } | null
  >(null);

  const add = useMutation({
    mutationFn: (content: string) => api.addNote(episodeId, content),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["notes", episodeId] });
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteNote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notes", episodeId] }),
  });

  return (
    <div className="flex flex-col gap-2.5 h-full min-h-0">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) add.mutate(draft.trim());
        }}
        className="flex gap-2 shrink-0"
      >
        <input
          className="input flex-1 !py-2"
          placeholder="写点什么…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={add.isPending}>
          Save
        </button>
      </form>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 -mx-1 px-1 pb-2">
        {(notes ?? []).length === 0 && (
          <p className="text-xs text-ink-2 text-center py-4">还没有笔记</p>
        )}
        {notes?.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            onOpen={() => setModalNote(n)}
            onDelete={() => del.mutate(n.id)}
          />
        ))}
      </div>

      {modalNote && (
        <NoteDetailModal note={modalNote} onClose={() => setModalNote(null)} />
      )}
    </div>
  );
}


// AI explanations get saved as Markdown but were sometimes flattened
// to a single newline-poor line, so they rendered as one unreadable
// wall. Re-insert block breaks before headings / list items / dividers
// so the line-based SimpleMarkdown can structure them again. Idempotent
// on well-formed Markdown.
function normalizeMd(s: string): string {
  let t = s.replace(/\r/g, "");
  t = t.replace(/\s*-{3,}\s*/g, "\n\n---\n\n"); // dividers
  t = t.replace(/\s+(#{1,3}\s+)/g, "\n\n$1"); // headings
  t = t.replace(/\s+(\d{1,2}\.\s+)/g, "\n$1"); // ordered items
  t = t.replace(/\s+([-*]\s+)/g, "\n$1"); // bullets
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// Single source of truth for splitting a stored note into a clean
// title + body, and deciding whether the body is Markdown. Detection
// is content-based (not just the 📖/📝 prefix) so legacy pref- ix-less
// explanation notes also render structured instead of as a wall.
function parseNote(content: string): {
  isMd: boolean;
  title: string;
  body: string;
} {
  const raw = (content ?? "").replace(/\r/g, "");
  const prefixed = /^(📖|📝)\s+/.test(raw);
  const noPrefix = raw.replace(/^(📖|📝)\s+/, "");
  const looksMd =
    prefixed ||
    /(^|\s)#{1,3}\s/.test(noPrefix) ||
    /\s[-*]\s+\S/.test(noPrefix) ||
    /\s\d{1,2}\.\s/.test(noPrefix) ||
    /-{3,}/.test(noPrefix);
  if (!looksMd) {
    const nl = noPrefix.indexOf("\n");
    return {
      isMd: false,
      title: (nl >= 0 ? noPrefix.slice(0, nl) : noPrefix).trim(),
      body: nl >= 0 ? noPrefix.slice(nl + 1).trim() : "",
    };
  }
  const lines = normalizeMd(noPrefix).split("\n");
  const hIdx = lines.findIndex((l) => l.trim());
  const title =
    hIdx === -1 ? "" : lines[hIdx].replace(/^#{1,3}\s+/, "").trim();
  let bodyLines = hIdx === -1 ? [] : lines.slice(hIdx + 1);
  // The explain LLM restates the prompt as a bold question on the first
  // body line (e.g. **「…long sentence…」里有哪些值得学的地道口语表达?**).
  // It just duplicates the linked subtitle + the title, so for 📖 notes
  // drop a leading bold-only line that ends in a question mark.
  if (prefixed) {
    const fi = bodyLines.findIndex((l) => l.trim());
    if (
      fi !== -1 &&
      /^\*\*.+\*\*$/.test(bodyLines[fi].trim()) &&
      /[?？]\*\*$/.test(bodyLines[fi].trim())
    ) {
      bodyLines = bodyLines.slice(fi + 1);
    }
  }
  const body = bodyLines.join("\n").trim();
  return { isMd: true, title, body };
}

// =================================================================
// NoteCard — title + 2-line body preview. Click anywhere on the card
// (except the corner ✕) to open the full note in a modal where long
// Markdown bodies can scroll independently of the list.
// =================================================================
function NoteCard({
  note,
  onOpen,
  onDelete,
}: {
  note: { id: number; content: string; created_at?: string | null };
  onOpen: () => void;
  onDelete: () => void;
}) {
  // 📖 = AskPopup explanation; 📝 = sentence-pattern lesson. Shared
  // parseNote gives a clean title + (markdown) body for any note shape.
  const { isMd: isMarkdownNote, title: heading, body } = parseNote(note.content);
  // Strip Markdown syntax for the 2-line preview so headings/code/bullets
  // don't render as raw `##` / backticks in the card.
  const preview = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,3}\s*/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d{1,2}\.\s+/gm, "")
    .replace(/^\s*-{3,}\s*$/gm, " ")
    .replace(/\n+/g, " ")
    .trim();

  return (
    <article
      className="card p-3 hover:border-ink-2/30 hover:shadow-sm transition cursor-pointer"
      onClick={onOpen}
    >
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 w-7 h-7 rounded-lg bg-[#eaf3ec] text-[#285e48] grid place-items-center mt-0.5">
          {isMarkdownNote ? (
            <BookOpen size={13} weight="bold" />
          ) : (
            <NotePencil size={12} weight="bold" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink leading-[1.4] break-words line-clamp-2">
            {heading || "（空）"}
          </div>
          {preview && (
            <p className="mt-1 text-xs text-ink-2 leading-[1.5] line-clamp-2 break-words">
              {preview}
            </p>
          )}
          {note.created_at && (
            <div className="text-2xs text-ink-3 mt-1.5" title={new Date(note.created_at).toLocaleString()}>
              {timeAgo(note.created_at)}
            </div>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-ink-3 hover:text-red-500 transition-colors duration-150 ease-spring shrink-0"
          title="删除笔记"
        >
          <X size={12} />
        </button>
      </div>
    </article>
  );
}

// =================================================================
// NoteDetailModal — full-screen sheet on mobile, centered dialog on
// desktop. Body scrolls inside the modal so long sentence-pattern or
// AskPopup explanations never get clipped by parent overflow.
// =================================================================
function NoteDetailModal({
  note,
  onClose,
}: {
  note: { id: number; content: string; created_at?: string | null };
  onClose: () => void;
}) {
  const { isMd: isMarkdownNote, title: heading, body } = parseNote(note.content);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="bg-white w-full md:max-w-2xl rounded-t-2xl md:rounded-2xl shadow-2xl flex flex-col max-h-[85vh] md:max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-line/60">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <span className="shrink-0 w-8 h-8 rounded-lg bg-[#eaf3ec] text-[#285e48] grid place-items-center mt-0.5">
              {isMarkdownNote ? (
                <BookOpen size={15} weight="bold" />
              ) : (
                <NotePencil size={14} weight="bold" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-bold text-ink leading-[1.4] break-words line-clamp-3">
                {heading || "（空）"}
              </h3>
              {note.created_at && (
                <div className="text-2xs text-ink-3 mt-1" title={new Date(note.created_at).toLocaleString()}>
                  {timeAgo(note.created_at)}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-ink-3 hover:text-ink"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {isMarkdownNote && body ? (
            <SimpleMarkdown text={body} />
          ) : body ? (
            <p className="text-sm text-ink-2 leading-[1.7] whitespace-pre-wrap">
              {body}
            </p>
          ) : (
            <p className="text-xs text-ink-3">（无更多内容）</p>
          )}
        </div>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function FavoriteButton({
  targetType,
  targetId,
  className,
}: {
  targetType: "episode" | "subtitle" | "chunk";
  targetId: number;
  className?: string;
}) {
  const qc = useQueryClient();
  const { data: favs } = useQuery({
    queryKey: ["favs", targetType],
    queryFn: () => api.listFavorites(targetType),
  });
  const isFav = !!favs?.some((f) => f.target_id === targetId);

  // Optimistic toggle. Without this, clicking the star left the button
  // in a `disabled={isPending}` state for the entire 200-800ms server
  // roundtrip, and the browser would flip cursor: pointer → default for
  // the duration — visible as a "small hand → arrow → small hand" jank
  // on every click. With optimistic UI the cache flips at 0ms, no
  // disabled state is needed, and the cursor stays steady.
  const toggle = useMutation({
    mutationFn: () =>
      isFav
        ? api.removeFavorite(targetType, targetId).then(() => undefined)
        : api.addFavorite(targetType, targetId).then(() => undefined),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["favs", targetType] });
      const prev = qc.getQueryData<Array<{ id: number; target_type: string; target_id: number; note: string }>>(["favs", targetType]);
      qc.setQueryData<typeof prev>(["favs", targetType], (old = []) =>
        isFav
          ? (old ?? []).filter((f) => f.target_id !== targetId)
          : [...(old ?? []), { id: -targetId, target_type: targetType, target_id: targetId, note: "" }],
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["favs", targetType], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["favs", targetType] }),
  });

  return (
    <button
      onClick={() => toggle.mutate()}
      className={
        className ??
        `inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors duration-150 ease-spring active:scale-90 ${
          isFav ? "text-brand hover:bg-[#eaf3ec]" : "text-ink-3 hover:text-ink hover:bg-[#eff2ef]"
        }`
      }
      title={isFav ? "取消收藏" : "收藏这一集"}
      aria-label={isFav ? "取消收藏" : "收藏这一集"}
    >
      {isFav ? (
        <Star size={16} weight="fill" />
      ) : (
        <Star size={16} />
      )}
    </button>
  );
}

// --- Web Speech helpers (module-scoped so we don't rebuild per render) ---

// TypeScript doesn't ship SpeechRecognition types by default — declare the
// shape we need.  Using `unknown` for the event because we only touch a
// couple of well-known fields.
type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function getSpeechRecognition(): (new () => SR) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// iOS 把网站「添加到主屏」后是 standalone 模式，WebKit 的 SpeechRecognition
// 在这个模式下有长期缺陷：start() 后既不报错、也不触发任何事件，录音状态
// 就此卡死、整个面板点不动（Safari 普通标签页里却正常）。所以这个环境里
// 干脆不碰它，提示用户去 Safari 或直接打字。Android 的 standalone PWA 不受
// 影响，所以只挡 iOS。
function isIOSStandalone(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as unknown as { userAgent?: string; platform?: string; maxTouchPoints?: number; standalone?: boolean };
  const ua = nav.userAgent || "";
  const isIOS =
    /iP(hone|ad|od)/.test(ua) ||
    (nav.platform === "MacIntel" && (nav.maxTouchPoints || 0) > 1); // iPadOS 伪装成 Mac
  const standalone =
    nav.standalone === true ||
    (typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches);
  return isIOS && standalone;
}

// Tokenise a plain text blob into clickable <span> words.  Used for AI
// bubble text — every word in the reply becomes a lookup trigger.
function clickableWordsInText(
  text: string,
  onWordClick: (word: string) => void,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let key = 0;
  text.split(/(\s+)/).forEach((tok) => {
    if (!tok) return;
    if (!tok.trim()) {
      parts.push(<span key={key++}>{tok}</span>);
      return;
    }
    parts.push(
      <span
        key={key++}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onWordClick(tok);
        }}
        className="cursor-pointer hover:underline hover:decoration-dotted"
      >
        {tok}
      </span>,
    );
  });
  return parts;
}

// Highlight any target chunk text inside a user's message so the learner
// instantly sees "yes, you actually used that phrase".  Longest-first so
// multi-word chunks win over single words.
function highlightChunksInText(text: string, chunks: Chunk[]): React.ReactNode[] {
  if (!chunks.length) return [text];
  const sorted = [...chunks].sort((a, b) => b.text.length - a.text.length);
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  outer: while (rest.length) {
    for (const c of sorted) {
      if (rest.toLowerCase().startsWith(c.text.toLowerCase())) {
        nodes.push(
          <b key={key++} className="bg-[#16a070] text-white rounded px-1 font-semibold">
            {rest.slice(0, c.text.length)}
          </b>,
        );
        rest = rest.slice(c.text.length);
        continue outer;
      }
    }
    nodes.push(rest[0]);
    rest = rest.slice(1);
  }
  return nodes;
}


function FeedbackCard({
  fb,
}: {
  fb: {
    praise: string;
    errors: { original: string; suggestion: string; why: string }[];
    alternatives: string[];
    score: number;
  };
}) {
  const dots = "●".repeat(fb.score) + "○".repeat(Math.max(0, 5 - fb.score));
  return (
    <div className="text-xs px-3 py-2 rounded-xl bg-[#f8faf8] border border-line text-ink-2 leading-[1.55] space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-2xs uppercase tracking-widest text-ink-3 font-bold">反馈</span>
        <span className="text-2xs text-ink-3" title="自然度评分 0-5">{dots}</span>
      </div>
      {fb.praise && (
        <div className="inline-flex items-start gap-1.5 text-[#16a070]">
          <Check size={12} weight="bold" className="shrink-0 mt-0.5" />
          <span>{fb.praise}</span>
        </div>
      )}
      {fb.errors.length > 0 && (
        <div className="space-y-0.5">
          {fb.errors.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[#2f755f]">
              <Wrench size={12} className="shrink-0 mt-0.5" />
              <span>
                <span className="line-through opacity-70">{e.original}</span>
                {" → "}
                <b className="not-italic">{e.suggestion}</b>
                {e.why && <span className="text-ink-3 ml-1">（{e.why}）</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {fb.alternatives.length > 0 && (
        <div className="space-y-0.5">
          {fb.alternatives.map((a, i) => (
            <div key={i} className="flex items-start gap-1.5 text-ink-2">
              <ChatText size={12} className="shrink-0 mt-0.5" />
              <span>{a}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// AI-picked "say it differently" lesson — one sentence from the episode +
// 4 perspective-shifted variants (人/物/it/动名词 主语). Lives in
// ai_metadata.sentence_pattern; older episodes don't have it (just hide).
function SentencePatternCard({
  pattern, onSeek, onSpeak, onSave, savedNoteId,
}: {
  pattern: {
    original: string;
    subtitle_idx: number;
    variants: { text: string; mental_trigger?: string; subject_type?: string; focus: string }[];
    commentary_zh: string;
  };
  onSeek: () => void;
  onSpeak: (text: string) => void;
  onSave: () => void;
  savedNoteId: number | null;
}) {
  // mental_trigger is the new field ("「我」" / "「行李箱」" — the
  // psychological cue that pops into your head before you speak).
  // subject_type is the old grammar label kept for back-compat with
  // episodes generated before the trigger rewrite. Prefer the new
  // field; fall back so older episodes still render something useful.
  const triggerLabel = (v: { mental_trigger?: string; subject_type?: string }) => {
    const t = (v.mental_trigger || "").trim();
    if (t) {
      // Wrap in 「」 if the LLM didn't include them, for visual consistency.
      const wrapped = /^[「『][^「『]*[」』]$/.test(t) ? t : `「${t}」`;
      return `先想到 ${wrapped}`;
    }
    return (v.subject_type || "").trim();
  };
  return (
    <div className="rounded-xl bg-[#fff8f4] border border-[#dcebe1] p-3.5">
      <div className="bg-white border border-line/40 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-2xs text-ink-3 uppercase tracking-wide">原句</span>
          {pattern.subtitle_idx > 0 && (
            <button
              onClick={onSeek}
              className="text-2xs text-brand font-medium hover:underline"
              title="跳到原片这一行"
            >
              🎬 看原片
            </button>
          )}
        </div>
        {/* 喇叭贴着它要念的那句话。原来挂在上面那行标签的行尾（ml-auto），
            宽屏上离句子几百像素远，每听一句都要把鼠标横跨整个面板。 */}
        <div className="flex items-start gap-2">
          <button
            onClick={() => onSpeak(pattern.original)}
            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-brand hover:bg-[#eaf3ec] transition-colors duration-150 ease-spring"
            title="朗读"
            aria-label="朗读原句"
          >
            <SpeakerHigh size={14} />
          </button>
          <div className="flex-1 min-w-0 text-sm text-ink leading-[1.55] font-medium">
            {pattern.original}
          </div>
        </div>
      </div>

      <div className="text-2xs text-ink-2 mt-3 mb-1.5 font-medium">
        母语者还会这样说 ↓
      </div>
      <div className="space-y-2">
        {pattern.variants.map((v, i) => {
          const label = triggerLabel(v);
          return (
            <div key={i} className="bg-white border border-line/40 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-2xs px-1.5 py-0.5 rounded-full bg-[#eaf3ec] text-brand font-semibold">
                  🧠 {label}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <button
                  onClick={() => onSpeak(v.text)}
                  className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-brand hover:bg-[#eaf3ec] transition-colors duration-150 ease-spring"
                  title="朗读"
                  aria-label={`朗读 ${label}`}
                >
                  <SpeakerHigh size={14} />
                </button>
                <div className="flex-1 min-w-0 text-sm text-ink leading-[1.5]">{v.text}</div>
              </div>
              {v.focus && (
                <div className="text-2xs text-ink-2 mt-1.5 leading-[1.5]">{v.focus}</div>
              )}
            </div>
          );
        })}
      </div>

      {pattern.commentary_zh && (
        <div className="mt-3 p-2.5 rounded-lg bg-white/70 border border-line/40 text-2xs text-ink-2 leading-[1.6]">
          <span className="text-brand font-semibold">💡 中英视角差　</span>
          {pattern.commentary_zh}
        </div>
      )}

      <div className="mt-3">
        <button
          onClick={onSave}
          disabled={savedNoteId !== null}
          className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:bg-[#dce4dc] disabled:text-ink-3 transition-colors duration-150 ease-spring"
        >
          {savedNoteId !== null ? "Saved to notes" : "Save to notes"}
        </button>
      </div>
    </div>
  );
}


// Pre-generated study card shown above the AI chat.  Hidden when the
// episode has no lesson_brief (back-compat for episodes imported before
// this feature shipped — admin can backfill via regenerate-lesson-brief).
//
// Shape comes from the backend's LessonBrief Pydantic model and is
// generated once per episode in pipeline stage 5; we only RENDER here.
function LessonBriefCard({
  brief,
  hasMessages,
}: {
  brief: LessonBrief | null;
  hasMessages: boolean;
}) {
  // Default expanded if the learner hasn't started chatting yet.  Once
  // they have a message exchange going, collapse so the chat feed gets
  // the screen — but keep the toggle visible so they can re-open anytime.
  const [open, setOpen] = useState(!hasMessages);
  // Re-expand on episode-switch (brief identity change). React already
  // re-mounts when the parent's `key` changes; this useEffect handles
  // the in-place case where AITab keeps mounted but episodeId changes.
  useEffect(() => {
    setOpen(!hasMessages);
  }, [brief, hasMessages]);

  if (!brief) return null;
  const hasAny =
    (brief.core_points?.length ?? 0) > 0 ||
    (brief.target_chunks_hint?.length ?? 0) > 0 ||
    (brief.speaking_prompts?.length ?? 0) > 0 ||
    !!brief.discussion_question;
  if (!hasAny) return null;

  return (
    <div className="rounded-xl bg-[#fafbff] border border-[#dde3f4] shrink-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#f1f4fb] transition-colors duration-150 ease-spring"
        aria-expanded={open}
      >
        <div className="inline-flex items-center gap-1.5 text-2xs uppercase tracking-widest text-[#3957b8] font-bold">
          <BookOpen size={11} /> 学习要点
        </div>
        <span className="text-2xs text-ink-3">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
          {/* Core points */}
          {brief.core_points && brief.core_points.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-2xs font-semibold text-ink-2">视频里讲了什么</div>
              <ol className="flex flex-col gap-1.5">
                {brief.core_points.map((p, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-[1.55]">
                    <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#3957b8] text-white text-2xs font-bold mt-0.5">
                      {i + 1}
                    </span>
                    <div className="flex-1">
                      {p.en && <div className="text-ink font-medium">{p.en}</div>}
                      {p.zh && <div className="text-ink-2 mt-0.5">{p.zh}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Discussion question — primary call-to-action */}
          {brief.discussion_question && (brief.discussion_question.en || brief.discussion_question.zh) && (
            <div className="rounded-lg bg-white border border-[#dde3f4] p-2.5">
              <div className="text-2xs font-semibold text-[#3957b8] mb-1">AI 等会儿要问你</div>
              {brief.discussion_question.en && (
                <div className="text-sm text-ink font-semibold leading-[1.5]">
                  {brief.discussion_question.en}
                </div>
              )}
              {brief.discussion_question.zh && (
                <div className="text-xs text-ink-2 mt-1">{brief.discussion_question.zh}</div>
              )}
            </div>
          )}

          {/* Target chunks the learner should reach for */}
          {brief.target_chunks_hint && brief.target_chunks_hint.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-2xs font-semibold text-ink-2">回答时可以用</div>
              <div className="flex flex-wrap gap-1.5">
                {brief.target_chunks_hint.map((h) => (
                  <span
                    key={h.text}
                    className="inline-flex items-baseline gap-1 text-2xs px-2 py-0.5 rounded-full bg-white border border-[#dde3f4]"
                    title={h.zh}
                  >
                    <span className="text-ink font-medium">{h.text}</span>
                    {h.zh && <span className="text-ink-3">· {h.zh}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Speaking prompts — scaffolding hints */}
          {brief.speaking_prompts && brief.speaking_prompts.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-2xs font-semibold text-ink-2 inline-flex items-center gap-1">
                <Star size={11} className="text-[#e8a23b]" />
                引导提示
              </div>
              <ul className="flex flex-col gap-0.5">
                {brief.speaking_prompts.map((p, i) => (
                  <li key={i} className="text-xs text-ink-2 leading-[1.5] flex gap-1.5">
                    <span className="shrink-0 text-[#e8a23b] mt-[2px]">●</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function AITab({
  episodeId,
  chunks,
  lessonBrief,
  onAIInteract,
}: {
  episodeId: number;
  chunks: Chunk[];
  lessonBrief: LessonBrief | null;
  onAIInteract?: () => void;
}) {
  // Resolve the AI persona's display name from the user's voice pick.
  // Read on every render — re-mount on Me→Learn navigation picks up the
  // change naturally; same-tab voice swaps without remount fall through
  // until the next state update, which is fine for this UI.
  const aiVoiceId = getPreferredVoiceId();
  const aiVoice = getVoiceById(aiVoiceId);
  const aiInitials = getVoiceInitials(aiVoiceId);
  const aiName = aiVoice?.name ?? "AI";
  // Call on any AI interaction (send / mic / TTS) so the video pauses and
  // doesn't overlap with AI audio. No-op if the host didn't wire it.
  // Also primes Web Speech on the FIRST user gesture so iOS Safari will
  // let later speechSynthesis.speak() calls actually play (including
  // auto-speak from useEffect which itself wouldn't have gesture context).
  const interact = () => {
    primeWebSpeech();
    primeAudio();
    try { onAIInteract?.(); } catch { /* ignore */ }
  };
  const qc = useQueryClient();
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  // 浏览器不支持语音识别。原来用 alert() 说这件事 —— 它阻塞整个页面，
  // 而且弹在屏幕顶部，跟用户刚点的那个麦克风按钮完全脱节。改成就地提示。
  const [sttMsg, setSttMsg] = useState("");
  // 装成 iOS 主屏 App 后语音输入用不了 —— 一进 AI 对话就主动提示一次
  // （可关闭；关了记在 localStorage，不再重复烦。点录音时的即时提示另算）。
  useEffect(() => {
    if (!isIOSStandalone()) return;
    try {
      if (!localStorage.getItem("ios-standalone-mic-hint")) {
        setSttMsg("装成 App 后无法用语音输入。想用语音，请在 Safari 里打开 justspeak.cn 网页版；打字不受影响。");
      }
    } catch { /* ignore */ }
  }, []);
  const [autoSpeak, setAutoSpeak] = useState(() => {
    try {
      return localStorage.getItem("ai-autospeak") !== "0";
    } catch {
      return true;
    }
  });
  // Default-hide AI bubble text to nudge the learner to listen first.
  // Opening message (idx 0) is exempt — it sets the scene + breaks the ice.
  const [revealAllAI, setRevealAllAI] = useState(() => {
    try { return localStorage.getItem("ai-reveal-text") === "1"; } catch { return false; }
  });
  // Two explicit-override sets, so the user can reveal individual
  // bubbles when global is off AND hide individual bubbles when global
  // is on.  Visibility rule below combines the three sources.
  const [revealedBubbles, setRevealedBubbles] = useState<Set<number>>(new Set());
  const [hiddenBubbles, setHiddenBubbles] = useState<Set<number>>(new Set());
  const recognitionRef = useRef<SR | null>(null);
  const lastSpokenTsRef = useRef<number>(0);
  const feedRef = useRef<HTMLDivElement | null>(null);
  // Belt-and-suspenders for an iOS Safari quirk where the controlled
  // textarea occasionally kept the sent text visible after setDraft(""),
  // forcing the user to hand-clear before typing again. We write "" to
  // the DOM too on send. Idempotent when React has already synced.
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [sendingStream, setSendingStream] = useState(false);
  // Map "message index" → Chinese translation (cached so re-clicks don't
  // re-call the LLM).  Keyed by index rather than ts so new messages
  // don't collide; convo replacement resets this too.
  const [translations, setTranslations] = useState<Record<number, string>>({});
  const [translatingIdx, setTranslatingIdx] = useState<number | null>(null);
  const [wordPopup, setWordPopup] = useState<{ word: string; context: string } | null>(null);
  // Per-bubble feedback + hint cache
  type Feedback = {
    praise: string;
    errors: { original: string; suggestion: string; why: string }[];
    alternatives: string[];
    score: number;
  };
  const [feedbacks, setFeedbacks] = useState<Record<number, Feedback>>({});
  const [feedbackBusyIdx, setFeedbackBusyIdx] = useState<number | null>(null);
  const [hints, setHints] = useState<Record<number, string>>({}); // keyed by latest AI msg idx
  const [hintBusy, setHintBusy] = useState(false);
  // Teach-back state
  type TeachbackReview = {
    verdict: string;
    strengths: string[];
    missed_points: string[];
    suggestion: string;
  };
  const [teachbackQ, setTeachbackQ] = useState<string | null>(null);
  const [teachbackAnswer, setTeachbackAnswer] = useState("");
  const [teachbackReview, setTeachbackReview] = useState<TeachbackReview | null>(null);
  const [teachbackBusy, setTeachbackBusy] = useState(false);
  const [teachbackOpen, setTeachbackOpen] = useState(false);

  const start = useMutation({
    mutationFn: () => api.startConversation(episodeId),
    onSuccess: (c) => {
      setConvo(c);
      setTranslations({});
      setFeedbacks({});
      setHints({});
      setRevealedBubbles(new Set());
      setHiddenBubbles(new Set());
      setTeachbackQ(null);
      setTeachbackAnswer("");
      setTeachbackReview(null);
      setTeachbackOpen(false);
    },
  });

  const resetConvo = useMutation({
    mutationFn: () => api.resetConversation(convo!.id),
    // Silence any in-flight AI playback before the new opening bubble's
    // auto-speak fires.  Without this you can get the old scenario's
    // last reply talking under the new scenario's intro.
    onMutate: () => stopSpeaking(),
    onSuccess: (c) => {
      setConvo(c);
      setTranslations({});
      setFeedbacks({});
      setHints({});
      setRevealedBubbles(new Set());
      setHiddenBubbles(new Set());
      setTeachbackQ(null);
      setTeachbackAnswer("");
      setTeachbackReview(null);
      setTeachbackOpen(false);
    },
  });

  async function translateMessage(idx: number, text: string) {
    // A previous attempt that FAILED is cached as TRANSLATE_FAIL — that
    // must stay retryable (flaky mobile networks fail the first call
    // often). Only a real result short-circuits.
    const cached = translations[idx];
    if (cached != null && cached !== TRANSLATE_FAIL) return;
    setTranslatingIdx(idx);
    try {
      const out = await api.translate(text);
      setTranslations((prev) => ({ ...prev, [idx]: out.text_zh || "（无结果）" }));
    } catch (e) {
      console.error("translate failed", e);
      setTranslations((prev) => ({ ...prev, [idx]: TRANSLATE_FAIL }));
    } finally {
      setTranslatingIdx(null);
    }
  }

  async function fetchFeedback(idx: number) {
    if (!convo || feedbacks[idx]) return;
    setFeedbackBusyIdx(idx);
    try {
      const fb = await api.messageFeedback(convo.id, idx);
      setFeedbacks((prev) => ({ ...prev, [idx]: fb }));
    } catch (e) {
      console.error("feedback failed", e);
    } finally {
      setFeedbackBusyIdx(null);
    }
  }

  async function fetchHint(forIdx: number) {
    if (!convo || hints[forIdx]) return;
    setHintBusy(true);
    try {
      const out = await api.messageHint(convo.id);
      setHints((prev) => ({ ...prev, [forIdx]: out.hint }));
    } catch (e) {
      console.error("hint failed", e);
    } finally {
      setHintBusy(false);
    }
  }

  async function openTeachback() {
    if (!convo) return;
    setTeachbackOpen(true);
    setTeachbackReview(null);
    if (teachbackQ) return;
    setTeachbackBusy(true);
    try {
      const out = await api.teachbackQuestion(convo.id);
      setTeachbackQ(out.question);
    } catch (e) {
      console.error("teachback question failed", e);
      setTeachbackQ("Now in your own words — what was this video about?");
    } finally {
      setTeachbackBusy(false);
    }
  }

  async function submitTeachback() {
    if (!convo || !teachbackAnswer.trim()) return;
    setTeachbackBusy(true);
    try {
      const r = await api.teachbackReview(convo.id, teachbackAnswer.trim());
      setTeachbackReview(r);
    } catch (e) {
      console.error("teachback review failed", e);
    } finally {
      setTeachbackBusy(false);
    }
  }

  // Wraps streaming send so the spinner, live-typing bubble, and final
  // state update all live in one place.  Uses state rather than
  // useMutation because we need the interim onDelta callback.
  async function sendStreaming(content: string) {
    if (!convo || sendingStream) return;
    // Sending a message = user is now focused on the AI dialog.  Pause
    // video so upcoming AI TTS doesn't talk over it.
    interact();
    // Silence whatever AI was still saying — the user has moved on.
    // Without this the previous bubble's TTS keeps playing and
    // collides with the auto-speak that fires on the streaming reply.
    stopSpeaking();
    // Stop any active mic session BEFORE clearing draft — otherwise the
    // still-running SpeechRecognition would re-populate the draft from
    // its rolling window the moment setDraft("") fires, and the 🎤 button
    // would stay stuck in the red ⏹ state.  stopRecognition() detaches
    // onresult before stop() so iOS Safari's delayed final result can't
    // refill the box after we cleared it.
    stopRecognition();
    setSendingStream(true);
    setStreamingText("");
    // Optimistically add the user's message to the bubble feed so they
    // see themselves immediately.
    setConvo({
      ...convo,
      messages: [
        ...convo.messages,
        { role: "user", content, ts: Date.now() / 1000 },
      ],
    });
    setDraft("");
    // iOS Safari belt-and-suspenders: force-clear the DOM value + reset
    // height in case React's controlled sync lags behind the send action.
    if (draftRef.current) {
      draftRef.current.value = "";
      draftRef.current.style.height = "auto";
    }
    try {
      const final = await api.sendMessageStream(convo.id, content, (piece) => {
        setStreamingText((prev) => prev + piece);
      });
      setConvo(final);
      qc.invalidateQueries({ queryKey: ["episodes"] });
    } catch (e) {
      console.error("stream send failed", e);
      // fall back to non-streaming
      try {
        const c = await api.sendMessage(convo.id, content);
        setConvo(c);
      } catch (e2) {
        console.error("fallback send failed", e2);
      }
    } finally {
      setSendingStream(false);
      setStreamingText("");
    }
  }
  // react-query-flavoured shim so existing call sites (send.mutate /
  // send.isPending) keep working with minimal change.
  const send = {
    mutate: (content: string) => { void sendStreaming(content); },
    isPending: sendingStream,
  };
  const redoTurn = useMutation({
    mutationFn: () => api.redoLastTurn(convo!.id),
    // Stop the AI bubble that's currently being read — the user is
    // backing up to redo, listening to the old reply now would be
    // confusing.
    onMutate: () => stopSpeaking(),
    onSuccess: (c) => {
      setConvo(c);
      qc.invalidateQueries({ queryKey: ["episodes"] });
    },
  });

  // Auto-speak new AI messages.  Only the very latest assistant msg, and
  // only if its timestamp hasn't been spoken yet — so navigating away and
  // back doesn't re-read the whole history.
  useEffect(() => {
    if (!autoSpeak || !convo) return;
    const msgs = convo.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const ts = (m as { ts?: number }).ts ?? 0;
      if (ts > lastSpokenTsRef.current) {
        lastSpokenTsRef.current = ts;
        // Auto-speak will start an audio stream — pause the video so it
        // doesn't compete with the AI bubble.
        interact();
        speakText(m.content);
      }
      break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convo, autoSpeak]);

  // Keep scroll pinned to the latest message, including live streaming.
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [convo, streamingText]);

  // Centralized teardown: detach handlers BEFORE stop().
  //
  // iOS Safari fires a final onresult asynchronously *after* rec.stop(),
  // and the closure inside onresult still has a ref to its accumulated
  // `finalText`.  Without nulling the handler first, that delayed event
  // calls setDraft(finalText) right after we cleared it on send → the
  // sent transcript reappears in the input box.  Nulling onresult/onend
  // makes the late event a noop.
  function stopRecognition() {
    const rec = recognitionRef.current;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try { rec.stop(); } catch { /* already stopped */ }
    recognitionRef.current = null;
    setListening(false);
  }

  // Stop any ongoing recognition / speech when leaving the tab.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  function toggleMic() {
    if (listening) {
      // User clicked ⏹ — stop recognition and leave the transcript in
      // the draft box so they can review/edit before clicking 发送.
      stopRecognition();
      return;
    }
    // Starting to speak = pause video so the mic doesn't pick up video
    // audio AND the learner can focus on their own voice.  Also kill
    // any AI-bubble TTS still playing so it doesn't leak into the
    // recording.
    // iOS 主屏 App 里语音识别会挂死整块面板 —— 直接挡掉,给可操作的提示。
    if (isIOSStandalone()) {
      setSttMsg("iOS 把网站装成 App 后不支持语音输入。请在 Safari 里打开网页版用语音，或直接打字。");
      return;
    }
    interact();
    stopSpeaking();
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      setSttMsg("这个浏览器不支持语音识别，换 Chrome 或 Edge 就能用。你也可以直接打字。");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    // continuous=true keeps the session alive through short pauses so the
    // learner can think mid-sentence without the mic cutting them off.
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
      setDraft((finalText + interim).trim());
    };
    rec.onerror = () => {
      setListening(false);
    };
    rec.onend = () => {
      // No auto-send: the learner stops explicitly with ⏹ (or the browser
      // enforces a max session length, ~60s on some browsers).  In both
      // cases the draft is left intact for the learner to review, edit,
      // then click 发送.
      setListening(false);
      recognitionRef.current = null;
    };
    let started = false;
    rec.onstart = () => { started = true; };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      recognitionRef.current = null;
      return;
    }
    // 看门狗：有些 webview 里 start() 不报错、也不真正启动（onstart 永不触发），
    // 录音状态会一直卡着。4 秒没启动就自动收场，别让用户对着假「录音中」发呆。
    window.setTimeout(() => {
      if (!started && recognitionRef.current === rec) {
        try { rec.abort(); } catch { /* ignore */ }
        recognitionRef.current = null;
        setListening(false);
        setSttMsg("这个环境启动不了语音识别，直接打字吧（或到 Safari 里试）。");
      }
    }, 4000);
  }

  if (!convo) {
    // 428 = 还没配自己的 API key。这不是"出错了"，是少了一步设置，所以给
    // 的是一个去设置的入口，不是一个红色报错框。
    if (isByokRequired(start.error)) {
      return <NeedApiKey message={start.error.message} />;
    }
    return (
      <div className="py-6">
        <p className="text-sm text-ink-2 mb-4">
          进入 AI 场景对话：AI 会把你推到必须用本期 Chunk 才能回答的地方。你只需要开口。
        </p>
        <button onClick={() => start.mutate()} className="btn-primary inline-flex items-center gap-1.5">
          {start.isPending ? (
            <>Starting…</>
          ) : (
            <><Microphone size={14} /> Start</>
          )}
        </button>
        {start.isError && (
          <p className="text-xs text-[#b91c1c] mt-3">
            {errorDetail(start.error, "开场失败，请重试")}
          </p>
        )}
      </div>
    );
  }

  const targetChunks = chunks.filter((c) => convo.target_chunks.includes(c.id));
  const lastUserIdx = (() => {
    for (let i = convo.messages.length - 1; i >= 0; i--) {
      if (convo.messages[i].role === "user") return i;
    }
    return -1;
  })();
  // Teach-back is suggested once the learner has used ≥80% of the
  // target chunks — by then they've heard them enough to recombine.
  const teachbackReady =
    targetChunks.length > 0 &&
    convo.chunks_used.length / targetChunks.length >= 0.8;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Single scroll container: scenario card + messages share one scroll
          so on short cards the scenario can scroll out of view instead of
          stealing all the space from the message feed.  Input form stays
          pinned at the bottom via shrink-0. */}
      <div ref={feedRef} className="flex-1 min-h-0 overflow-auto flex flex-col gap-3 pr-1">
      <LessonBriefCard brief={lessonBrief} hasMessages={convo.messages.length > 0} />
      <div className="rounded-xl bg-[#f2f8f4] border border-[#c9dfd0] p-3 shrink-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1.5 text-2xs uppercase tracking-widest text-brand font-bold">
            <Sparkle size={11} /> 场景
          </div>
          <div className="text-2xs text-ink-2">
            目标 chunks · <span className="font-semibold text-ink">{convo.chunks_used.length}</span>
            <span className="text-ink-3"> / {targetChunks.length}</span>
          </div>
        </div>
        <p className="text-xs mt-1.5">{convo.scenario}</p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {targetChunks.map((c) => {
            const used = convo.chunks_used.includes(c.id);
            return (
              <span
                key={c.id}
                className={`inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded-full border ${
                  used
                    ? "bg-[#16a070] text-white border-[#16a070]"
                    : "bg-white border-[#c9dfd0] text-[#2f755f]"
                }`}
              >
                {used && <Check size={10} weight="bold" />}
                {c.text}
              </span>
            );
          })}
        </div>
        <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-[#c9dfd0] text-2xs">
          <button
            onClick={() => {
              const v = !revealAllAI;
              setRevealAllAI(v);
              try {
                if (v) localStorage.setItem("ai-reveal-text", "1");
                else localStorage.removeItem("ai-reveal-text");
              } catch { /* private mode */ }
            }}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded transition-colors duration-150 ease-spring ${
              revealAllAI
                ? "bg-white border border-[#c9dfd0] text-ink"
                : "text-ink-3 hover:text-ink"
            }`}
            title={revealAllAI ? "已显示 AI 原文" : "先用耳朵听"}
          >
            {revealAllAI ? <Eye size={11} /> : <EyeSlash size={11} />}
            {revealAllAI ? "显示原文" : "先靠听"}
          </button>
          <button
            onClick={() => {
              const v = !autoSpeak;
              setAutoSpeak(v);
              try { localStorage.setItem("ai-autospeak", v ? "1" : "0"); } catch { /* private mode */ }
              if (!v) window.speechSynthesis?.cancel();
            }}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded transition-colors duration-150 ease-spring ${
              autoSpeak
                ? "bg-white border border-[#c9dfd0] text-ink"
                : "text-ink-3 hover:text-ink"
            }`}
            title="AI 发言后自动朗读"
          >
            <SpeakerHigh size={11} />
            自动朗读
          </button>
          <div className="ml-auto">
            {/* 会归档当前对话，是不可逆的，所以保留二次确认 —— 只是把
                原生 confirm() 换成内联的，不再阻塞整个页面。 */}
            <ConfirmButton
              onConfirm={() => resetConvo.mutate()}
              confirmLabel="确认换新场景"
              disabled={resetConvo.isPending}
              className="inline-flex items-center gap-1 text-ink-3 hover:text-brand"
              title="归档当前对话并生成新场景"
            >
              {resetConvo.isPending ? (
                <>生成中…</>
              ) : (
                <><ArrowsClockwise size={11} /> 新场景</>
              )}
            </ConfirmButton>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {convo.messages.map((m, i) => {
          const isUser = m.role === "user";
          const isLastUser = isUser && i === lastUserIdx;
          const zh = translations[i];
          // A cached failure must read as "tap to retry", not "已翻译".
          const zhOk = zh != null && zh !== TRANSLATE_FAIL;
          // AI bubble visibility: opening (i=0) always visible, user
          // bubbles always visible.  Non-opening AI bubbles default to
          // hidden; visibility is computed from three sources:
          //   - revealAllAI (global default)
          //   - revealedBubbles (per-bubble opt-in to show)
          //   - hiddenBubbles  (per-bubble opt-out to hide)
          // hiddenBubbles wins over both reveal flags so the learner can
          // re-hide an already-shown bubble.
          const aiHidden =
            !isUser && i !== 0 &&
            (hiddenBubbles.has(i) ||
              (!revealAllAI && !revealedBubbles.has(i)));
          return (
            <div
              key={i}
              className={`flex gap-2 max-w-[90%] ${isUser ? "self-end flex-row-reverse" : ""}`}
            >
              {isUser ? (
                <div className="w-7 h-7 shrink-0 rounded-full grid place-items-center text-2xs font-bold text-white bg-brand">
                  Me
                </div>
              ) : (
                <div
                  className="w-7 h-7 shrink-0 rounded-full grid place-items-center text-2xs font-bold text-white bg-ink"
                  title={aiName}
                >
                  {aiInitials}
                </div>
              )}
              <div className="flex flex-col gap-1">
                {aiHidden ? (
                  <button
                    onClick={() => {
                      setRevealedBubbles((prev) => {
                        const next = new Set(prev);
                        next.add(i);
                        return next;
                      });
                      // Clear any prior hide-override so re-toggling
                      // works predictably next time.
                      setHiddenBubbles((prev) => {
                        if (!prev.has(i)) return prev;
                        const next = new Set(prev);
                        next.delete(i);
                        return next;
                      });
                    }}
                    className="text-left px-3 py-2 rounded-xl text-xs leading-[1.55] bg-[#f0f3f0] text-ink-3 italic hover:text-ink hover:bg-[#eaecee] transition-colors duration-150 ease-spring cursor-pointer inline-flex items-center gap-1.5"
                    title="点击揭晓 AI 原文"
                  >
                    <SpeakerHigh size={12} className="shrink-0" />
                    <span>先用耳朵听 · 点击揭晓文本</span>
                  </button>
                ) : (
                  <div
                    className={`px-3 py-2 rounded-xl text-xs leading-[1.55] ${
                      isUser
                        ? "bg-[#eaf3ec] text-ink border border-[#c9dfd0]"
                        : "bg-[#f0f3f0] text-ink"
                    }`}
                  >
                    {isUser
                      ? highlightChunksInText(m.content, targetChunks)
                      : clickableWordsInText(m.content, (w) => {
                          interact();
                          setWordPopup({ word: w, context: m.content });
                        })}
                  </div>
                )}
                {!isUser && zh && (
                  zhOk ? (
                    <div className="px-3 py-1.5 rounded-xl text-xs text-ink-2 bg-[#f8faf8] border border-line leading-[1.5]">
                      {zh}
                    </div>
                  ) : (
                    <button
                      onClick={() => translateMessage(i, m.content)}
                      className="px-3 py-1.5 rounded-xl text-xs text-brand bg-[#eaf3ec] border border-brand/30 leading-[1.5] hover:bg-[#e2efe6] transition-colors duration-150 ease-spring text-left"
                    >
                      翻译失败，点此重试
                    </button>
                  )
                )}
                <div className={`flex gap-1 text-ink-3 flex-wrap ${isUser ? "justify-end" : ""}`}>
                  {!isUser && (
                    <>
                      <button
                        onClick={() => { interact(); speakText(m.content); }}
                        className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-brand hover:bg-[#eff2ef] transition-colors duration-150 ease-spring"
                        title="朗读"
                        aria-label="朗读"
                      >
                        <SpeakerHigh size={13} />
                      </button>
                      <button
                        onClick={() => { interact(); speakText(m.content, { rate: 0.7 }); }}
                        className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-brand hover:bg-[#eff2ef] transition-colors duration-150 ease-spring"
                        title="慢速朗读"
                        aria-label="慢读"
                      >
                        <Gauge size={13} />
                      </button>
                      <button
                        onClick={() => translateMessage(i, m.content)}
                        disabled={translatingIdx === i}
                        className={`inline-flex items-center justify-center w-6 h-6 rounded transition-colors duration-150 ease-spring ${
                          zhOk ? "text-brand" : "text-ink-3 hover:text-brand hover:bg-[#eff2ef]"
                        } disabled:opacity-50`}
                        title={zhOk ? "已翻译" : "翻译为中文"}
                        aria-label="翻译"
                      >
                        {translatingIdx === i ? (
                          <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                        ) : (
                          <Translate size={13} />
                        )}
                      </button>
                      {/* Hint button only on the last AI message — that's
                          the one the learner is currently stuck on. */}
                      {i === convo.messages.length - 1 && (
                        <button
                          onClick={() => fetchHint(i)}
                          disabled={hintBusy}
                          className={`inline-flex items-center justify-center w-6 h-6 rounded transition-colors duration-150 ease-spring ${
                            hints[i] ? "text-brand" : "text-ink-3 hover:text-brand hover:bg-[#eff2ef]"
                          } disabled:opacity-50`}
                          title={hints[i] ? "已看参考" : "看参考答案"}
                          aria-label="看参考"
                        >
                          {hintBusy ? (
                            <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                          ) : (
                            <Lightbulb size={13} />
                          )}
                        </button>
                      )}
                      {/* Re-hide button: only on non-opening AI bubbles
                          that are currently visible.  Moves the bubble
                          back to the listen-only placeholder state. */}
                      {i !== 0 && !aiHidden && (
                        <button
                          onClick={() => {
                            setHiddenBubbles((prev) => {
                              const next = new Set(prev);
                              next.add(i);
                              return next;
                            });
                            setRevealedBubbles((prev) => {
                              if (!prev.has(i)) return prev;
                              const next = new Set(prev);
                              next.delete(i);
                              return next;
                            });
                          }}
                          className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-brand hover:bg-[#eff2ef] transition-colors duration-150 ease-spring"
                          title="再次隐藏"
                          aria-label="收起"
                        >
                          <EyeSlash size={13} />
                        </button>
                      )}
                    </>
                  )}
                  {isUser && (
                    <button
                      onClick={() => fetchFeedback(i)}
                      disabled={feedbackBusyIdx === i}
                      className={`inline-flex items-center justify-center w-6 h-6 rounded transition-colors duration-150 ease-spring ${
                        feedbacks[i] ? "text-brand" : "text-ink-3 hover:text-brand hover:bg-[#eff2ef]"
                      } disabled:opacity-50`}
                      title={feedbacks[i] ? "已评" : "检查语法 / 表达"}
                      aria-label="反馈"
                    >
                      {feedbackBusyIdx === i ? (
                        <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                      ) : (
                        <Pencil size={13} />
                      )}
                    </button>
                  )}
                  {isLastUser && (
                    <button
                      onClick={() => redoTurn.mutate()}
                      disabled={redoTurn.isPending}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-brand hover:bg-[#eff2ef] transition-colors duration-150 ease-spring disabled:opacity-50"
                      title="撤回重说"
                      aria-label="重说"
                    >
                      {redoTurn.isPending ? (
                        <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                      ) : (
                        <ArrowUUpLeft size={13} />
                      )}
                    </button>
                  )}
                </div>
                {/* Hint card on AI bubble */}
                {!isUser && hints[i] && (
                  <div className="text-xs px-3 py-2 rounded-xl bg-[#fffbe6] border border-[#fde68a] text-ink-2 leading-[1.55]">
                    <div className="text-2xs uppercase tracking-widest text-[#a16207] font-bold mb-1">参考答案</div>
                    {hints[i]}
                  </div>
                )}
                {/* Feedback card on user bubble */}
                {isUser && feedbacks[i] && (
                  <FeedbackCard fb={feedbacks[i]} />
                )}
              </div>
            </div>
          );
        })}
        {sendingStream && (
          <div className="flex gap-2 max-w-[90%]">
            <div className="w-7 h-7 shrink-0 rounded-full grid place-items-center text-2xs font-bold text-white bg-ink">
              AI
            </div>
            <div className="px-3 py-2 rounded-xl text-xs leading-[1.55] bg-[#f0f3f0] text-ink">
              {streamingText || <span className="text-ink-3">思考中…</span>}
              {streamingText && <span className="inline-block w-1.5 h-3 bg-ink-3 ml-0.5 animate-pulse align-middle" />}
            </div>
          </div>
        )}
      </div>
      </div>{/* /single-scroll wrapper */}

      {/* 就地告诉用户为什么麦克风没反应，而不是弹一个系统对话框。
          可关闭 —— 知道了就不用一直占着屏幕。 */}
      {sttMsg && (
        <div className="shrink-0 mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-[#fff7ed] border border-[#fed7aa] text-xs text-[#285e48]">
          <WarningCircle size={13} className="shrink-0 mt-px" />
          <span className="flex-1 min-w-0">{sttMsg}</span>
          <button
            type="button"
            onClick={() => {
              setSttMsg("");
              // 记住"关过"——之后不再主动弹这条提示（点录音的即时提示仍会显示）。
              try { localStorage.setItem("ios-standalone-mic-hint", "1"); } catch { /* ignore */ }
            }}
            className="shrink-0 text-[#285e48]/70 hover:text-[#285e48]"
            aria-label="知道了"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) send.mutate(draft);
        }}
        className="flex gap-2 pt-2 border-t border-line items-end shrink-0"
      >
        <button
          type="button"
          onClick={toggleMic}
          disabled={send.isPending}
          className={`w-10 h-10 shrink-0 rounded-xl grid place-items-center ${
            listening
              ? "bg-red-500 text-white animate-pulse"
              : "bg-[#f0f3f0] hover:bg-[#e8eaee] text-ink"
          }`}
          title={listening ? "停止录音" : "按下开始说话（英文识别）"}
        >
          {listening ? (
            <div className="w-3 h-3 bg-white rounded-sm" />
          ) : (
            <Microphone size={16} />
          )}
        </button>
        <textarea
          ref={(el) => {
            draftRef.current = el;
            // Auto-grow on mount + on value change (incl. STT streaming into draft).
            if (el) {
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 160) + "px";
            }
          }}
          className="input flex-1 !py-2 resize-none overflow-y-auto"
          style={{ minHeight: "2.5rem", maxHeight: "10rem" }}
          rows={1}
          placeholder={listening ? "正在听…" : "说点什么…"}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Inline auto-grow so the textarea expands as content streams in.
            const el = e.target;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 160) + "px";
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (draft.trim() && !send.isPending) send.mutate(draft);
            }
          }}
        />
        <button
          type="submit"
          className="self-end inline-flex items-center justify-center w-10 h-10 rounded-xl bg-brand text-white hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-90"
          disabled={send.isPending || !draft.trim()}
          title="发送"
          aria-label="Send"
        >
          {send.isPending ? (
            <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          ) : (
            <PaperPlaneTilt size={16} weight="bold" />
          )}
        </button>
      </form>

      {/* Teach-back nudge appears once 80%+ chunks are used.  Single
          card keeps it out of the way until then. */}
      {teachbackReady && !teachbackOpen && (
        <button
          onClick={openTeachback}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl bg-[#fff7ed] border border-[#fed7aa] text-[#285e48] font-semibold hover:bg-[#ffedd5]"
        >
          <GraduationCap size={13} />
          用自己的话讲一遍这一集（费曼学习法）
        </button>
      )}

      {teachbackOpen && (
        <div className="rounded-xl bg-[#fff7ed] border border-[#fed7aa] p-3 space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-2xs uppercase tracking-widest text-[#285e48] font-bold">Teach-back · 费曼</span>
            <button
              onClick={() => setTeachbackOpen(false)}
              className="text-xs text-ink-3 hover:text-ink"
            >收起</button>
          </div>
          {teachbackBusy && !teachbackQ ? (
            <div className="text-xs text-ink-2">生成提问中…</div>
          ) : teachbackQ ? (
            <>
              <div className="text-xs text-ink leading-[1.55]">{teachbackQ}</div>
              <textarea
                value={teachbackAnswer}
                onChange={(e) => setTeachbackAnswer(e.target.value)}
                rows={4}
                placeholder="用 3-4 句英文写下你的解释…"
                className="input w-full !py-2 text-xs"
              />
              <div className="flex gap-2">
                <button
                  onClick={submitTeachback}
                  disabled={teachbackBusy || !teachbackAnswer.trim()}
                  className="btn-primary text-xs"
                >
                  {teachbackBusy ? "评估中…" : "提交"}
                </button>
                {teachbackReview && (
                  <button
                    onClick={() => { setTeachbackReview(null); setTeachbackAnswer(""); }}
                    className="btn-ghost text-xs"
                  >再讲一次</button>
                )}
              </div>
              {teachbackReview && (
                <div className="text-xs px-3 py-2 rounded-xl bg-white border border-line text-ink-2 leading-[1.55] space-y-1">
                  <div className="font-semibold text-ink">{teachbackReview.verdict}</div>
                  {teachbackReview.strengths.length > 0 && (
                    <div className="flex items-start gap-1.5">
                      <Check size={12} weight="bold" className="text-[#16a070] shrink-0 mt-0.5" />
                      <span>{teachbackReview.strengths.join("；")}</span>
                    </div>
                  )}
                  {teachbackReview.missed_points.length > 0 && (
                    <div>
                      <div className="inline-flex items-center gap-1.5 text-[#2f755f]">
                        <Pencil size={12} /> 没说到：
                      </div>
                      <ul className="list-disc list-inside ml-1">
                        {teachbackReview.missed_points.map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {teachbackReview.suggestion && (
                    <div className="inline-flex items-start gap-1.5 text-ink-3">
                      <Lightbulb size={12} className="shrink-0 mt-0.5" />
                      <span>{teachbackReview.suggestion}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {wordPopup && (
        <WordPopup
          word={wordPopup.word}
          context={wordPopup.context}
          episodeId={episodeId}
          currentMs={0}
          onClose={() => setWordPopup(null)}
        />
      )}
    </div>
  );
}

// =================================================================
// MAIN PAGE
// =================================================================
export function Learn() {
  const { id } = useParams();
  const epId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  // `?autoplay=1` is set when we navigate here from a collection-loop
  // advance — the next segment should start playing on its own. We latch
  // it into a ref DURING render (not an effect): VjsPlayer fires onReady
  // from an async player.ready() callback, and child effects run before
  // parent effects, so a ref set in render is the only timing-proof way
  // for onReady to see the intent. Stripped from the URL below so a
  // manual refresh doesn't silently auto-play.
  const [searchParams, setSearchParams] = useSearchParams();
  const autoplayOnReadyRef = useRef(false);
  if (searchParams.get("autoplay") === "1") autoplayOnReadyRef.current = true;
  useEffect(() => {
    if (searchParams.get("autoplay") !== "1") return;
    const sp = new URLSearchParams(searchParams);
    sp.delete("autoplay");
    setSearchParams(sp, { replace: true });
  }, [searchParams, setSearchParams]);

  const { data: ep } = useQuery({
    queryKey: ["episode", id],
    queryFn: () => api.episode(epId),
    enabled: !!id,
  });

  // Fetch the sibling list for ANY episode that has a youtube_url — not
  // just legacy collection_kind="full". Highlight-mode multi-segments
  // (N>1 episodes sharing one URL, segment_index/collection_kind unset)
  // are a collection from the learner's POV too; the /collections
  // endpoint already groups by youtube_url. Standalone episodes resolve
  // to a 1-item collection → all the collSize>1 gates below stay false.
  const collectionYoutubeId = ep?.youtube_url
    ? extractYouTubeId(ep.youtube_url)
    : "";
  const { data: collection } = useQuery({
    queryKey: ["collection", collectionYoutubeId],
    queryFn: () => api.collection(collectionYoutubeId),
    enabled: !!collectionYoutubeId,
  });
  // Collection nav — work off the ordered segment list + this episode's
  // index, NOT segment_index arithmetic (highlight-mode segments all
  // carry index 0). Backend sorts segments by (segment_index, id) so the
  // array order is the natural 1→N sequence.
  const collSegs = collection?.segments ?? [];
  const collIndex = ep ? collSegs.findIndex((s) => s.id === ep.id) : -1;
  const collSize = collSegs.length;
  // Wrapping next (collection loop): last → first, for 泛听.
  const collNext =
    collIndex >= 0 && collSize > 1
      ? collSegs[(collIndex + 1) % collSize]
      : undefined;
  // Linear next (manual "下一段" CTA): undefined on the last segment.
  const nextSeg =
    collIndex >= 0 && collIndex < collSize - 1
      ? collSegs[collIndex + 1]
      : undefined;

  // --- 连播队列 ---
  // 合集只在"一个长视频切成多段"时存在，而大部分导入是单段的 —— 单靠合集，
  // 自动连播在几乎所有内容上都不会触发。队列由后端决定：合集 → 话题主线 →
  // 全部已发布，见 routers/playback.py。
  const { data: queue } = useQuery({
    queryKey: ["play-queue", epId],
    queryFn: () => api.playQueue(epId),
    enabled: !!epId,
    staleTime: 5 * 60 * 1000,
  });
  const queueItems = queue?.items ?? [];
  const queueIdx = queue?.current_index ?? -1;
  // 循环：最后一集回到第一集 —— 通勤路上不该在某一集之后突然安静。
  const queueNext =
    queueIdx >= 0 && queueItems.length > 1
      ? queueItems[(queueIdx + 1) % queueItems.length]
      : undefined;
  const queuePrev =
    queueIdx >= 0 && queueItems.length > 1
      ? queueItems[(queueIdx - 1 + queueItems.length) % queueItems.length]
      : undefined;
  const queueLabel =
    queue?.source === "collection" ? "合集顺序播"
      : queue?.source === "anchor" ? "话题主线连播"
      : "全部内容连播";

  // chapters-mode episodes carry AI nav markers. Pure navigation — clicking
  // a chapter seeks the video; it does NOT scope the AI convo or chunks
  // (those stay whole-episode). Empty / skipped for segment-mode episodes.
  const isChaptersMode = ep?.import_mode === "chapters";
  const { data: chapters } = useQuery({
    queryKey: ["chapters", epId],
    queryFn: () => api.episodeChapters(epId),
    enabled: !!id && isChaptersMode,
  });

  // Default to "listen" so the learner is forced to hear the audio
  // before seeing any text — matches the "narrow listening + AI 对话"
  // teaching philosophy. Switching modes is one click.
  const [mode, setMode] = useState<Mode>("listen");
  // Sentence-pattern lesson: AI picks one sentence per episode and gives 4
  // perspective-shifted variants. Lives in ai_metadata.sentence_pattern;
  // null/undefined for older episodes that pre-date this feature. Computed
  // here (before TABS) so the Patterns tab can be gated on its presence.
  type PatternVariant = { text: string; mental_trigger?: string; subject_type?: string; focus: string };
  type SentencePattern = {
    original: string;
    subtitle_idx: number;
    variants: PatternVariant[];
    commentary_zh: string;
  };
  // Pattern produced by on-demand generation (older episodes that predate
  // the feature). Falls into sentencePattern below so the card renders right
  // away without refetching the whole episode. Reset when the episode changes.
  const [localPattern, setLocalPattern] = useState<SentencePattern | null>(null);
  useEffect(() => { setLocalPattern(null); }, [epId]);
  const sentencePattern: SentencePattern | null =
    (ep?.ai_metadata?.sentence_pattern as SentencePattern | null | undefined) ?? localPattern;
  // Any episode with subtitles can have a pattern generated on demand, so the
  // Patterns tab is reachable even before one exists (it shows the generator).
  const canGeneratePattern = (ep?.subtitles?.length ?? 0) > 0;

  // Single tab state for the right card — same on mobile and desktop.
  // Consolidated from the older (rightTab/tab/mobileView) trio.
  type ActiveTab = "subs" | "chunks" | "words" | "patterns" | "ai" | "notes";
  const [activeTab, setActiveTab] = useState<ActiveTab>("subs");
  // Mobile-only: which tab the bottom-sheet picker is showing.
  // The tab strip is hidden on phones to reclaim ~46px of vertical
  // space (see CLAUDE.md). Picker lives in the compact title row.
  const [tabSheetOpen, setTabSheetOpen] = useState(false);
  const TABS: Array<{ k: ActiveTab; label: string; icon: typeof Robot }> = [
    { k: "subs", label: "Subtitles", icon: Translate },
    { k: "chunks", label: "Chunks", icon: Sparkle },
    { k: "words", label: "Words", icon: BookOpen },
    // Rephrase is shown when the episode has a sentence pattern OR can have
    // one generated on demand (the tab then hosts the "换着花样说" generator
    // instead of the card). It used to occupy the AI Chat slot, which is why
    // AI Chat sat hidden between 2026-06-21 and today; both are tabs now.
    ...(sentencePattern || canGeneratePattern
      ? [{ k: "patterns" as ActiveTab, label: "Rephrase", icon: Lightbulb }]
      : []),
    { k: "ai", label: "AI Chat", icon: Robot },
    { k: "notes", label: "Notes", icon: NotePencil },
  ];
  const activeTabMeta = TABS.find((t) => t.k === activeTab) ?? TABS[0];
  // If we land on an episode without a pattern lesson while the Patterns tab
  // is active (e.g. navigating between collection segments), fall back to
  // Subtitles so we don't strand the user on a now-absent tab.
  useEffect(() => {
    if (activeTab === "patterns" && !sentencePattern && !canGeneratePattern) setActiveTab("subs");
  }, [activeTab, sentencePattern, canGeneratePattern]);
  const [expandedChunk, setExpandedChunk] = useState<number | null>(null);
  const [loopOne, setLoopOne] = useState(false);
  // Listen-mode dictation: per-subtitle attempt + result + hint level,
  // in-session (a tab refresh clears progress, that's the lightweight
  // Phase-1 behaviour).
  // Listen-mode (纯听) is input-free now: the only per-line state is
  // whether the learner has revealed the原句. Kept in a Map so it survives
  // a row scroll-out (rows virtualise / unmount).
  type DictState = { revealed: boolean };
  const [dictStore, setDictStore] = useState<Map<number, DictState>>(new Map());
  // Auto-pause at every subtitle end while listen-mode is on. Default
  // true (it's the whole point); persisted so power users can keep it off.
  const [dictAutoPause, setDictAutoPause] = useState<boolean>(() => {
    try { return localStorage.getItem("dict-auto-pause") !== "0"; } catch { return true; }
  });
  const getDict = (id: number): DictState =>
    dictStore.get(id) ?? { revealed: false };
  const patchDict = (id: number, patch: Partial<DictState>) => {
    setDictStore((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? { revealed: false };
      next.set(id, { ...cur, ...patch });
      return next;
    });
  };
  // When the learner clicks 🔁 to replay a line, remember that line's end_ms.
  // YouTube auto-caption cues frequently overlap (a line's start_ms sits
  // *inside* the previous cue's window), so the replay-seek lands in the
  // predecessor's window; one word later the activeSub transition trips the
  // natural-playthrough auto-pause and playback dies after a single word.
  // While currentMs is still before this end_ms we suppress that spurious
  // pause; once it's reached we pause and disarm. Self-heals: any later
  // playthrough past this end_ms clears it.
  const listenReplayEndRef = useRef<number | null>(null);
  // Full-video loop — restarts from the beginning when the video ends.
  // Mutually exclusive with loopOne (single-sentence loop): turning one
  // on auto-disables the other so the two seek loops don't fight.
  // Persisted per-browser so the preference survives refreshes.
  const [loopVideo, setLoopVideoRaw] = useState(() => {
    try { return localStorage.getItem("loop-video") === "1"; } catch { return false; }
  });
  const setLoopVideo = (v: boolean) => {
    setLoopVideoRaw(v);
    try { localStorage.setItem("loop-video", v ? "1" : "0"); } catch { /* private mode */ }
    if (v) { setLoopOne(false); setLoopCollection(false); } // mutex
  };
  // Collection loop — at 段尾, advance to the next segment instead of
  // replaying this one, wrapping back to the first segment (无限循环) for
  // hands-free passive listening (泛听). Only meaningful for multi-segment
  // collections. Mutually exclusive with loopOne / loopVideo. Persisted.
  const [loopCollection, setLoopCollectionRaw] = useState(() => {
    try { return localStorage.getItem("loop-collection") === "1"; } catch { return false; }
  });
  const setLoopCollection = (v: boolean) => {
    setLoopCollectionRaw(v);
    try { localStorage.setItem("loop-collection", v ? "1" : "0"); } catch { /* private mode */ }
    if (v) { setLoopOne(false); setLoopVideo(false); } // mutex
  };
  const [currentMs, setCurrentMs] = useState(0);

  // --- learning segment (chapters-mode only) ---
  // The interval the learner is studying right now. null = play the whole
  // video through, NO auto-pause (default / segment-mode behavior). When
  // set (by clicking an AI chapter chip OR defining a custom range), the
  // video auto-pauses at end_ms so repeated study of one passage doesn't
  // need a manual pause every loop. `label` is for the active-pill text.
  // Persisted per-episode: a learner who picked a passage to drill should
  // find it still selected after closing the tab / leaving the page. Lazy
  // init from localStorage; a useEffect below keeps storage in sync.
  const learnSegKey = `js-learnseg:${epId}`;
  const [learnSeg, setLearnSeg] = useState<
    { start_ms: number; end_ms: number; label: string; chapterId?: number } | null
  >(() => {
    try {
      const raw = localStorage.getItem(`js-learnseg:${epId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (learnSeg) localStorage.setItem(learnSegKey, JSON.stringify(learnSeg));
      else localStorage.removeItem(learnSegKey);
    } catch {
      /* private mode — selection just won't persist, non-fatal */
    }
  }, [learnSeg, learnSegKey]);
  // Re-arm guard: once we auto-pause at end_ms we set this true so the
  // currentMs effect doesn't spam pause() every tick. Cleared when the
  // playhead moves back inside the segment (replay / manual scrub).
  const segPausedRef = useRef(false);
  // Row-range picker: first subtitle tap on the bracket sets the start
  // row (pending); the next tap on any row >= it commits the segment.
  const [rangeStartSub, setRangeStartSub] = useState<Subtitle | null>(null);
  // wordPopup powers both single-word lookup AND the deep ask-in-context
  // flow. mode="word" → existing word lookup; mode="ask" → skip lookup,
  // open straight into the editable ask input pre-filled with `query`.
  const [wordPopup, setWordPopup] = useState<{
    word: string;
    sub?: Subtitle;
    mode?: "word" | "ask";
    query?: string;
  } | null>(null);
  // Chunk-level popup: opened by clicking the small ⓘ icon attached to
  // any chunk highlight in the subtitle stream / ReadingView / NowSpotlight.
  // Word clicks and selection-drag still open WordPopup the way they used
  // to — the ⓘ is a separate hit target inside the chunk's pill.
  const [chunkPopup, setChunkPopup] = useState<Chunk | null>(null);
  const [recorderSub, setRecorderSub] = useState<Subtitle | null>(null);
  const [noteSub, setNoteSub] = useState<Subtitle | null>(null);
  // Floating "📖 解释" button anchored to the user's current text selection
  // inside the subtitle container. Only shown when selection has content.
  const [selectionAnchor, setSelectionAnchor] = useState<{
    text: string;
    sub: Subtitle | null;
    x: number;
    y: number;
  } | null>(null);

  // Imperative handle from the video.js wrapper. We use .seek/.play/.getCurrentTime
  // for row-click + loop-one without ever touching the <video> element directly.
  const playerRef = useRef<VjsPlayerHandle | null>(null);
  const subRowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Horizontal scroller for the AI recommended-segment strip; the hover
  // ‹ › arrows scroll it (native scrollbar is hidden via .no-scrollbar).
  const chapterStripRef = useRef<HTMLDivElement | null>(null);
  const scrollStrip = (dx: number) =>
    chapterStripRef.current?.scrollBy({ left: dx, behavior: "smooth" });
  // Holds the subtitle scroll area so the selection-listener can scope
  // detection to subtitle text only (not the whole page).
  const subsContainerRef = useRef<HTMLDivElement | null>(null);

  // Pause the video when another audio source is about to play (AI TTS,
  // word-lookup TTS, mic capture).  Never auto-resumes — the learner picks
  // up the video again on their own terms.
  const pauseVideo = () => {
    try {
      playerRef.current?.pause();
    } catch { /* handle may not be ready yet */ }
  };

  const segment: AISegment | null = ep?.ai_metadata?.segment ?? null;
  // The video file is itself the AI-picked clip (rebased to 0), so every
  // subtitle row is in-bounds. The old code filtered against absolute
  // source-video timestamps and would hide the entire clip after rebase.
  const visibleSubs = useMemo(() => (ep ? ep.subtitles : []), [ep]);

  // Find active subtitle by matching currentTime against each sub's time range.
  // We also accept the cuechange-based index as a backup, but currentMs is
  // always driven from video.js timeupdate, so this is the primary signal.
  const [activeCueIdx, setActiveCueIdx] = useState<number | null>(null);
  const activeSub = useMemo(() => {
    const byTime = visibleSubs.find((s) => currentMs >= s.start_ms && currentMs < s.end_ms);
    if (byTime) return byTime;
    if (activeCueIdx != null && ep) return ep.subtitles[activeCueIdx];
    return undefined;
  }, [visibleSubs, currentMs, activeCueIdx, ep]);

  // Which chapter the playhead is inside — drives the highlight in the
  // chapter nav strip. Null when not chapters-mode or playhead is in a gap.
  const activeChapterId = useMemo(() => {
    if (!chapters?.length) return null;
    const hit = chapters.find(
      (c) => currentMs >= c.start_ms && currentMs < c.end_ms,
    );
    return hit?.id ?? null;
  }, [chapters, currentMs]);

  // --- single-sentence loop ---
  // Lock the loop target when the toggle flips ON; clear on OFF. Seeking
  // (row-click or keyboard) updates the target to the new sub so we don't
  // hijack the user back to the old one.  Rewind is driven by currentMs,
  // NOT by activeSub transitions — that avoids the old bug where the seek
  // itself caused activeSub to change and triggered a second rewind.
  const loopTargetRef = useRef<Subtitle | null>(null);
  useEffect(() => {
    loopTargetRef.current = loopOne ? activeSub ?? null : null;
    // only re-run when loopOne flips; activeSub changes inside playback
    // must NOT recapture the target (that's what hijacked seeks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopOne]);

  useEffect(() => {
    const target = loopTargetRef.current;
    if (!loopOne || !target) return;
    if (currentMs >= target.end_ms) {
      playerRef.current?.seek(target.start_ms / 1000);
      playerRef.current?.play();
    }
  }, [currentMs, loopOne]);

  // Listen-mode auto-pause: pause + focus the dictation textarea when
  // the current line finishes. Watches `activeSub` *transitions* — when
  // it flips from sub A to anything else, A just expired. The older
  // "currentMs >= activeSub.end_ms" condition was unreachable: activeSub
  // is defined as `currentMs < end_ms` (exclusive), so the instant
  // currentMs reaches end_ms, activeSub has already advanced. Only fires
  // on contiguous transitions where the time delta is small — guards
  // against pausing after a manual seek-forward.
  const prevActiveSubRef = useRef<Subtitle | null>(null);
  useEffect(() => {
    const prev = prevActiveSubRef.current;
    prevActiveSubRef.current = activeSub ?? null;
    if (mode !== "listen" || !dictAutoPause) return;
    if (!prev || prev.id === activeSub?.id) return;
    const replayEnd = listenReplayEndRef.current;
    if (replayEnd !== null) {
      // A 🔁 replay is in flight. Until the playhead reaches the replayed
      // line's end, swallow any boundary crossing (e.g. an overlapping
      // predecessor's window the seek landed in) so playback isn't cut to
      // one word. Once we're at/past that end, pause here and disarm.
      if (currentMs < replayEnd) return;
      listenReplayEndRef.current = null;
      playerRef.current?.pause();
      return;
    }
    // Natural play-through: currentMs sits just past prev.end_ms.
    // 800ms tolerance covers iOS's slower timeupdate cadence (~250ms)
    // while still excluding most user seeks.
    if (currentMs < prev.end_ms || currentMs > prev.end_ms + 800) return;
    playerRef.current?.pause();
  }, [activeSub?.id, mode, dictAutoPause, currentMs]);

  // --- learning-segment auto-pause ---
  // Seek to a segment's start, play, and arm the auto-pause. Used by both
  // chapter-chip clicks and the custom-range "开始学习" / replay (↻).
  const playLearnSeg = useCallback((seg: { start_ms: number; end_ms: number; label: string; chapterId?: number }) => {
    setLearnSeg(seg);
    segPausedRef.current = false;
    playerRef.current?.seek(seg.start_ms / 1000);
    playerRef.current?.play();
  }, []);

  // AI chapter boundaries come from the LLM as raw seconds and don't land
  // on subtitle sentence edges, so a chapter end mid-sentence makes the
  // auto-pause cut a sentence in half. Snap a [startMs,endMs] to whole
  // sentences: start → the sentence in progress at chapter start (its
  // head), end → the sentence in progress at chapter end (its tail, so
  // that last sentence is heard in full). Row-range / custom segments
  // are already sentence-exact and don't go through this.
  const snapToSentences = useCallback(
    (startMs: number, endMs: number) => {
      const subs = visibleSubs;
      if (!subs.length) return { start_ms: startMs, end_ms: endMs };
      const startIdx = subs.findIndex((s) => s.end_ms > startMs);
      if (startIdx === -1) return { start_ms: startMs, end_ms: endMs };
      let endIdx = startIdx;
      for (let i = startIdx; i < subs.length; i++) {
        if (subs[i].start_ms < endMs) endIdx = i;
        else break;
      }
      return {
        start_ms: subs[startIdx].start_ms,
        end_ms: subs[endIdx].end_ms,
      };
    },
    [visibleSubs],
  );

  // Row-range picker. First bracket tap stores the start row; the next
  // tap commits a sentence-precise segment (start row's start_ms → end
  // row's end_ms). Tapping the pending start row again cancels. Order is
  // normalized by seq so picking bottom-then-top still works.
  const pickRangeRow = useCallback(
    (s: Subtitle) => {
      setRangeStartSub((prev) => {
        if (!prev) return s;
        if (prev.id === s.id) return null; // tap start again = cancel
        const a = prev.seq <= s.seq ? prev : s;
        const b = prev.seq <= s.seq ? s : prev;
        playLearnSeg({
          start_ms: a.start_ms,
          end_ms: b.end_ms,
          label: a.seq === b.seq ? `句 ${a.seq}` : `句 ${a.seq}–${b.seq}`,
        });
        return null;
      });
    },
    [playLearnSeg],
  );

  useEffect(() => {
    if (!learnSeg) return;
    // 200ms hysteresis: re-arm only once the playhead is clearly back
    // inside the segment (loop/replay seek or manual scrub-back), so
    // boundary jitter at end_ms doesn't double-fire.
    if (currentMs < learnSeg.end_ms - 200) {
      segPausedRef.current = false;
      return;
    }
    if (currentMs >= learnSeg.end_ms && !segPausedRef.current) {
      segPausedRef.current = true;
      if (loopVideo) {
        // With a segment selected the video never reaches its true end
        // (we stop it at end_ms), so the loop toggle has to loop the
        // SEGMENT here instead of relying on the <video> onEnded path.
        playerRef.current?.seek(learnSeg.start_ms / 1000);
        playerRef.current?.play();
      } else {
        playerRef.current?.pause();
      }
    }
  }, [currentMs, learnSeg, loopVideo]);

  // --- auto scroll active subtitle into view ---
  useEffect(() => {
    if (!activeSub) return;
    const el = subRowRefs.current.get(activeSub.id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeSub?.id]);

  // --- text-selection trigger for ask-in-context ---
  // Detect when the user finishes a selection inside the subtitle area
  // and pop the floating "解释" button. We listen on `pointerup` (covers
  // mouse + touch + pen) and only act if:
  //   1. the selection is non-empty after trimming,
  //   2. both endpoints sit inside subsContainerRef,
  //   3. the selection length is ≤ 200 chars (the LLM endpoint caps at 400
  //      but anything beyond ~30 words is almost never a real question).
  // The anchor lives in component state, not DOM, so it auto-tears-down
  // with the component (no document listeners leaked across episodes).
  useEffect(() => {
    function onPointerUp() {
      // Schedule on the next tick — Safari clears selection mid-pointerup
      // if we read it synchronously inside the event handler.
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setSelectionAnchor(null);
          return;
        }
        const text = sel.toString().trim();
        if (!text || text.length > 200) {
          setSelectionAnchor(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const container = subsContainerRef.current;
        if (!container) return;
        // Both endpoints must be inside the subtitle container — picking
        // up selections from sidebar / nav / video controls would be noise.
        if (
          !container.contains(range.startContainer) ||
          !container.contains(range.endContainer)
        ) {
          setSelectionAnchor(null);
          return;
        }
        // Find the nearest [data-sub-id] ancestor of the selection start
        // so the popup gets the right subtitle context. Falls back to
        // activeSub if the selection straddles two rows (rare).
        let node: Node | null = range.startContainer;
        let subId: number | null = null;
        while (node && node !== container) {
          if (node instanceof HTMLElement) {
            const id = node.getAttribute("data-sub-id");
            if (id) {
              subId = Number(id);
              break;
            }
          }
          node = node.parentNode;
        }
        const sub =
          (subId != null ? ep?.subtitles.find((s) => s.id === subId) : null) ??
          activeSub ??
          null;
        const rect = range.getBoundingClientRect();
        setSelectionAnchor({
          text,
          sub: sub ?? null,
          // Position the button just above the selection, horizontally
          // centered. The popup uses transform translate(-50%, -100%) so
          // (x,y) is the bottom-center anchor.
          x: rect.left + rect.width / 2,
          y: rect.top - 6,
        });
      }, 0);
    }
    document.addEventListener("pointerup", onPointerUp);
    // Clear the anchor whenever the selection collapses for any reason
    // (escape, clicking elsewhere, scrolling causing reset).
    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelectionAnchor(null);
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [ep?.subtitles, activeSub]);

  // --- mark episode as "studied" for the home page's 继续学习 rail ---
  // Fire POST /visit only after the user has been on this episode for
  // ≥5s.  Click-and-bounce shouldn't dirty the rail with random
  // episodes the user immediately backed out of.  Anon users skip —
  // the endpoint requires auth and there's nowhere to surface their
  // history anyway.
  useEffect(() => {
    if (!ep?.id) return;
    if (!currentUser()) return;
    const timer = setTimeout(() => {
      // Fire-and-forget: the visit ping is a UX nicety, not load-bearing.
      // A 401 / 5xx here shouldn't pop an alert at the learner.
      api.recordEpisodeVisit(ep.id).catch(() => { /* swallow */ });
    }, 5000);
    return () => clearTimeout(timer);
  }, [ep?.id]);

  // --- seek helper used by row ▶ button and keyboard shortcuts ---
  const seekToSubtitle = useCallback((sub: Subtitle) => {
    playerRef.current?.seek(sub.start_ms / 1000);
    playerRef.current?.play();
    // If looping is active, move the loop target to the row the user jumped
    // to — they asked to hear THIS one on repeat, not the previous lock.
    if (loopOne) loopTargetRef.current = sub;
  }, [loopOne]);

  // --- keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      // ⌘K / Ctrl+K opens an empty AskPopup so the learner can type any
      // question without having to highlight text first. Allowed inside
      // INPUT/TEXTAREA too — it's a global shortcut, not a typing key.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Pre-fill with the current selection if there is one — saves a
        // step when the user already has the phrase highlighted.
        const sel = window.getSelection()?.toString().trim() ?? "";
        pauseVideo();
        setWordPopup({
          word: sel,
          sub: activeSub,
          mode: "ask",
          query: sel,
        });
        return;
      }
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key.toLowerCase()) {
        case " ": {
          e.preventDefault();
          const p = playerRef.current;
          if (!p) return;
          p.getCurrentTime() != null && (document.querySelector("video")?.paused ? p.play() : p.seek(p.getCurrentTime()!));
          const v = document.querySelector("video");
          if (v) v.paused ? v.play() : v.pause();
          break;
        }
        case "j": {
          const idx = visibleSubs.findIndex((s) => s.id === activeSub?.id);
          if (idx > 0) seekToSubtitle(visibleSubs[idx - 1]);
          break;
        }
        case "k": {
          const idx = visibleSubs.findIndex((s) => s.id === activeSub?.id);
          if (idx >= 0 && idx < visibleSubs.length - 1) seekToSubtitle(visibleSubs[idx + 1]);
          break;
        }
        case "l":
          setLoopOne((v) => {
            const next = !v;
            if (next) { setLoopVideo(false); setLoopCollection(false); } // mutex
            return next;
          });
          break;
        case "r":
          if (activeSub) seekToSubtitle(activeSub);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeSub, visibleSubs, seekToSubtitle]);

  // --- vocabulary set for inline word coloring ---
  // Fetch the user's saved words once.  Mastery 3 = "已掌握" — drop these
  // so the user doesn't keep seeing reminders for words they already know.
  const { data: vocab } = useQuery({
    queryKey: ["vocabulary"],
    queryFn: () => api.listVocabulary({ limit: 200 }).then((r) => r.items),
  });
  const vocabSet = useMemo(
    () => new Set((vocab ?? []).filter((v) => v.mastery < 3).map((v) => v.word.toLowerCase())),
    [vocab],
  );

  // --- user-marked chunks (phrases the AI didn't pick) ---
  // Keyed per episode; rendered like AI chunks but with the brand dotted
  // underline. Grouped by subtitle so a mark only lights up its own line.
  const { data: userChunks } = useQuery({
    queryKey: ["user-chunks", epId],
    queryFn: () => api.userChunks(epId),
    enabled: !!epId,
  });
  const userChunksBySub = useMemo(() => {
    const m = new Map<number, { id: number; text: string }[]>();
    for (const u of userChunks ?? []) {
      const arr = m.get(u.subtitle_id) ?? [];
      arr.push({ id: u.id, text: u.text });
      m.set(u.subtitle_id, arr);
    }
    return m;
  }, [userChunks]);
  const addUserChunk = useMutation({
    mutationFn: (v: { subId: number; text: string }) =>
      api.addUserChunk(epId, v.subId, v.text),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-chunks", epId] }),
  });
  const removeUserChunk = useMutation({
    mutationFn: (id: number) => api.removeUserChunk(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-chunks", epId] }),
  });
  // Chunk favourites — semantically used as the user's "I want to drill
  // this" pile; the /library page surfaces them as the Chunks tab.
  const { data: chunkFavs } = useQuery({
    queryKey: ["favs", "chunk"],
    queryFn: () => api.listFavorites("chunk"),
  });
  const chunkFavSet = useMemo(
    () => new Set((chunkFavs ?? []).map((f) => f.target_id)),
    [chunkFavs],
  );
  const chunkFavToggle = useMutation({
    mutationFn: (chunkId: number) =>
      chunkFavSet.has(chunkId)
        ? api.removeFavorite("chunk", chunkId).then(() => undefined)
        : api.addFavorite("chunk", chunkId).then(() => undefined),
    onMutate: async (chunkId) => {
      await qc.cancelQueries({ queryKey: ["favs", "chunk"] });
      const prev = qc.getQueryData<Array<{ id: number; target_type: string; target_id: number; note: string }>>(["favs", "chunk"]);
      qc.setQueryData<typeof prev>(["favs", "chunk"], (old = []) =>
        chunkFavSet.has(chunkId)
          ? (old ?? []).filter((f) => f.target_id !== chunkId)
          : [...(old ?? []), { id: -chunkId, target_type: "chunk", target_id: chunkId, note: "" }],
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["favs", "chunk"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["favs", "chunk"] }),
  });
  const addNote = useMutation({
    mutationFn: (args: { sub: Subtitle; content: string }) =>
      api.addNote(epId, args.content, args.sub.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notes", epId] }),
  });
  // All notes for this episode (shared cache key with NotesTab). Used to
  // mark which subtitle rows are annotated and to surface a line's
  // existing notes in the per-row note modal.  📖/📝 auto-notes carry a
  // subtitle_id too, so they show up against their line as well.
  const { data: epNotes } = useQuery({
    queryKey: ["notes", epId],
    queryFn: () => api.listNotes({ episode_id: epId }).then((r) => r.items),
    enabled: !!epId,
  });
  const notesBySub = useMemo(() => {
    const m = new Map<number, Note[]>();
    for (const n of epNotes ?? []) {
      if (n.subtitle_id == null) continue;
      const arr = m.get(n.subtitle_id) ?? [];
      arr.push(n);
      m.set(n.subtitle_id, arr);
    }
    return m;
  }, [epNotes]);
  const deleteNote = useMutation({
    mutationFn: (noteId: number) => api.deleteNote(noteId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notes", epId] }),
  });

  // Sentence-pattern save flow: writes a 📝 句式 prefix note so the Library
  // Notes tab + Learn NotesTab render it through SimpleMarkdown like 📖 ones.
  // On-demand pattern generation for older episodes. The system prompt is
  // fixed server-side (it owns the strict JSON contract); learners can tweak
  // this freeform steer, which is appended to the prompt. Prefilled with a
  // sensible default the user can edit or clear.
  const DEFAULT_PATTERN_INSTRUCTION =
    "挑一个对中国学习者最实用、最能换主语迁移的句子，变体要地道自然。";
  const [patternInstruction, setPatternInstruction] = useState(DEFAULT_PATTERN_INSTRUCTION);
  const [patternPromptOpen, setPatternPromptOpen] = useState(false);
  const generatePattern = useMutation({
    mutationFn: () => api.generateSentencePattern(epId, patternInstruction.trim()),
    onSuccess: (res) => {
      if (!res.sentence_pattern) return;
      setLocalPattern(res.sentence_pattern as SentencePattern);
      // A regenerate replaces the card — drop any "saved" state tied to the
      // previous pattern so the 收藏 button reflects the new one.
      setPatternSavedId(null);
      // Keep the cached episode in sync so a remount keeps the generated card.
      qc.setQueryData(["episode", id], (old: typeof ep) =>
        old
          ? { ...old, ai_metadata: { ...(old.ai_metadata ?? {}), sentence_pattern: res.sentence_pattern } }
          : old,
      );
    },
  });

  const [patternSavedId, setPatternSavedId] = useState<number | null>(null);
  const savePatternNote = useMutation({
    mutationFn: () => {
      if (!sentencePattern) throw new Error("no pattern");
      const lines: string[] = [];
      lines.push(`📝 句式: ${sentencePattern.original}`);
      lines.push("");
      lines.push("## 母语者还会这样说");
      lines.push("");
      sentencePattern.variants.forEach((v) => {
        const label = (v.mental_trigger?.trim() && `先想到 ${v.mental_trigger.trim()}`)
          || (v.subject_type?.trim() ?? "");
        lines.push(`**[${label}]** ${v.text}`);
        if (v.focus) lines.push(`> ${v.focus}`);
        lines.push("");
      });
      if (sentencePattern.commentary_zh) {
        lines.push("## 中英视角差");
        lines.push("");
        lines.push(sentencePattern.commentary_zh);
      }
      // Try to attach to the corresponding subtitle so the note shows
      // up in the source-line view; fall back to episode-only if idx
      // doesn't resolve.
      const subId =
        sentencePattern.subtitle_idx > 0
          ? ep?.subtitles.find((s) => s.seq === sentencePattern.subtitle_idx)?.id
          : undefined;
      return api.addNote(epId, lines.join("\n"), subId);
    },
    onSuccess: (note) => {
      setPatternSavedId(note.id);
      qc.invalidateQueries({ queryKey: ["notes", epId] });
    },
  });

  if (!ep) {
    return (
      <Shell hideSearch hideMobileTopBar>
        <div className="text-ink-2 text-sm">loading…</div>
      </Shell>
    );
  }

  return (
    <Shell hideSearch hideMobileTopBar>
      {/* Mobile height = full dynamic viewport minus only what's actually
          outside this container: the main's pt-3 (12px) above + the fixed
          bottom tab bar (64px + safe-area) below. With the top bar gone
          this fills exactly to just above the nav — no dead gap, no
          overlap — and adapts to the home-indicator safe area. */}
      <div className="flex flex-col h-[calc(100dvh-76px-env(safe-area-inset-bottom))] md:h-[calc(100dvh-112px)] md:grid md:grid-cols-[1fr_1.1fr] md:gap-4 md:overflow-hidden">
        {/* Video + meta — mobile: top block (shrink-0) · desktop: left col
            (h-full + min-h-0 so the grid can clamp it to match the right
            card's height, and overflow-hidden keeps long intros from
            pushing past the row). */}
        <div className="shrink-0 flex flex-col gap-2 md:gap-3.5 md:h-full md:min-h-0 md:overflow-hidden">
          {/* Desktop/iPad episode header (md+). Sits above the video so the
              title + ⭐ belong to the episode, not the subtitles panel. On
              mobile this is display:none (not a flex item → no gap); the
              compact row + bottom-sheet on the right card carry it instead. */}
          <div className="hidden md:flex shrink-0 items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 text-2xs text-ink-3">
                {ep.topic && TOPIC_META[ep.topic] && ep.topic !== "other" && (
                  <span className="inline-flex items-center gap-1">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: TOPIC_META[ep.topic].color }}
                    />
                    {TOPIC_META[ep.topic].name}
                  </span>
                )}
                <DifficultyBar n={ep.difficulty} />
                <span className="uppercase tracking-wider text-2xs">{ep.accent}</span>
                <span className="inline-flex items-center gap-1">
                  <Clock size={11} />
                  {fmt(ep.duration_sec * 1000)}
                </span>
              </div>
              <h3 className="text-base font-semibold mt-1 leading-snug line-clamp-2">{ep.title}</h3>
            </div>
            <FavoriteButton targetType="episode" targetId={ep.id} />
          </div>
          {ep.video_url ? (
            <>
              {/* Soft viewport cap so a wide-but-short window can't blow
                  the player past visible height (16:9 stretches with col
                  width).  No longer pinching for a sibling Intro card —
                  Introduction is a modal off the meta bar now. */}
              <div className="md:max-h-[62vh] md:flex md:items-center">
                <VjsPlayer
                  src={ep.video_url}
                  poster={ep.thumbnail_url}
                  vttUrl={`/api/episodes/${ep.id}/subtitles.vtt`}
                  mediaTitle={ep.title}
                  mediaArtist={ep.speaker?.name || "justSpeak"}
                  mediaArtwork={ep.thumbnail_url}
                  onTimeMs={setCurrentMs}
                  onActiveCueIndex={setActiveCueIdx}
                  onNextTrack={() => {
                    const nxt = collNext ?? queueNext;
                    if (nxt) navigate(`/learn/${nxt.id}?autoplay=1`);
                  }}
                  onPrevTrack={() => {
                    const prv = queuePrev;
                    if (prv) navigate(`/learn/${prv.id}?autoplay=1`);
                  }}
                  onReady={(h) => {
                    playerRef.current = h;
                    // Arrived from a collection-loop advance → continue
                    // playback hands-free. A freshly-created <video> element
                    // + an async play() trips the autoplay-with-sound policy
                    // (the play() promise rejects → stays paused). Robust fix:
                    // try with sound first; if that's blocked OR silently
                    // stays paused, restart MUTED (always allowed) and unmute
                    // the instant playback begins (≤1 frame of silence).
                    if (autoplayOnReadyRef.current) {
                      autoplayOnReadyRef.current = false;
                      const player = h.getPlayer();
                      if (player) {
                        const mutedFallback = () => {
                          if (!player.paused()) return; // already playing
                          try { player.muted(true); } catch { /* ignore */ }
                          const pm = player.play();
                          if (pm && typeof (pm as Promise<void>).catch === "function") {
                            (pm as Promise<void>).catch(() => {});
                          }
                          player.one("playing", () => {
                            try { player.muted(false); } catch { /* ignore */ }
                          });
                        };
                        const p = player.play();
                        if (p && typeof (p as Promise<void>).catch === "function") {
                          (p as Promise<void>).catch(mutedFallback);
                        }
                        // Some browsers resolve play() yet keep the element
                        // paused. Re-check shortly; guard on currentTime≈0 so
                        // we never fight a user who paused after it started.
                        window.setTimeout(() => {
                          if (player.paused() && (player.currentTime() ?? 0) < 0.5) {
                            mutedFallback();
                          }
                        }, 350);
                      }
                    }
                  }}
                  // Video starting = the user wants to listen to the
                  // clip, not the AI bubble's TTS.  Silence whatever
                  // ElevenLabs / Web Speech is playing so the two
                  // sources don't compete.
                  onPlay={stopSpeaking}
                  // Full-video loop: when enabled, restart from the
                  // beginning instead of stopping at the end.
                  onEnded={() => {
                    // Collection loop takes priority: advance to the next
                    // segment (wrapping back to the first) for hands-free
                    // passive listening. The next page reads ?autoplay=1.
                    if (loopCollection && (collNext || queueNext)) {
                      // 换的是同一个 <video> 的 src（VjsPlayer 不再重建），
                      // 所以锁屏/后台也能一集接一集地播下去。
                      const nxt = collNext ?? queueNext;
                      if (nxt) {
                        navigate(`/learn/${nxt.id}?autoplay=1`);
                        return;
                      }
                    }
                    if (!loopVideo) return;
                    const p = playerRef.current;
                    if (!p) return;
                    p.seek(0);
                    p.play();
                  }}
                  // A clip with a slightly-corrupt tail (e.g. truncated AAC)
                  // throws a decode error AT THE END instead of firing
                  // `ended`, which would otherwise strand the collection
                  // loop. If we're looping and the error lands near the end,
                  // treat it as end-of-segment and advance (last → first).
                  // Guarded to near-end so a genuinely broken clip can't
                  // spin the whole collection.
                  onError={(info) => {
                    const nxt = collNext ?? queueNext;
                    if (!loopCollection || !nxt) return;
                    const nearEnd =
                      info.duration > 0
                        ? info.currentTime >= info.duration - 3
                        : info.currentTime > 5;
                    if (nearEnd) navigate(`/learn/${nxt.id}?autoplay=1`);
                  }}
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-ink-2 px-1">
                {segment?.source_start != null && segment?.source_end != null && (
                  <span
                    className="inline-flex items-center gap-1 text-ink-3 min-w-0 truncate"
                    title={segment.reason ?? ""}
                  >
                    <Robot size={12} className="shrink-0" />
                    <span className="truncate">
                      AI 选段 {fmt(segment.source_start * 1000)}–{fmt(segment.source_end * 1000)}
                      {segment.full_duration
                        ? ` / 原片 ${fmt(segment.full_duration * 1000)}`
                        : ""}
                    </span>
                  </span>
                )}
                {/* Active learning-segment pill — chapters mode. Shows the
                    range being studied; auto-pauses at its end. ↻ replays
                    the segment, ✕ clears it (back to full playthrough). */}
                {isChaptersMode && learnSeg && (
                  <span className="inline-flex items-center gap-1.5 min-w-0 rounded-full bg-[#eaf3ec] border border-[#cfe3d6] pl-2 pr-1 py-0.5 text-[#285e48]">
                    <Play size={10} weight="bold" className="shrink-0 fill-current" />
                    <span className="font-mono text-2xs shrink-0">
                      {fmt(learnSeg.start_ms)}–{fmt(learnSeg.end_ms)}
                    </span>
                    <span className="truncate max-w-[120px] hidden sm:inline">
                      {learnSeg.label}
                    </span>
                    <button
                      onClick={() => playLearnSeg(learnSeg)}
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-[#cfe3d6]"
                      title="重播这段"
                      aria-label="重播这段"
                    >
                      <ArrowsClockwise size={11} weight="bold" />
                    </button>
                    <button
                      onClick={() => setLearnSeg(null)}
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-[#cfe3d6]"
                      title="取消，恢复整片播放"
                      aria-label="取消学习片段"
                    >
                      <X size={11} weight="bold" />
                    </button>
                  </span>
                )}
                {/* Passive-listening pill — collection loop is armed.
                    Tells the learner the whole 合集 is auto-playing on a
                    loop and where they are in it. */}
                {loopCollection && (collSize > 1 || queueItems.length > 1) && (
                  <span className="inline-flex items-center gap-1.5 min-w-0 rounded-full bg-[#eaf3ec] border border-[#cfe3d6] px-2 py-0.5 text-[#285e48]">
                    <Playlist size={11} weight="bold" className="shrink-0" />
                    <span className="text-2xs shrink-0">
                      {collSize > 1
                        ? `合集顺序播 · 第 ${collIndex + 1}/${collSize} 段`
                        : `${queueLabel} · 第 ${queueIdx + 1}/${queueItems.length} 集`}
                    </span>
                  </span>
                )}
                <div className="flex-1" />
                {/* 连播开关。合集内按段走；不在合集里就按后端给的队列
                    （话题主线 / 全部内容）走，播完绕回第一集。
                    为通勤泛听而做：口袋里没人会去点下一集。 */}
                {(collSize > 1 || queueItems.length > 1) && (
                  <button
                    onClick={() => setLoopCollection(!loopCollection)}
                    className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors duration-150 ease-spring ${
                      loopCollection
                        ? "text-brand bg-[#eaf3ec]"
                        : "text-ink-3 hover:bg-[#eff2ef] hover:text-ink"
                    }`}
                    title={
                      loopCollection
                        ? `关闭连播（当前：${queueLabel}）`
                        : `${queueLabel} · 一集接一集自动播，播完循环`
                    }
                    aria-label={loopCollection ? "关闭连播" : "开启连播"}
                  >
                    <Playlist size={14} weight={loopCollection ? "bold" : "regular"} />
                  </button>
                )}
                <button
                  onClick={() => setLoopVideo(!loopVideo)}
                  className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors duration-150 ease-spring ${
                    loopVideo
                      ? "text-brand bg-[#eaf3ec]"
                      : "text-ink-3 hover:bg-[#eff2ef] hover:text-ink"
                  }`}
                  title={
                    learnSeg
                      ? loopVideo
                        ? "关闭循环（学完该片段会停）"
                        : "循环播放选中的学习片段"
                      : loopVideo
                        ? "关闭整段循环"
                        : "整段循环播放"
                  }
                  aria-label={
                    learnSeg
                      ? loopVideo
                        ? "关闭片段循环"
                        : "循环选中片段"
                      : loopVideo
                        ? "关闭整段循环"
                        : "整段循环播放"
                  }
                >
                  <Repeat size={14} weight={loopVideo ? "bold" : "regular"} />
                </button>
                <HowToButton />
                <IntroButton ep={ep} />
              </div>

              {/* Collection CTA: when this episode is part of a full-video
                  collection, surface the next segment + a link back to the
                  collection index so the learner can flow through the
                  whole video without bouncing back to Home. */}
              {collection && collSize > 1 && collIndex >= 0 && (
                <div className="card p-2.5 md:p-3 bg-[#f4f9f6] border-[#cfe3d6] flex items-center gap-2.5 mt-1">
                  <Link
                    to={`/collection/${collection.youtube_id}`}
                    className="text-2xs text-[#285e48] font-semibold inline-flex items-center gap-1 hover:underline shrink-0"
                  >
                    📚 第 {collIndex + 1} 段 / 共 {collSize}
                  </Link>
                  <div className="flex-1 min-w-0" />
                  {nextSeg ? (
                    <Link
                      to={`/learn/${nextSeg.id}`}
                      className="inline-flex items-center gap-1 text-xs text-ink hover:text-[#285e48] font-medium shrink-0 truncate"
                      title={nextSeg.title}
                    >
                      <span className="truncate hidden sm:inline max-w-[200px]">
                        下一段：{nextSeg.title}
                      </span>
                      <span className="sm:hidden">下一段</span>
                      <CaretRight size={13} weight="bold" />
                    </Link>
                  ) : (
                    <span className="text-2xs text-ink-3 shrink-0">已是最后一段</span>
                  )}
                </div>
              )}

              {/* AI recommended-segment strip (chapters-mode only).
                  Single compact scrolling row — no card wrapper — so the
                  subtitle / NowSpotlight area below keeps its height.
                  Click = study that segment (seek + play + auto-pause at
                  its end via learnSeg). Selected segment = peach; the
                  segment the playhead is merely passing through (no
                  explicit selection) gets a lighter "you are here" tint.
                  Navigation/study only — does NOT scope the AI conversation
                  or chunk list. */}
              {isChaptersMode && chapters && chapters.length > 0 && (
                <div className="relative mt-1 group/strip">
                  <div
                    ref={chapterStripRef}
                    className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pr-7"
                  >
                  <span className="shrink-0 text-2xs text-ink-3 font-medium pr-0.5">
                    AI 片段
                  </span>
                  {chapters.map((c) => {
                    const selected = !!learnSeg && learnSeg.chapterId === c.id;
                    const onHead = !learnSeg && c.id === activeChapterId;
                    return (
                      <button
                        key={c.id}
                        onClick={() => {
                          const snapped = snapToSentences(
                            c.start_ms,
                            c.end_ms,
                          );
                          playLearnSeg({
                            ...snapped,
                            label: c.title_zh || c.title_en,
                            chapterId: c.id,
                          });
                        }}
                        title={c.summary_zh || c.title_en}
                        className={`shrink-0 inline-flex items-center gap-1.5 rounded-full pl-2 pr-2.5 py-1 text-2xs transition-colors duration-150 ease-spring max-w-[200px] ${
                          selected
                            ? "bg-[#eaf3ec] border border-[#cfe3d6] text-[#285e48] font-semibold"
                            : onHead
                              ? "bg-[#f4f9f6] border border-transparent text-ink-2"
                              : "bg-[#f4f5f7] border border-transparent text-ink-2 hover:bg-[#e9ebef]"
                        }`}
                      >
                        <span
                          className={`font-mono text-2xs shrink-0 ${
                            selected ? "text-[#285e48]" : "text-ink-3"
                          }`}
                        >
                          {fmt(c.start_ms)}
                        </span>
                        <span className="truncate">
                          {c.title_zh || c.title_en}
                        </span>
                      </button>
                    );
                  })}
                  </div>
                  {/* Right-edge fade hints "more segments" without a
                      scrollbar. Sits on the page bg (#f5f7f4). */}
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-[#f5f7f4] to-transparent" />
                  {/* Hover ‹ › — desktop only; harmless no-op at the ends. */}
                  <button
                    onClick={() => scrollStrip(-260)}
                    className="hidden md:grid place-items-center absolute -left-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white shadow border border-line text-ink-2 opacity-0 group-hover/strip:opacity-100 transition-opacity hover:text-ink"
                    title="向左"
                    aria-label="向左滚动片段"
                  >
                    <CaretLeft size={14} weight="bold" />
                  </button>
                  <button
                    onClick={() => scrollStrip(260)}
                    className="hidden md:grid place-items-center absolute -right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white shadow border border-line text-ink-2 opacity-0 group-hover/strip:opacity-100 transition-opacity hover:text-ink"
                    title="向右"
                    aria-label="向右滚动片段"
                  >
                    <CaretRight size={14} weight="bold" />
                  </button>
                </div>
              )}

              {/* Desktop-only "Now" spotlight expanded to fill the rest
                  of the left column.  ShadowingPanel was removed (整段
                  跟读 didn't render correctly) — the freed vertical space
                  is now absorbed by NowSpotlight via md:flex-1 so the
                  current line gets generous room to breathe instead of
                  collapsing to ~130px while the column trails empty
                  underneath.  Mobile still skips this — the subtitles
                  tab below the video already covers the same ground. */}
              <div className="hidden md:flex md:flex-1 md:min-h-0">
                <NowSpotlight
                  sub={activeSub}
                  chunks={ep.chunks}
                  currentMs={currentMs}
                  userChunks={activeSub ? userChunksBySub.get(activeSub.id) : undefined}
                  onUserChunkRemove={(id) => removeUserChunk.mutate(id)}
                  onWordClick={(word, sub) => {
                    pauseVideo();
                    setWordPopup({ word, sub });
                  }}
                  onChunkClick={(c) => { pauseVideo(); setChunkPopup(c); }}
                />
              </div>
            </>
          ) : (
            <div className="rounded-xl overflow-hidden bg-[#0b0d17] aspect-video relative grid place-items-center text-ink-3 text-xs">
              <div className="absolute inset-0 bg-gradient-radial from-[#1a1c26] to-[#0b0d17]" />
              <span className="relative">视频文件未提供</span>
            </div>
          )}
        </div>

        {/* Right card — single 5-tab card holds subtitles / chunks / words / AI / notes.
            Mobile: full-width below video.  Desktop: right column, full height. */}
        <div
          className="card overflow-hidden flex flex-col flex-1 min-h-0 md:h-full md:min-h-0"
        >
          {/* Desktop/iPad title bar moved above the video (left column).
              The right card now starts straight at the tab bar on md+. */}

          {/* Mobile-only compact row: [Subtitles ▾]  ⭐ */}
          <div className="md:hidden flex items-center justify-between px-3.5 py-2 border-b border-line">
            <button
              onClick={() => setTabSheetOpen(true)}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink"
              aria-haspopup="menu"
              aria-expanded={tabSheetOpen}
            >
              <activeTabMeta.icon size={15} weight="bold" />
              {activeTabMeta.label}
              <CaretDown size={14} weight="bold" className="text-ink-3" />
            </button>
            <FavoriteButton targetType="episode" targetId={ep.id} />
          </div>

          {/* Mobile bottom-sheet tab picker. Renders an episode header
              (title + meta — which the compact row no longer shows) plus
              the 5 tabs as full-width rows. Tap a row → switch + close. */}
          {tabSheetOpen && (
            <div
              className="md:hidden fixed inset-0 z-50 bg-black/40 flex items-end"
              onClick={() => setTabSheetOpen(false)}
              role="dialog"
              aria-modal="true"
            >
              <div
                className="w-full bg-white rounded-t-2xl pb-[env(safe-area-inset-bottom)] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {/* drag-handle */}
                <div className="flex justify-center pt-2">
                  <div className="w-9 h-1 rounded-full bg-[#dce4dc]" />
                </div>

                {/* Episode header — title + meta dots */}
                <div className="px-5 pt-3 pb-3 border-b border-line">
                  <div className="flex items-center gap-2.5 text-2xs text-ink-3">
                    {ep.topic && TOPIC_META[ep.topic] && ep.topic !== "other" && (
                      <span className="inline-flex items-center gap-1">
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: TOPIC_META[ep.topic].color }}
                        />
                        {TOPIC_META[ep.topic].name}
                      </span>
                    )}
                    <DifficultyBar n={ep.difficulty} />
                    <span className="uppercase tracking-wider text-2xs">{ep.accent}</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} />
                      {fmt(ep.duration_sec * 1000)}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold mt-1 leading-snug">{ep.title}</h3>
                </div>

                {/* Tab rows */}
                <div className="py-1">
                  {TABS.map((t) => {
                    const Icon = t.icon;
                    const isActive = t.k === activeTab;
                    // Only Subtitles + Chunks have a count cheaply at hand
                    // here; the other tabs would need data we haven't
                    // already fetched. Show the count where it's free.
                    const count =
                      t.k === "subs" ? ep.subtitles_count
                      : t.k === "chunks" ? ep.chunks_count
                      : null;
                    return (
                      <button
                        key={t.k}
                        onClick={() => {
                          if (t.k !== activeTab) stopSpeaking();
                          setActiveTab(t.k);
                          setTabSheetOpen(false);
                        }}
                        className={`w-full flex items-center gap-3 px-5 py-3 text-left ${
                          isActive ? "bg-[#f4f9f6]" : "active:bg-[#f5f7f4]"
                        }`}
                        type="button"
                      >
                        <Icon
                          size={18}
                          className={isActive ? "text-brand" : "text-ink-2"}
                        />
                        <span className={`flex-1 text-base ${isActive ? "font-semibold text-ink" : "text-ink"}`}>
                          {t.label}
                        </span>
                        {count != null && count > 0 && (
                          <span className="text-2xs text-ink-3 tabular-nums">
                            {count}
                          </span>
                        )}
                        {isActive && (
                          <Check size={15} weight="bold" className="text-brand" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Desktop 5-tab bar (md+). On mobile this is replaced by the
              bottom sheet that opens from the picker above. */}
          <div className="hidden md:flex border-b border-line overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.k}
                onClick={() => {
                  // Switching tabs = changing focus.  If the AI was
                  // mid-sentence, the new tab shouldn't be a podcast
                  // playing in the background.  Same logic for ⏹
                  // recognition — leaving the AI tab during recording
                  // would silently keep the mic hot.
                  if (t.k !== activeTab) {
                    stopSpeaking();
                  }
                  setActiveTab(t.k);
                }}
                className={`flex-1 min-w-[72px] py-2.5 text-sm font-medium tracking-wide whitespace-nowrap ${
                  activeTab === t.k ? "text-ink border-b-2 border-ink" : "text-ink-2 hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === "subs" && (
            <>
              <div className="flex items-center gap-0.5 px-2.5 py-2 border-b border-line overflow-x-auto">
                {MODES.map((m) => (
                  <button
                    key={m.k}
                    onClick={() => setMode(m.k)}
                    className={`px-3 py-1.5 text-xs rounded-lg whitespace-nowrap font-medium ${
                      mode === m.k ? "bg-ink text-white" : "text-ink-2 hover:bg-[#f0f3f0]"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
                {mode === "listen" && (
                  <label
                    className="ml-2 inline-flex items-center gap-1 text-2xs text-ink-3 cursor-pointer whitespace-nowrap"
                    title="Pause automatically at the end of each line so you can type what you heard"
                  >
                    <input
                      type="checkbox"
                      checked={dictAutoPause}
                      onChange={(e) => {
                        const v = e.target.checked;
                        setDictAutoPause(v);
                        try { localStorage.setItem("dict-auto-pause", v ? "1" : "0"); } catch { /* private mode */ }
                      }}
                      className="w-3 h-3"
                    />
                    Auto-pause
                  </label>
                )}
              </div>
              <div
                ref={subsContainerRef}
                data-subtitle-container="true"
                className="flex-1 overflow-auto px-3.5 py-1.5"
              >
                {mode === "reading" ? (
                  <ReadingView
                    subs={visibleSubs}
                    chunks={ep.chunks}
                    vocabSet={vocabSet}
                    activeId={activeSub?.id ?? null}
                    onSeek={(s) => seekToSubtitle(s)}
                    onWordClick={(word, sub) => {
                      pauseVideo();
                      setWordPopup({ word, sub });
                    }}
                    onChunkClick={(c) => { pauseVideo(); setChunkPopup(c); }}
                    userChunksBySub={userChunksBySub}
                    onUserChunkRemove={(id) => removeUserChunk.mutate(id)}
                    rowRefSetter={(id, el) => {
                      if (el) subRowRefs.current.set(id, el as HTMLDivElement);
                      else subRowRefs.current.delete(id);
                    }}
                  />
                ) : (
                  visibleSubs.map((s) => (
                    <SubRow
                      key={s.id}
                      sub={s}
                      chunks={ep.chunks}
                      mode={mode}
                      vocabSet={vocabSet}
                      active={activeSub?.id === s.id}
                      rowRef={(el) => {
                        if (el) subRowRefs.current.set(s.id, el);
                        else subRowRefs.current.delete(s.id);
                      }}
                      onSeek={() => seekToSubtitle(s)}
                      onCopy={() => {
                        navigator.clipboard.writeText(s.text_en);
                      }}
                      onExplain={() => {
                        pauseVideo();
                        setWordPopup({
                          word: s.text_en,
                          sub: s,
                          mode: "ask",
                          query: s.text_en,
                        });
                      }}
                      onAddNote={() => setNoteSub(s)}
                      noteCount={notesBySub.get(s.id)?.length ?? 0}
                      onWordClick={(word, sub) => {
                        pauseVideo();
                        setWordPopup({ word, sub });
                      }}
                      onChunkClick={(c) => { pauseVideo(); setChunkPopup(c); }}
                      userChunks={userChunksBySub.get(s.id)}
                      onUserChunkRemove={(id) => removeUserChunk.mutate(id)}
                      onRecord={() => {
                        pauseVideo();
                        setRecorderSub(s);
                      }}
                      isLooping={loopOne && loopTargetRef.current?.id === s.id}
                      onToggleLoop={() => {
                        // Toggle per-row: if this row is the current loop
                        // target, turn off.  Otherwise lock onto this row
                        // and seek/play so the loop kicks in immediately.
                        if (loopOne && loopTargetRef.current?.id === s.id) {
                          setLoopOne(false);
                        } else {
                          loopTargetRef.current = s;
                          setLoopOne(true);
                          setLoopVideo(false); // mutex
                          setLoopCollection(false); // mutex
                          seekToSubtitle(s);
                        }
                      }}
                      onRangePick={
                        isChaptersMode ? () => pickRangeRow(s) : undefined
                      }
                      rangePending={isChaptersMode && !!rangeStartSub}
                      rangeRole={
                        !isChaptersMode
                          ? null
                          : rangeStartSub?.id === s.id
                            ? "start"
                            : learnSeg && s.start_ms === learnSeg.start_ms
                              ? "start"
                              : learnSeg && s.end_ms === learnSeg.end_ms
                                ? "end"
                                : null
                      }
                      dict={mode === "listen" ? {
                        revealed: getDict(s.id).revealed,
                        onReplay: () => {
                          // Rewind to this line and play it through. Arm the
                          // replay guard so the auto-pause fires at THIS
                          // line's end even when its start overlaps the prior
                          // cue's window (else playback got cut to one word).
                          listenReplayEndRef.current = s.end_ms;
                          playerRef.current?.seek(s.start_ms / 1000);
                          playerRef.current?.play();
                        },
                        onToggleReveal: () =>
                          patchDict(s.id, { revealed: !getDict(s.id).revealed }),
                      } : undefined}
                    />
                  ))
                )}
                {/* Recap — surfaces when the user reaches the last subtitle
                    so the episode has a clear "finished" moment instead of
                    trailing off. Counts are whatever's already been loaded,
                    so it's essentially free to render. */}
                {activeSub && visibleSubs.length > 0 && activeSub.id === visibleSubs[visibleSubs.length - 1].id && (
                  <EpisodeRecap
                    chunksCount={ep.chunks.length}
                    onOpenWords={() => setActiveTab("words")}
                  />
                )}
              </div>
            </>
          )}

          {activeTab === "words" && (
            <FeaturedWordsPanel
              episodeId={ep.id}
              onJumpToSubtitle={(subId) => {
                const sub = ep.subtitles.find((s) => s.id === subId);
                if (sub) {
                  setActiveTab("subs");
                  seekToSubtitle(sub);
                }
              }}
            />
          )}

          {activeTab === "chunks" && (
            <div className="flex-1 overflow-auto px-3.5 py-2">
              {ep.chunks.length === 0 && (
                <div className="text-sm text-ink-2 py-4 text-center">暂无 Chunks</div>
              )}
              {ep.chunks.map((c) => {
                const open = expandedChunk === c.id;
                const colors: Record<string, string> = {
                  idiomatic: "bg-chunk-1",
                  collocation: "bg-chunk-2",
                  discourse: "bg-chunk-3",
                  functional: "bg-chunk-4",
                  cultural: "bg-chunk-1",
                };
                const exampleSubs = ep.subtitles.filter((s) =>
                  s.text_en.toLowerCase().includes(c.text.toLowerCase()),
                );
                return (
                  <div
                    key={c.id}
                    className={`border-b border-line/50 py-3 cursor-pointer transition-colors duration-150 ease-spring ${
                      open ? "bg-[#f5f7f4]" : "hover:bg-[#f5f7f4]"
                    }`}
                    onClick={() => setExpandedChunk(open ? null : c.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`${colors[c.chunk_type] ?? "bg-chunk-1"} px-2 py-0.5 rounded text-xs font-semibold`}
                      >
                        {c.text}
                      </span>
                      <span className="text-2xs text-ink-3">{c.chunk_type}</span>
                      <span className="ml-auto inline-flex items-center gap-2">
                        <DifficultyBar n={c.difficulty} />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            chunkFavToggle.mutate(c.id);
                          }}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors duration-150 ease-spring active:scale-90 ${
                            chunkFavSet.has(c.id)
                              ? "text-brand hover:bg-[#eaf3ec]"
                              : "text-ink-3 hover:text-brand hover:bg-[#eaf3ec]"
                          }`}
                          aria-label={chunkFavSet.has(c.id) ? "已加入学习本" : "加入学习本"}
                        >
                          {chunkFavSet.has(c.id) ? (
                            <BookmarkSimple size={15} weight="fill" />
                          ) : (
                            <BookmarkSimple size={15} weight="bold" />
                          )}
                        </button>
                      </span>
                    </div>
                    {open && (
                      <div className="mt-2.5 pl-1 text-xs space-y-2">
                        <div>
                          <div className="text-ink-2 font-medium mb-0.5">为什么这么说</div>
                          <div className="text-ink leading-[1.6]">{c.why_explanation}</div>
                        </div>
                        <div>
                          <div className="text-ink-2 font-medium mb-0.5">使用场景</div>
                          <div className="text-ink leading-[1.6]">{c.usage_scenario}</div>
                        </div>
                        {c.similar_expressions.length > 0 && (
                          <div>
                            <div className="text-ink-2 font-medium mb-0.5">相似表达</div>
                            <div className="text-ink">{c.similar_expressions.join(" / ")}</div>
                          </div>
                        )}
                        {c.pronunciation_tip && (
                          <div>
                            <div className="text-ink-2 font-medium mb-0.5">发音提示</div>
                            <div className="text-ink">{c.pronunciation_tip}</div>
                          </div>
                        )}
                        {exampleSubs.length > 0 && (
                          <div>
                            <div className="text-ink-2 font-medium mb-0.5">文中例句</div>
                            {exampleSubs.slice(0, 3).map((s) => (
                              <div
                                key={s.id}
                                className="bg-white border border-line/50 rounded-md p-2 mt-1 cursor-pointer hover:border-brand/30"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveTab("subs");
                                  seekToSubtitle(s);
                                }}
                              >
                                <div className="text-ink text-xs leading-[1.6]">
                                  {highlightChunks(s.text_en, [c])}
                                </div>
                                {s.text_zh && (
                                  <div className="text-ink-2 text-2xs mt-0.5">{s.text_zh}</div>
                                )}
                                <div className="text-2xs text-ink-3 mt-0.5">
                                  {fmt(s.start_ms)} – {fmt(s.end_ms)}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Rephrase (换着花样说) — promoted from a buried Chunks sub-mode
              to its own top-level tab (taking the hidden AI Chat slot).
              Pipeline auto-generates a pattern on import, so most episodes
              show the card right away; the generator below stays available
              either as the first-time CTA (no pattern) or a "再换一句"
              regenerate (has pattern) so the interaction never goes
              invisible. Tab visibility is gated the same way in TABS. */}
          {activeTab === "patterns" && (
            <div className="flex-1 overflow-auto px-3.5 py-3 space-y-3">
              {sentencePattern && (
                <SentencePatternCard
                  pattern={sentencePattern}
                  onSeek={() => {
                    const sub = ep.subtitles.find((s) => s.seq === sentencePattern.subtitle_idx);
                    if (sub) seekToSubtitle(sub);
                  }}
                  onSpeak={(text) => { primeWebSpeech(); primeAudio(); speakText(text); }}
                  onSave={() => {
                    if (!savePatternNote.isPending && patternSavedId === null) {
                      savePatternNote.mutate();
                    }
                  }}
                  savedNoteId={patternSavedId}
                />
              )}

              {/* 第一次生成要等 10-30 秒，而这时候屏幕上除了一个写着
                  "生成中"的按钮什么都没有 —— 等到第 15 秒，它和卡死长得
                  一模一样。已经有卡片的重新生成不给，那时屏幕上有东西看。 */}
              {generatePattern.isPending && !sentencePattern && (
                <div className="py-8">
                  <LoadingCritter
                    label="AI 正在挑一个万能句型…"
                    hint="约 10-30 秒 · 生成后会保存，下次打开直接看"
                  />
                </div>
              )}

              {/* Generate / regenerate controls. DeepSeek picks one sentence
                  + variants on demand; the result is cached server-side. */}
              <div className="rounded-xl bg-[#fff8f4] border border-[#dcebe1] p-3.5">
                {!sentencePattern && (
                  <>
                    <div className="flex items-center gap-2 mb-1.5">
                      <Lightbulb size={16} className="text-brand" />
                      <span className="text-sm font-medium text-ink">换着花样说</span>
                    </div>
                    <p className="text-sm text-ink-2 leading-[1.6]">
                      这一集还没生成「换着花样说」。点下面的按钮，AI 会从字幕里挑一个「换个视角就能换种说法」的万能句型，
                      教你 4 种地道改写。生成一次后会自动保存，下次打开就能直接看。
                    </p>
                  </>
                )}

                <button
                  onClick={() => setPatternPromptOpen((v) => !v)}
                  className={`${sentencePattern ? "" : "mt-3 "}text-xs text-ink-3 hover:text-brand transition-colors duration-150 ease-spring`}
                >
                  {patternPromptOpen ? "▾ 收起生成要求" : "▸ 自定义生成要求（可选）"}
                </button>
                {patternPromptOpen && (
                  <textarea
                    value={patternInstruction}
                    onChange={(e) => setPatternInstruction(e.target.value)}
                    rows={3}
                    placeholder="例如：换一句来讲；多给职场场景的句子；句子短一点"
                    className="mt-2 w-full rounded-lg border border-line/60 bg-white px-3 py-2 text-sm text-ink leading-[1.5] resize-y focus:outline-none focus:border-brand/60"
                  />
                )}

                <button
                  onClick={() => { if (!generatePattern.isPending) generatePattern.mutate(); }}
                  disabled={generatePattern.isPending}
                  className={
                    sentencePattern
                      // Has a card already → quiet secondary "再换一句".
                      ? "mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-white px-3 py-1.5 text-xs font-medium text-brand hover:bg-[#eaf3ec] disabled:opacity-60 transition-colors duration-150 ease-spring"
                      // No card yet → primary CTA.
                      : "mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-60 transition-colors duration-150 ease-spring"
                  }
                >
                  {sentencePattern
                    ? <ArrowsClockwise size={13} />
                    : <Sparkle size={14} />}
                  {generatePattern.isPending
                    ? "生成中…（约 10-30 秒）"
                    : sentencePattern ? "再换一句" : "换个花样说说看"}
                </button>

                {/* 428 是没配 key，给入口不给红框；其余情况把后端带出来的
                    真实原因显示出来——只写「请重试」，遇上重试永远不可能成功
                    的情况就是在骗人。 */}
                {generatePattern.isError && (
                  <div className="mt-2">
                    <LlmCallError
                      error={generatePattern.error}
                      fallback="生成失败，请重试。"
                    />
                  </div>
                )}
                {generatePattern.isSuccess && !sentencePattern && (
                  <p className="mt-2 text-xs text-ink-3">
                    这段字幕没找到合适的万能句型，换一集试试，或调整生成要求重试。
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === "ai" && (
            <div className="p-3 md:p-4 flex-1 min-h-0 overflow-hidden flex flex-col">
              <AITab
                episodeId={ep.id}
                chunks={ep.chunks}
                lessonBrief={ep.lesson_brief ?? null}
                onAIInteract={pauseVideo}
              />
            </div>
          )}
          {activeTab === "notes" && (
            <div className="p-3 md:p-4 flex-1 min-h-0 overflow-hidden flex flex-col">
              <NotesTab episodeId={ep.id} />
            </div>
          )}
        </div>
      </div>
      {wordPopup && (
        <WordPopup
          word={wordPopup.word}
          sub={wordPopup.sub}
          episodeId={ep?.id ?? 0}
          currentMs={currentMs}
          initialMode={wordPopup.mode ?? "word"}
          initialQuery={wordPopup.query}
          onPlayInVideo={(startMs, durationMs) => {
            const p = playerRef.current;
            if (!p) return;
            p.seek(startMs / 1000);
            p.play();
            // Stop after durationMs so the video doesn't run away.
            // Don't change loopOne — the user's previous loop state stays.
            window.setTimeout(() => {
              const v = document.querySelector("video");
              v?.pause();
            }, durationMs);
          }}
          onClose={() => setWordPopup(null)}
        />
      )}
      {chunkPopup && (
        <ChunkPopup
          chunk={chunkPopup}
          subtitles={ep?.subtitles ?? []}
          isFav={chunkFavSet.has(chunkPopup.id)}
          onToggleFav={() => chunkFavToggle.mutate(chunkPopup.id)}
          onSeekToSub={(s) => {
            setChunkPopup(null);
            setActiveTab("subs");
            seekToSubtitle(s);
          }}
          onOpenInChunksTab={() => {
            const id = chunkPopup.id;
            setChunkPopup(null);
            setActiveTab("chunks");
            setExpandedChunk(id);
          }}
          onClose={() => setChunkPopup(null)}
        />
      )}
      {selectionAnchor && (
        // Floating toolbar anchored to the live selection: 解释 (ask in
        // context) + 标记 (save as a personal chunk). Measured on
        // selectionchange; fixed+transform so it tracks the viewport
        // rect while the page scrolls beneath it.
        <div
          onMouseDown={(e) => {
            // Critical: prevent the click from collapsing the selection
            // before our handler can read it. mousedown also runs before
            // the document's selectionchange that would clear the anchor.
            e.preventDefault();
            e.stopPropagation();
          }}
          style={{
            position: "fixed",
            left: selectionAnchor.x,
            top: selectionAnchor.y,
            transform: "translate(-50%, -100%)",
          }}
          className="z-40 inline-flex items-center gap-0.5 p-0.5 rounded-full bg-ink text-white shadow-lg shadow-black/20"
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              const text = selectionAnchor.text.trim();
              const sub = selectionAnchor.sub;
              // Tear down the toolbar + the underlying selection before
              // the popup mounts so the highlighted text isn't still
              // "live" behind the modal.
              setSelectionAnchor(null);
              window.getSelection()?.removeAllRanges();
              pauseVideo();
              setWordPopup({
                word: text,
                sub: sub ?? undefined,
                mode: "ask",
                query: text,
              });
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium hover:bg-white/15 transition-colors duration-150 ease-spring"
          >
            <MagnifyingGlass size={12} weight="bold" /> 解释
          </button>
          {selectionAnchor.sub && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const text = selectionAnchor.text.trim();
                const sub = selectionAnchor.sub;
                if (sub && text) {
                  addUserChunk.mutate({ subId: sub.id, text });
                }
                setSelectionAnchor(null);
                window.getSelection()?.removeAllRanges();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium hover:bg-white/15 transition-colors duration-150 ease-spring border-l border-white/15"
              title="把这个短语标记为我的重点（高亮显示，可随时取消）"
            >
              <Highlighter size={12} weight="bold" /> 标记
            </button>
          )}
        </div>
      )}
      {recorderSub && ep && (
        <SentenceRecorder
          videoUrl={ep.video_url}
          startMs={recorderSub.start_ms}
          endMs={recorderSub.end_ms}
          text={recorderSub.text_en}
          textZh={recorderSub.text_zh}
          onClose={() => setRecorderSub(null)}
        />
      )}
      {noteSub && (
        <NoteModal
          sub={noteSub}
          existingNotes={notesBySub.get(noteSub.id) ?? []}
          onSave={(content) => addNote.mutate({ sub: noteSub, content })}
          onDelete={(noteId) => deleteNote.mutate(noteId)}
          onClose={() => setNoteSub(null)}
        />
      )}
    </Shell>
  );
}

// ============ Note modal ============
//
// Replaces the stock browser window.prompt dialog with an in-app
// modal — same warm palette as WordPopup so note-taking flows feel
// consistent with dictionary lookups and recording.

function NoteModal({
  sub,
  existingNotes,
  onSave,
  onDelete,
  onClose,
}: {
  sub: Subtitle;
  existingNotes: Note[];
  onSave: (content: string) => void;
  onDelete: (noteId: number) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const hasNotes = existingNotes.length > 0;
  // Dock the sheet above the on-screen keyboard so the textarea + Save
  // button aren't hidden when the user starts typing a note on mobile.
  const vp = useVisualViewport();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const v = content.trim();
    if (v) {
      onSave(v);
      setContent(""); // stay open so the new note shows in the list
    }
  }

  return (
    <div
      className="fixed left-0 right-0 bg-ink/35 backdrop-blur-[2px] z-50 flex items-end md:items-center justify-center p-0 md:p-6"
      style={{ top: vp.offsetTop, height: vp.height }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full md:max-w-2xl rounded-t-2xl md:rounded-2xl bg-white border border-[#dcebe1] shadow-xl shadow-[#00000014] overflow-hidden flex flex-col max-h-full md:max-h-[80vh]"
      >
        <div className="px-5 pt-4 pb-3 flex items-start gap-3 border-b border-[#dcebe1] bg-gradient-to-b from-[#f4f9f6] to-[#fafcfa] shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-2xs uppercase tracking-[0.12em] text-ink-3 font-semibold mb-0.5">
              {hasNotes ? `字幕 #${sub.seq} 的笔记 · ${existingNotes.length}` : `为字幕 #${sub.seq} 添加笔记`}
            </div>
            <div className="text-base text-ink leading-[1.5] truncate">{sub.text_en}</div>
            {sub.text_zh && (
              <div className="text-xs text-ink-3 leading-[1.5] mt-0.5 truncate">{sub.text_zh}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 grid place-items-center rounded-lg text-ink-3 hover:bg-white hover:text-ink transition-colors duration-150 ease-spring -mr-1 -mt-0.5 shrink-0"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {hasNotes && (
            <div className="px-5 pt-4 pb-1 flex flex-col">
              {existingNotes.map((n) => {
                const { isMd, title, body } = parseNote(n.content);
                // The modal header already shows this line, so a title
                // that's just the (whole-sentence) context is noise —
                // suppress it when it overlaps the subtitle text.
                const norm = (s: string) =>
                  s.toLowerCase().replace(/[^a-z0-9一-龥]/g, "");
                const tN = norm(title);
                const sN = norm(sub.text_en);
                const dupTitle =
                  tN.length > 12 && (sN.includes(tN) || tN.includes(sN));
                const showTitle = !!title && !dupTitle;
                return (
                  <div
                    key={n.id}
                    className="py-3.5 border-b border-line/60 last:border-0"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        {showTitle && (
                          <div className="text-sm font-semibold text-ink leading-[1.45] break-words line-clamp-2">
                            {title}
                          </div>
                        )}
                        {body && (
                          isMd ? (
                            <div className="mt-1">
                              <SimpleMarkdown text={body} />
                            </div>
                          ) : (
                            <p className="text-sm text-ink-2 leading-[1.65] whitespace-pre-wrap mt-0.5 break-words">
                              {body}
                            </p>
                          )
                        )}
                        {n.created_at && (
                          <div
                            className="text-2xs text-ink-3 mt-1.5"
                            title={new Date(n.created_at).toLocaleString()}
                          >
                            {timeAgo(n.created_at)}
                          </div>
                        )}
                      </div>
                      <ConfirmButton
                        onConfirm={() => onDelete(n.id)}
                        className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-ink-3 hover:text-brand hover:bg-[#eaf3ec] transition-colors duration-150 ease-spring"
                        title="删除这条笔记"
                      >
                        <X size={14} />
                      </ConfirmButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="px-5 py-4">
            {hasNotes && (
              <div className="text-2xs text-ink-3 font-medium mb-1.5">再加一条</div>
            )}
            <textarea
              autoFocus={!hasNotes}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
              }}
              placeholder="写下你对这句话的理解、联想、记不住的点…"
              rows={hasNotes ? 3 : 4}
              className="w-full rounded-xl bg-white border border-line px-3 py-2 text-lg md:text-sm leading-[1.55] outline-none focus:border-ink resize-none"
            />
            <div className="text-2xs text-ink-3 mt-1.5 text-right">
              {content.length > 0 ? `${content.length} 字 · ⌘/Ctrl+Enter 保存` : ""}
            </div>
          </div>
        </div>

        <div className="px-5 pb-5 pt-2 flex items-center gap-2 border-t border-[#dcebe1] shrink-0">
          <button
            type="submit"
            disabled={!content.trim()}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand/90 disabled:opacity-50 transition-colors duration-150 ease-spring"
          >
            保存笔记
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl text-sm text-ink-2 hover:bg-[#f0f3f0]"
          >
            完成
          </button>
        </div>
      </form>
    </div>
  );
}

// =================================================================
// Tiny Markdown renderer — covers exactly the subset our explain-in-context
// endpoint emits: H2 headers, bold, bullet lists, fenced code blocks, plain
// paragraphs. We avoid pulling a dep (react-markdown + rehype + remark =
// ~80kb gzipped); the LLM output is structured enough that a 60-line
// reducer beats the bundle cost. If we ever need full GFM (tables, links,
// nested lists), swap this for react-markdown.
// =================================================================
function SimpleMarkdown({ text }: { text: string }) {
  type Block =
    | { kind: "h2"; text: string }
    | { kind: "h3"; text: string }
    | { kind: "code"; text: string }
    | { kind: "ul"; items: string[] }
    | { kind: "ol"; items: string[] }
    | { kind: "hr" }
    | { kind: "p"; text: string };

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    const lines = text.replace(/\r/g, "").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // fenced code block ``` ... ```
      if (/^```/.test(line)) {
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing ```
        out.push({ kind: "code", text: buf.join("\n") });
        continue;
      }
      // horizontal rule: a line of only ---, ***, or ___ (3+)
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        out.push({ kind: "hr" });
        i++;
        continue;
      }
      // A bare heading marker with no text (the explain LLM emits lone
      // "###" as a section separator between chunks) — render it as a
      // divider instead of the literal "###".
      if (/^#{1,6}\s*$/.test(line)) {
        out.push({ kind: "hr" });
        i++;
        continue;
      }
      // headers (### / ## / single #)
      if (/^###\s+/.test(line)) {
        out.push({ kind: "h3", text: line.replace(/^###\s+/, "") });
        i++;
        continue;
      }
      if (/^##\s+/.test(line)) {
        out.push({ kind: "h2", text: line.replace(/^##\s+/, "") });
        i++;
        continue;
      }
      if (/^#\s+/.test(line)) {
        out.push({ kind: "h2", text: line.replace(/^#\s+/, "") });
        i++;
        continue;
      }
      // ordered list (consume contiguous "N. " lines)
      if (/^\d{1,2}\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d{1,2}\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\d{1,2}\.\s+/, ""));
          i++;
        }
        out.push({ kind: "ol", items });
        continue;
      }
      // bullet list (consume contiguous - lines)
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*]\s+/, ""));
          i++;
        }
        out.push({ kind: "ul", items });
        continue;
      }
      // blank line — skip
      if (!line.trim()) {
        i++;
        continue;
      }
      // paragraph (consume contiguous non-empty non-special lines)
      const buf: string[] = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#|```|[-*]\s|\d{1,2}\.\s)/.test(lines[i]) &&
        !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push({ kind: "p", text: buf.join(" ") });
    }
    return out;
  }, [text]);

  // Inline: **bold** and `code`. No links/images — LLM doesn't emit them.
  const renderInline = (s: string) => {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(s)) != null) {
      if (m.index > last) parts.push(<span key={key++}>{s.slice(last, m.index)}</span>);
      const tok = m[0];
      if (tok.startsWith("**")) {
        parts.push(<b key={key++} className="font-semibold text-ink">{tok.slice(2, -2)}</b>);
      } else {
        parts.push(
          <code key={key++} className="px-1 py-0.5 rounded bg-[#eaf3ec] text-xs text-[#285e48] font-mono">
            {tok.slice(1, -1)}
          </code>,
        );
      }
      last = re.lastIndex;
    }
    if (last < s.length) parts.push(<span key={key++}>{s.slice(last)}</span>);
    return parts;
  };

  return (
    <div className="space-y-3 text-base leading-[1.7] text-ink">
      {blocks.map((b, i) => {
        if (b.kind === "h2") {
          return (
            <h3 key={i} className="text-base font-bold text-ink mt-4 first:mt-0 border-b border-[#dcebe1] pb-1">
              {renderInline(b.text)}
            </h3>
          );
        }
        if (b.kind === "h3") {
          return <h4 key={i} className="text-sm font-semibold text-ink-2 mt-3">{renderInline(b.text)}</h4>;
        }
        if (b.kind === "code") {
          return (
            <pre key={i} className="px-3 py-2.5 rounded-lg bg-[#f4f9f6] border border-[#dcebe1] text-sm text-ink-2 font-mono whitespace-pre-wrap leading-[1.65] overflow-x-auto">
              {b.text}
            </pre>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul key={i} className="space-y-1 pl-1">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="text-brand mt-0.5 select-none">·</span>
                  <span className="flex-1">{renderInline(it)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol key={i} className="space-y-1 pl-1">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="text-brand font-semibold mt-0.5 select-none tabular-nums">
                    {j + 1}.
                  </span>
                  <span className="flex-1">{renderInline(it)}</span>
                </li>
              ))}
            </ol>
          );
        }
        if (b.kind === "hr") {
          return <hr key={i} className="border-0 border-t border-[#dcebe1] my-4" />;
        }
        return <p key={i}>{renderInline(b.text)}</p>;
      })}
    </div>
  );
}


// =================================================================
// ChunkPopup — modal showing a chunk's full explanation. Opened by
// the small ⓘ icon attached to each chunk highlight in the subtitle
// stream. Word clicks and selection-drag still go to WordPopup, so
// the three interactions (look up word, ask about phrase, see chunk
// explanation) stay distinct and discoverable.
// =================================================================
function ChunkPopup({
  chunk,
  subtitles,
  isFav,
  onToggleFav,
  onSeekToSub,
  onOpenInChunksTab,
  onClose,
}: {
  chunk: Chunk;
  subtitles: Subtitle[];
  isFav: boolean;
  onToggleFav: () => void;
  onSeekToSub: (sub: Subtitle) => void;
  onOpenInChunksTab: () => void;
  onClose: () => void;
}) {
  const colors: Record<string, string> = {
    idiomatic: "bg-chunk-1",
    collocation: "bg-chunk-2",
    discourse: "bg-chunk-3",
    functional: "bg-chunk-4",
    cultural: "bg-chunk-1",
  };
  const exampleSubs = subtitles.filter((s) =>
    s.text_en.toLowerCase().includes(chunk.text.toLowerCase()),
  );
  return (
    <div
      className="fixed inset-0 bg-ink/35 backdrop-blur-[2px] z-50 grid place-items-center p-4 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[90vh] flex flex-col rounded-2xl bg-[#fafcfa] border border-[#dcebe1] shadow-xl shadow-[#00000014] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-start gap-3 border-b border-[#dcebe1] bg-gradient-to-b from-[#f4f9f6] to-[#fafcfa]">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`${colors[chunk.chunk_type] ?? "bg-chunk-1"} px-2 py-0.5 rounded text-base font-bold`}
              >
                {chunk.text}
              </span>
              <span className="text-2xs text-ink-3">{chunk.chunk_type}</span>
              <DifficultyBar n={chunk.difficulty} />
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0 -mr-1 -mt-0.5">
            <button
              onClick={onToggleFav}
              className={`w-8 h-8 grid place-items-center rounded-lg transition-colors duration-150 ease-spring ${
                isFav ? "text-brand bg-white" : "text-ink-2 hover:bg-white hover:text-brand"
              }`}
              title={isFav ? "已加入学习本" : "加入学习本"}
              aria-label={isFav ? "已加入学习本" : "加入学习本"}
            >
              {isFav ? (
                <BookmarkSimple size={16} weight="fill" />
              ) : (
                <BookmarkSimple size={16} weight="bold" />
              )}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 grid place-items-center rounded-lg text-ink-2 hover:bg-white hover:text-ink transition-colors duration-150 ease-spring"
              title="关闭"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-3 text-sm">
          {chunk.why_explanation && (
            <section>
              <div className="text-ink-2 font-semibold mb-1">为什么这么说</div>
              <div className="text-ink leading-[1.65]">{chunk.why_explanation}</div>
            </section>
          )}
          {chunk.usage_scenario && (
            <section>
              <div className="text-ink-2 font-semibold mb-1">使用场景</div>
              <div className="text-ink leading-[1.65]">{chunk.usage_scenario}</div>
            </section>
          )}
          {chunk.similar_expressions?.length > 0 && (
            <section>
              <div className="text-ink-2 font-semibold mb-1">相似表达</div>
              <div className="text-ink leading-[1.65]">
                {chunk.similar_expressions.join(" / ")}
              </div>
            </section>
          )}
          {chunk.pronunciation_tip && (
            <section>
              <div className="text-ink-2 font-semibold mb-1">发音提示</div>
              <div className="text-ink leading-[1.65]">{chunk.pronunciation_tip}</div>
            </section>
          )}
          {exampleSubs.length > 0 && (
            <section>
              <div className="text-ink-2 font-semibold mb-1">文中例句</div>
              <div className="space-y-1.5">
                {exampleSubs.slice(0, 3).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onSeekToSub(s)}
                    className="block w-full text-left bg-white border border-line/60 rounded-md p-2 hover:border-brand/40 transition-colors duration-150 ease-spring"
                  >
                    <div className="text-ink leading-[1.6]">{highlightChunks(s.text_en, [chunk])}</div>
                    {s.text_zh && (
                      <div className="text-2xs text-ink-2 leading-[1.5] mt-0.5">
                        {s.text_zh}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="shrink-0 border-t border-[#dcebe1] px-5 py-3 flex items-center justify-between gap-2 bg-[#f7fbf8]">
          <button
            onClick={onOpenInChunksTab}
            className="text-xs text-brand hover:underline inline-flex items-center gap-1"
          >
            🎯 在 Chunks 列表里完整学习
            <CaretRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}


// =================================================================
// WordPopup — click-to-lookup modal with Save to vocab book
// =================================================================
function WordPopup({
  word,
  sub,
  context,
  episodeId,
  currentMs,
  onPlayInVideo,
  onClose,
  // Optional: when the popup was opened from a phrase / sentence selection
  // (not a single-word click), we skip the word-lookup section entirely
  // and go straight into the AskInContext flow with the highlighted text
  // pre-filled in the editable input.
  initialMode = "word",
  initialQuery,
}: {
  word: string;
  // For subtitle clicks we have the full Subtitle; for AI-bubble clicks
  // we only have plain text + can't play-in-video, so sub is optional.
  sub?: Subtitle;
  context?: string;
  episodeId: number;
  currentMs: number;
  onPlayInVideo?: (startMs: number, durationMs: number) => void;
  onClose: () => void;
  initialMode?: "word" | "ask";
  initialQuery?: string;
}) {
  const qc = useQueryClient();
  // Keep the modal docked above the on-screen keyboard (the 解释 textarea
  // auto-focuses on mobile) so the input + 解释 button stay reachable.
  const vp = useVisualViewport();
  const normalised = word.replace(/[^A-Za-z'-]/g, "").toLowerCase();
  const effectiveContext = sub?.text_en ?? context ?? "";
  const cacheKey = sub?.id ?? `ctx:${effectiveContext.slice(0, 40)}`;

  // Find this word's start_ms inside the subtitle's word_timings.  Some
  // words appear several times in one row ("the ... the ..."); pick the
  // occurrence whose start_ms is closest to the current playback time —
  // that's almost certainly the one the user just clicked.
  const wordTimeMs: number | null = (() => {
    const wts = sub?.word_timings;
    if (!wts || !wts.length) return null;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const [w, t] of wts) {
      if (w.replace(/[^A-Za-z'-]/g, "").toLowerCase() !== normalised) continue;
      const d = Math.abs(t - currentMs);
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    return best;
  })();

  const { data, isLoading, error } = useQuery({
    queryKey: ["word-lookup", normalised, cacheKey],
    queryFn: () => api.lookupWord(normalised, effectiveContext),
    enabled: !!normalised,
    staleTime: 1000 * 60 * 30,
  });

  // Check whether this word is already in the learner's vocabulary so we
  // can show "已在生词本" instead of the add button.  Uses the same cache
  // as /library so savings are instant across pages.
  const { data: vocabList } = useQuery({
    queryKey: ["vocabulary", null],
    queryFn: () => api.listVocabulary({ limit: 200 }).then((r) => r.items),
    staleTime: 1000 * 60,
  });
  const alreadySaved = !!vocabList?.some(
    (v) => v.word.toLowerCase() === normalised,
  );

  const addMut = useMutation({
    mutationFn: () =>
      api.addVocabulary({
        word: normalised,
        ipa: data?.ipa ?? "",
        definition_en: data?.definition_en ?? "",
        definition_zh: data?.definition_zh ?? "",
        example: data?.example ?? "",
        context_episode_id: episodeId,
        context_subtitle_id: sub?.id ?? null,
        context_text: effectiveContext,
      }),
    onSuccess: () => {
      // Keep popup open so the learner can keep reading / listening.
      // Button flips to "已加入生词本" via alreadySaved below once the
      // vocabulary list refetches.
      qc.invalidateQueries({ queryKey: ["vocabulary"] });
    },
  });
  // After a successful add, the ["vocabulary", null] query refetches and
  // alreadySaved becomes true — button automatically flips.  Locally
  // track isSuccess for the brief window before the refetch lands.
  const savedNow = addMut.isSuccess || alreadySaved;

  // ----- Ask-in-context (deep, video-grounded explanation) -----
  // Distinct from the quick word lookup above — this calls a slower
  // (5-10s) endpoint that produces a Markdown explanation tailored to
  // what the speaker is actually doing in this scene. Triggered by the
  // "📖 详细解释" button OR by opening the popup with initialMode="ask".
  // The selected text is CONTEXT, not the question — it's shown as a chip
  // and never echoed into the input. The input is the user's (optional)
  // question about it. Empty input + a context = "just explain this".
  const [askContext, setAskContext] = useState(initialQuery ?? "");
  const [askQuery, setAskQuery] = useState("");
  const [askMode, setAskMode] = useState<"word" | "ask">(initialMode);
  const [askMd, setAskMd] = useState<string | null>(null);
  const [ctxExpanded, setCtxExpanded] = useState(false);
  const [savedNoteId, setSavedNoteId] = useState<number | null>(null);
  const askTaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = askTaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [askQuery, askMode]);

  // Combine the selected context + the user's question into one prompt.
  // Backend explainInContext is unchanged (it also grounds on sub.id).
  function buildQuery(extraQ?: string): string {
    const ctx = askContext.trim();
    const q = (extraQ ?? askQuery).trim();
    if (ctx && q) return `关于「${ctx}」：${q}`;
    if (q) return q;
    return ctx; // empty input → explain the selection itself
  }
  const askMut = useMutation({
    mutationFn: (query: string) =>
      api.explainInContext(query.trim(), episodeId, sub?.id ?? null),
    onSuccess: (res) => {
      setAskMd(res.markdown);
      setSavedNoteId(null); // a new explanation resets the saved-state
    },
  });
  const saveNoteMut = useMutation({
    mutationFn: () => {
      // Prefix the saved note so it's findable in /favorites or /library.
      // The title is a glanceable LABEL, not the full context — baking the
      // whole sentence in made the note render as a giant duplicate
      // heading (the line is already shown via the linked subtitle).
      // Prefer the user's question; else a short slice of the context.
      const q = askQuery.trim();
      const ctx = askContext.trim();
      const rawLabel = q || ctx || "解释";
      const label =
        rawLabel.length > 24 ? `${rawLabel.slice(0, 24).trim()}…` : rawLabel;
      const header = `📖 ${label}`;
      const body = askMd ?? "";
      return api.addNote(episodeId, `${header}\n\n${body}`, sub?.id ?? undefined);
    },
    onSuccess: (note) => {
      setSavedNoteId(note.id);
      qc.invalidateQueries({ queryKey: ["notes", episodeId] });
    },
  });
  function runAsk(extraQ?: string) {
    const query = buildQuery(extraQ);
    if (!query || askMut.isPending) return;
    askMut.mutate(query);
  }

  function speakTTS() {
    if (!normalised) return;
    // 单词也走学员配的声音。以前这里强制走浏览器机器音省钱，但现在花的
    // 是学员自己的额度 —— 而且单词恰恰是最该听清发音的地方。
    speakText(normalised, { rate: 0.9 });
  }

  function playInVideo() {
    if (wordTimeMs == null) return;
    // Slightly back off so the consonant onset isn't clipped, and play
    // ~700 ms which is enough to clearly hear most words.
    onPlayInVideo?.(Math.max(0, wordTimeMs - 60), 700);
  }

  // Word-lookup section makes sense only when the user clicked a single
  // word AND the popup opened in word mode. For ask-mode openings (phrase
  // / sentence selection / ⌘K), suppress the lookup entirely; the asked
  // string isn't a valid lookup target and would just produce noise.
  const showWordLookup = askMode === "word" && !!normalised;

  return (
    <div
      className="fixed left-0 right-0 bg-ink/35 backdrop-blur-[2px] z-50 flex items-end justify-center md:grid md:place-items-center p-0 md:p-6"
      style={{ top: vp.offsetTop, height: vp.height }}
      onClick={onClose}
    >
      <div
        className={`w-full ${askMd ? "max-w-2xl" : "max-w-md"} max-h-full md:max-h-[90vh] flex flex-col rounded-t-2xl md:rounded-2xl bg-[#fafcfa] border border-[#dcebe1] shadow-xl shadow-[#00000014] overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — warm off-white bar holding word/title + action icons */}
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-start gap-3 border-b border-[#dcebe1] bg-gradient-to-b from-[#f4f9f6] to-[#fafcfa]">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              {showWordLookup ? (
                <>
                  <h3 className="text-xl font-bold text-ink tracking-tight">{normalised}</h3>
                  {data?.ipa && (
                    <span className="text-sm text-[#285e48] font-mono">{data.ipa}</span>
                  )}
                </>
              ) : (
                <h3 className="text-lg font-semibold text-ink tracking-tight flex items-center gap-2">
                  <MagnifyingGlass size={15} weight="bold" className="text-brand" />
                  在视频里详细解释
                </h3>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0 -mr-1 -mt-0.5">
            {showWordLookup && (
              <button
                onClick={speakTTS}
                className="w-8 h-8 grid place-items-center rounded-lg text-ink-2 hover:bg-white hover:text-brand transition-colors duration-150 ease-spring"
                title="标准发音 (US)"
                aria-label="发音"
              >
                <SpeakerHigh size={16} />
              </button>
            )}
            {showWordLookup && wordTimeMs != null && onPlayInVideo && (
              <button
                onClick={playInVideo}
                className="w-8 h-8 grid place-items-center rounded-lg text-ink-2 hover:bg-white hover:text-brand transition-colors duration-150 ease-spring"
                title="在原片中听这个词"
                aria-label="原片发音"
              >
                <Playlist size={16} />
              </button>
            )}
            <button
              onClick={onClose}
              className="w-8 h-8 grid place-items-center rounded-lg text-ink-3 hover:bg-white hover:text-ink transition-colors duration-150 ease-spring"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body — scrollable so long Markdown answers don't overflow viewport */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {showWordLookup && (
            <>
              {isLoading && <div className="text-sm text-ink-2">查询中…</div>}
              {error && (
                <div className="text-sm text-red-600 flex items-center gap-2">
                  查询失败，请重试
                  <button
                    onClick={() => qc.invalidateQueries({ queryKey: ["word-lookup", normalised] })}
                    className="text-xs px-2 py-0.5 rounded bg-red-50 hover:bg-red-100"
                  >
                    重试
                  </button>
                </div>
              )}
              {data && data.source === "dict" && (
                <div className="text-2xs text-ink-3 bg-[#f4f9f6] border border-[#c9dfd0] rounded-md px-2.5 py-1.5">
                  ⓘ LLM 暂不可用，已用开源词典补全英文释义 · 中文释义待补
                  <button
                    onClick={() => qc.invalidateQueries({ queryKey: ["word-lookup", normalised] })}
                    className="ml-2 text-brand hover:underline"
                  >
                    重试取中文
                  </button>
                </div>
              )}
              {data && (
                <div className="space-y-3.5">
                  <section>
                    <div className="text-2xs text-ink-3 uppercase tracking-[0.12em] font-semibold mb-1.5">
                      释义
                    </div>
                    {data.definition_en ? (
                      <>
                        <div className="text-base text-ink leading-[1.55]">{data.definition_en}</div>
                        {data.definition_zh && (
                          <div className="text-sm text-ink-2 mt-1 leading-[1.55]">{data.definition_zh}</div>
                        )}
                      </>
                    ) : (
                      data.definition_zh && (
                        <div className="text-base text-ink leading-[1.55]">{data.definition_zh}</div>
                      )
                    )}
                  </section>
                  {data.example && (
                    <section>
                      <div className="text-2xs text-ink-3 uppercase tracking-[0.12em] font-semibold mb-1.5">
                        例句
                      </div>
                      <div className="text-sm italic text-ink-2 leading-[1.55] pl-2.5 border-l-2 border-[#c9dfd0]">
                        {data.example}
                      </div>
                    </section>
                  )}
                  {/* Vocab CTA stays close to the lookup result, before the
                      ask section, so the quick path doesn't disappear. */}
                  <div>
                    {savedNow ? (
                      <button
                        disabled
                        className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 rounded-xl bg-[#16a070]/10 text-[#16a070] cursor-default"
                      >
                        <Check size={14} weight="bold" /> 已加入生词本
                      </button>
                    ) : (
                      <button
                        onClick={() => addMut.mutate()}
                        disabled={addMut.isPending}
                        className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand/90 disabled:opacity-60 transition-colors duration-150 ease-spring"
                      >
                        {addMut.isPending ? <>保存中…</> : <><Plus size={14} weight="bold" /> 加入生词本</>}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Ask-in-context section — always visible. In word-mode it
              starts collapsed (just the trigger button); in ask-mode the
              input is open and we run the explanation immediately. */}
          {showWordLookup && !askMd && askMode === "word" && (
            <div className="pt-2 border-t border-[#dcebe1]">
              <button
                onClick={() => {
                  setAskMode("ask");
                  setAskContext(word);
                  // Auto-run on switch — saves a click, the user clearly
                  // wanted the deeper answer or they wouldn't have hit it.
                  askMut.mutate(word);
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 rounded-xl bg-[#eaf3ec] text-[#285e48] hover:bg-[#dcebe1] transition-colors duration-150 ease-spring"
              >
                📖 在视频里详细解释
              </button>
            </div>
          )}

          {!showWordLookup && (
            <div className="space-y-3">
              {/* Selected text = context anchor, shown on top, never
                  echoed into the input. Long selections clamp with a
                  展开 toggle so the chip stays compact. */}
              {askContext.trim() && (
                <div className="rounded-xl bg-[#f0f6f2] border border-[#cfe3d6] px-3 py-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-2xs font-semibold text-[#285e48] tracking-wide">
                      选中
                    </span>
                    {askContext.trim().length > 90 && (
                      <button
                        onClick={() => setCtxExpanded((v) => !v)}
                        className="text-2xs text-ink-3 hover:text-ink"
                      >
                        {ctxExpanded ? "收起" : "展开"}
                      </button>
                    )}
                  </div>
                  <div
                    className={`text-sm leading-[1.5] text-ink-2 ${
                      ctxExpanded ? "" : "line-clamp-2"
                    }`}
                  >
                    {askContext}
                  </div>
                </div>
              )}

              {/* Quick follow-ups — one tap fills + sends, zero typing. */}
              {askContext.trim() && (
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["为什么这么说", "这句里最值得讲的那个用词/介词，为什么用这个、不用相近的另一个词？别讲语法，只讲脑子里的画面/场景区别。"],
                      ["脑子里的画面", "native 说这句时脑子里看到的是什么画面？空间、动作方向、谁对谁做了什么？"],
                      ["什么语感", "母语者说这个带什么情绪和感觉？什么场景下会脱口而出？"],
                      ["更地道的说法", "有没有更地道、native 真的会说的说法？换个说法画面会怎么变？"],
                    ] as [string, string][]
                  ).map(([label, q]) => (
                    <button
                      key={label}
                      onClick={() => {
                        // Fill the input so the user can tweak the
                        // question before sending — don't fire the
                        // explanation immediately.
                        setAskQuery(q);
                        requestAnimationFrame(() => {
                          const el = askTaRef.current;
                          if (el) {
                            el.focus();
                            el.setSelectionRange(q.length, q.length);
                          }
                        });
                      }}
                      disabled={askMut.isPending}
                      className="text-xs px-2.5 py-1 rounded-full bg-white border border-[#cfe3d6] text-[#285e48] hover:bg-[#eaf3ec] disabled:opacity-50 transition-colors duration-150 ease-spring"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              <label className="block text-2xs text-ink-3 uppercase tracking-[0.12em] font-semibold">
                想问什么？
                {askContext.trim() && (
                  <span className="ml-1.5 normal-case tracking-normal text-ink-3 font-normal">
                    （留空 = 直接详细解释）
                  </span>
                )}
              </label>
              <textarea
                ref={askTaRef}
                value={askQuery}
                onChange={(e) => setAskQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl + Enter sends — convention from chat UIs.
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    runAsk();
                  }
                }}
                rows={3}
                className="w-full resize-none rounded-xl border border-[#dcebe1] bg-white px-3 py-2.5 text-lg md:text-base leading-[1.6] text-ink min-h-[88px] focus:outline-none focus:ring-2 focus:ring-brand/30"
                placeholder={
                  askContext.trim()
                    ? "比如：为什么用 using 不是 use？别讲语法，说说脑子里的画面区别（留空 = 直接详细解释）"
                    : "问任何关于这个视频的问题…"
                }
                autoFocus
              />
              <div className="flex items-center justify-between">
                <span className="text-2xs text-ink-3">⌘↵ 发送</span>
                <button
                  onClick={() => runAsk()}
                  disabled={
                    (!askContext.trim() && !askQuery.trim()) || askMut.isPending
                  }
                  className="inline-flex items-center gap-1.5 text-sm font-semibold px-5 py-2 rounded-xl bg-brand text-white hover:bg-brand/90 disabled:opacity-60 transition-colors duration-150 ease-spring"
                >
                  {askMut.isPending ? "解释中…" : <>解释</>}
                </button>
              </div>
            </div>
          )}

          {askMut.isPending && !askMd && (
            <div className="flex items-center gap-2 text-sm text-ink-2 py-2">
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[#c9dfd0] border-t-brand animate-spin" />
              结合视频上下文给你写一个解释，5-10 秒…
            </div>
          )}

          {askMut.isError && (
            <LlmCallError error={askMut.error} fallback="解释生成失败，请重试。" />
          )}

          {askMd && (
            <div className="space-y-3">
              <SimpleMarkdown text={askMd} />
            </div>
          )}
        </div>

        {/* Footer — visible only when there's an ask result to act on */}
        {askMd && (
          <div className="shrink-0 px-5 py-3 border-t border-[#dcebe1] bg-[#f7fbf8] flex items-center gap-2">
            {savedNoteId ? (
              <button
                disabled
                className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 rounded-xl bg-[#16a070]/10 text-[#16a070] cursor-default"
              >
                <Check size={14} weight="bold" /> 已保存到笔记
              </button>
            ) : (
              <button
                onClick={() => saveNoteMut.mutate()}
                disabled={saveNoteMut.isPending}
                className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand/90 disabled:opacity-60 transition-colors duration-150 ease-spring"
              >
                {saveNoteMut.isPending ? "保存中…" : <><NotePencil size={14} weight="bold" /> 保存到笔记</>}
              </button>
            )}
            <button
              onClick={() => {
                // Re-ask: clear the result so the input is editable again.
                // Useful when the user wants to refine ("not crank it baby,
                // just crank it") without closing and reopening the popup.
                setAskMd(null);
                setSavedNoteId(null);
              }}
              className="px-3.5 py-2.5 rounded-xl text-sm text-ink-2 hover:bg-white"
              title="重新问一个"
            >
              <ArrowsClockwise size={14} weight="bold" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


// ============ Featured Words tab (per-episode AI-picked vocabulary) ============
//
// Each card flips to reveal Chinese gloss + example; user can jump to the
// subtitle row where the word first appears, save to vocabulary, or dismiss.
// Rendered inline on the Learn page right rail when activeTab === "words".

function FeaturedWordsPanel({
  episodeId,
  onJumpToSubtitle,
}: {
  episodeId: number;
  onJumpToSubtitle: (subId: number) => void;
}) {
  const qc = useQueryClient();
  const { data: words, isLoading, error: wordsError } = useQuery({
    queryKey: ["ep-featured-words", episodeId],
    queryFn: () => api.episodeFeaturedWords(episodeId),
    // 428 是"这一集还没生成过、而你没配 key"，重试改变不了任何事。
    retry: false,
  });
  // Source of truth for "is this word in the user's library?" is the
  // server-side vocabulary list, not local state.  Earlier we kept a
  // session-local Set<id> which reset on every remount → re-entering
  // the Words tab made saved cards look unsaved (and clicking them
  // would 409 on the server because the row already existed).  Reading
  // from the cached vocabulary list lets us also support undo (delete
  // by vocab.id) and survives navigation.
  const { data: vocabList } = useQuery({
    queryKey: ["vocabulary"],
    queryFn: () => api.listVocabulary({ limit: 200 }).then((r) => r.items),
  });
  // word (lowercase) → vocab row id, so the "remove" path knows which
  // server-side row to delete.  Featured-word and vocabulary entries
  // share the `word` field but not the id space.
  const vocabIdByWord = useMemo(() => {
    const m = new Map<string, number>();
    (vocabList ?? []).forEach((v) => m.set(v.word.toLowerCase(), v.id));
    return m;
  }, [vocabList]);

  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  // Track which featured-word card is mid-flight so we can disable just
  // that one (and not the whole list) during add/remove.
  const [pendingId, setPendingId] = useState<number | null>(null);

  const saveMut = useMutation({
    mutationFn: (vars: {
      id: number;
      word: string;
      ipa: string;
      definition_en: string;
      definition_zh: string;
      example: string;
      context_subtitle_id: number | null;
      context_text: string;
    }) =>
      api.addVocabulary({
        word: vars.word,
        ipa: vars.ipa,
        definition_en: vars.definition_en,
        definition_zh: vars.definition_zh,
        example: vars.example,
        context_episode_id: episodeId,
        context_subtitle_id: vars.context_subtitle_id,
        context_text: vars.context_text,
      }),
    // Optimistic add: prepend a stub Vocabulary into the cache so the
    // 加入学习本 button flips to ✓ immediately.  Server roundtrip on
    // mobile is 200-800ms; without this users tap repeatedly thinking
    // the click didn't register.
    onMutate: async (vars) => {
      setPendingId(vars.id);
      await qc.cancelQueries({ queryKey: ["vocabulary"] });
      const prev = qc.getQueryData<Vocabulary[]>(["vocabulary"]);
      qc.setQueryData<Vocabulary[]>(["vocabulary"], (old = []) => [
        ...(old ?? []),
        {
          id: -vars.id, // negative = optimistic stub, replaced on settle
          word: vars.word,
          ipa: vars.ipa,
          definition_en: vars.definition_en,
          definition_zh: vars.definition_zh,
          example: vars.example,
          context_episode_id: episodeId,
          context_subtitle_id: vars.context_subtitle_id,
          context_text: vars.context_text,
          mastery: 0,
        } as Vocabulary,
      ]);
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["vocabulary"], ctx.prev);
    },
    onSettled: () => {
      setPendingId(null);
      qc.invalidateQueries({ queryKey: ["vocabulary"] });
    },
  });

  const removeMut = useMutation({
    mutationFn: (vocabId: number) => api.deleteVocabulary(vocabId),
    onMutate: async (vocabId) => {
      // pendingId set by caller (so we know which featured-word card
      // to disable visually).  Just do the cache flip here.
      await qc.cancelQueries({ queryKey: ["vocabulary"] });
      const prev = qc.getQueryData<Vocabulary[]>(["vocabulary"]);
      qc.setQueryData<Vocabulary[]>(["vocabulary"], (old = []) =>
        (old ?? []).filter((v) => v.id !== vocabId),
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["vocabulary"], ctx.prev);
    },
    onSettled: () => {
      setPendingId(null);
      qc.invalidateQueries({ queryKey: ["vocabulary"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex-1 grid place-items-center">
        <LoadingCritter label="AI 正在挑选核心词…" hint="首次加载一集约 30 秒" />
      </div>
    );
  }

  // 老集的推荐词是打开这个 tab 时现生成的 —— 那是一次模型调用，走学员自己的
  // key。已经生成过的集读缓存，不调模型，也就不需要 key。
  if (isByokRequired(wordsError)) {
    return (
      <div className="flex-1 overflow-auto p-3.5">
        <NeedApiKey message={wordsError.message} />
      </div>
    );
  }

  if (!words?.length) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-ink-3 text-center px-6">
        <div>这一集暂时没有 Words</div>
      </div>
    );
  }

  // Hide cards the user dismissed in this session — they go to the bottom
  // grayed-out so they're not lost forever.
  const visible = words.filter((w) => !dismissedIds.has(w.id));
  const dismissed = words.filter((w) => dismissedIds.has(w.id));

  return (
    <div className="flex-1 overflow-auto p-3.5">
      <div className="text-2xs text-ink-3 mb-3 leading-snug">
        AI 从本集挑出 {words.length} 个 CEFR B2+ 核心词 · 不会的点 🔖 加入学习本，会的可以忽略
      </div>
      <div className="flex flex-col gap-3">
        {visible.map((w) => {
          const savedVocabId = vocabIdByWord.get(w.word.toLowerCase()) ?? null;
          const saved = !!savedVocabId;
          const pending = pendingId === w.id;
          return (
            <article
              key={w.id}
              className="card p-3.5 transition-colors duration-150 ease-spring hover:border-ink-2/30"
            >
              {/* Header — word + IPA + POS + CEFR + speak */}
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  {/* 喇叭紧跟单词。原来它在卡片右上角，卡片有一整屏宽 ——
                      每念一个词都要把鼠标从单词甩到屏幕最右边。 */}
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="text-lg font-bold leading-tight">{w.word}</h3>
                    <button
                      onClick={() => {
                        primeWebSpeech();
                        primeAudio();
                        speakText(w.word, { rate: 0.9 });
                      }}
                      className="self-center w-7 h-7 rounded text-ink-3 hover:text-brand hover:bg-[#eaf3ec] grid place-items-center shrink-0"
                      title="发音"
                      aria-label={`朗读 ${w.word}`}
                    >
                      <SpeakerHigh size={13} />
                    </button>
                    {w.ipa && (
                      <span className="text-2xs text-ink-3 font-mono">{w.ipa}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-2xs text-ink-3 mt-0.5">
                    {w.pos && <span>{w.pos}</span>}
                    {w.cefr && (
                      <span className="px-1 py-0 rounded bg-[#f0f3f0] font-semibold">
                        {w.cefr}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Definitions — EN over ZH, both visible at once */}
              {w.definition_en && (
                <p className="text-xs text-ink leading-[1.55] mt-2">
                  {w.definition_en}
                </p>
              )}
              {w.definition_zh && (
                <p className="text-xs text-ink-2 leading-[1.55] mt-1">
                  {w.definition_zh}
                </p>
              )}

              {/* Example */}
              {w.example && (
                <p className="text-2xs italic text-ink-2 mt-2 border-l-2 border-line pl-2 leading-snug">
                  {w.example}
                </p>
              )}

              {/* Episode context */}
              {w.context_text && (
                <p className="text-2xs text-ink-3 mt-2 line-clamp-2 leading-snug">
                  · {w.context_text}
                </p>
              )}

              {/* Actions row */}
              <div className="flex items-center gap-1 mt-3 pt-2.5 border-t border-line/50">
                {w.context_subtitle_id && (
                  <button
                    onClick={() => onJumpToSubtitle(w.context_subtitle_id!)}
                    className="inline-flex items-center gap-1 text-2xs text-ink-3 hover:text-brand px-1.5 py-1"
                    title="跳到原片这一句"
                  >
                    <Playlist size={12} /> 回原片
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={() =>
                    setDismissedIds((s) => {
                      const n = new Set(s);
                      n.add(w.id);
                      return n;
                    })
                  }
                  className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-ink hover:bg-[#eff2ef] transition-all active:scale-90"
                  title="我已经会了，忽略"
                  aria-label="忽略这个词"
                >
                  <X size={14} />
                </button>
                {saved ? (
                  <button
                    onClick={() => {
                      if (!savedVocabId) return;
                      setPendingId(w.id);
                      removeMut.mutate(savedVocabId);
                    }}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-brand hover:bg-[#eaf3ec] transition-colors duration-150 ease-spring active:scale-90"
                    title="已加入，点击移除"
                    aria-label="已加入学习本"
                  >
                    <BookmarkSimple size={15} weight="fill" />
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      saveMut.mutate({
                        id: w.id,
                        word: w.word,
                        ipa: w.ipa,
                        definition_en: w.definition_en,
                        definition_zh: w.definition_zh,
                        example: w.example,
                        context_subtitle_id: w.context_subtitle_id,
                        context_text: w.context_text,
                      })
                    }
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-brand hover:bg-[#eaf3ec] transition-colors duration-150 ease-spring active:scale-90"
                    title="加入学习本"
                    aria-label="加入学习本"
                  >
                    <BookmarkSimple size={15} weight="bold" />
                  </button>
                )}
              </div>
            </article>
          );
        })}

        {dismissed.length > 0 && (
          <details className="mt-2 text-2xs text-ink-3">
            <summary className="cursor-pointer hover:text-ink">
              已忽略 {dismissed.length} 个 — 想找回？
            </summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {dismissed.map((w) => (
                <button
                  key={w.id}
                  onClick={() =>
                    setDismissedIds((s) => {
                      const n = new Set(s);
                      n.delete(w.id);
                      return n;
                    })
                  }
                  className="px-2 py-0.5 rounded-full bg-[#f0f3f0] text-ink-2 hover:bg-[#e8eaee]"
                >
                  {w.word}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}



// ============ End-of-episode recap card ============
// Appears inline at the bottom of the subtitle list when the user reaches
// the final row. Celebrates completion and funnels to either the 推荐词
// flashcards or next-episode discovery.
function EpisodeRecap({
  chunksCount,
  onOpenWords,
}: {
  chunksCount: number;
  onOpenWords: () => void;
}) {
  return (
    <div className="mt-6 mb-4 card p-5 bg-gradient-to-br from-[#f4f9f6] to-[#e6f1ea] border-[#c9dfd0]">
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-widest text-[#285e48] font-semibold mb-1">
        <Confetti size={12} />
        Recap
      </div>
      <h4 className="text-lg font-bold leading-tight mb-1">你听完这一集了</h4>
      <p className="text-xs text-ink-2 leading-snug">
        本集共 {chunksCount} 个 chunks。现在是把它们"从懂到会"的最佳时机 ——
        翻一遍 Words，或者去和 AI 聊两句加深印象。
      </p>
      <div className="flex gap-2 mt-4">
        <button onClick={onOpenWords} className="btn-primary text-sm">看 Words</button>
        <a href="/catalog" className="btn-ghost text-sm">下一集</a>
      </div>
    </div>
  );
}

// ============ Collapsible episode intro ============
// Below the video, above the AI/Notes tabs.  Gives the learner the
// full EN + ZH summary — pre-listening context is known to boost
// comprehension.  Default collapsed so the player stays dominant;
// preference persists in localStorage.
// ============ Now-playing spotlight ============
//
// Big EN card under the video showing the sentence currently being
// spoken.  Word-timing highlight tracks the video cursor so the
// learner sees one word at a time "light up" — useful for building
// listen ↔ read muscle memory.  Chunks inside the sentence keep
// their colored background so target expressions stay visible.
// Has its own 3-state spotlight-mode (off/en/bi); seeds its initial
// default from SentenceRecorder's shadow-reveal-text so the "先靠听"
// habit still carries across both tools on first use.

const CHUNK_SOFT: Record<string, string> = {
  idiomatic: "bg-chunk-1/70",
  collocation: "bg-chunk-2/70",
  discourse: "bg-chunk-3/70",
  functional: "bg-chunk-4/70",
  cultural: "bg-chunk-1/70",
};

// Plan A — minimalist "current line" focus.  Inspired by Apple Music /
// Spotify's now-playing lyric strip: no card chrome (just thin top/bottom
// rules), pulsing brand dot, time code, centered EN + ZH, and a 1px
// sub-line progress bar at the bottom that fills as the spoken line
// elapses.  Earlier this was a 160px white card that crowded the column
// and "boxed in" what should be the page's stage.
function NowSpotlight({
  sub,
  chunks,
  currentMs,
  userChunks,
  onUserChunkRemove,
  onWordClick,
  onChunkClick,
}: {
  sub: Subtitle | undefined;
  chunks: Chunk[];
  currentMs: number;
  userChunks?: { id: number; text: string }[];
  onUserChunkRemove?: (id: number) => void;
  onWordClick: (word: string, sub: Subtitle) => void;
  onChunkClick?: (chunk: Chunk) => void;
}) {
  // 3-state cycle: off (ear-first, hidden) → en (English only) →
  // bi (中英). Own localStorage key so this richer cycle doesn't
  // entangle SentenceRecorder's binary reveal; the initial default
  // still migrates from the shared shadow-reveal-text so the "先靠听"
  // habit carries across both tools (off unless they'd opted to show).
  type SpotMode = "off" | "en" | "bi";
  const [spotMode, setSpotMode] = useState<SpotMode>(() => {
    try {
      const m = localStorage.getItem("spotlight-mode");
      if (m === "off" || m === "en" || m === "bi") return m;
      return localStorage.getItem("shadow-reveal-text") === "1" ? "bi" : "off";
    } catch {
      return "off";
    }
  });
  const pickMode = (next: SpotMode) => {
    setSpotMode(next);
    try {
      localStorage.setItem("spotlight-mode", next);
    } catch {
      /* private mode */
    }
  };
  const SPOT_SEGMENTS: {
    k: SpotMode;
    label: string;
    Icon: typeof Eye;
    title: string;
  }[] = [
    { k: "off", label: "OFF", Icon: EyeSlash, title: "纯听 · 隐藏字幕" },
    { k: "en", label: "EN", Icon: Eye, title: "英文字幕" },
    { k: "bi", label: "EN+ZH", Icon: Translate, title: "中英字幕" },
  ];

  if (!sub) {
    return (
      <div className="w-full px-2 py-4 border-y border-line/60 flex items-center justify-center gap-2 text-xs text-ink-3">
        <SpeakerHigh size={13} />
        <span>The sentence being spoken will show here once playback starts.</span>
      </div>
    );
  }

  // Sub-line progress: clamp to [0, 1] so we don't render a negative or
  // overflowing bar at the boundaries when currentMs jitters past end_ms.
  const total = Math.max(1, sub.end_ms - sub.start_ms);
  const elapsed = Math.max(0, Math.min(total, currentMs - sub.start_ms));
  const pct = (elapsed / total) * 100;

  return (
    <div className="w-full px-2 py-3.5 md:py-4 border-y border-line/60 flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-2.5 shrink-0">
        <span className="relative flex w-1.5 h-1.5">
          <span className="absolute inline-flex w-full h-full rounded-full bg-brand opacity-60 animate-ping" />
          <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-brand" />
        </span>
        <span className="text-2xs text-ink-3 font-medium tabular-nums">
          {fmt(sub.start_ms)} – {fmt(sub.end_ms)}
        </span>
        <div className="flex-1" />
        <div
          className="inline-flex items-center rounded-full bg-[#f0f3f0] p-0.5"
          role="tablist"
          aria-label="字幕显示模式"
        >
          {SPOT_SEGMENTS.map((s) => (
            <button
              key={s.k}
              role="tab"
              aria-selected={spotMode === s.k}
              onClick={() => pickMode(s.k)}
              title={s.title}
              aria-label={s.title}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-2xs font-semibold rounded-full transition-colors duration-150 ease-spring ${
                spotMode === s.k
                  ? "bg-white text-ink shadow-sm"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              <s.Icon size={12} />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body absorbs all leftover height so the line sits visually
          centered inside whatever space the column gives us. */}
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto">
        {spotMode !== "off" ? (
          <div className="text-center px-2 md:px-4">
            <div className="text-xl md:text-2xl leading-[1.5] font-medium text-ink tracking-tight">
              {renderRichSubtitle(sub.text_en, chunks, new Set(), (w) => onWordClick(w, sub), onChunkClick, userChunks, onUserChunkRemove)}
            </div>
            {spotMode === "bi" && sub.text_zh && (
              <div className="text-base md:text-lg leading-[1.6] text-ink-2 mt-2.5">
                {sub.text_zh}
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => pickMode("en")}
            className="text-base text-ink-3 italic inline-flex items-center gap-2 px-4 py-3 rounded-md hover:bg-[#f8faf8] transition-colors duration-150 ease-spring"
            title="点一下显示英文字幕"
          >
            <SpeakerHigh size={15} className="shrink-0" />
            <span>先用耳朵听 · 点击显示字幕</span>
          </button>
        )}
      </div>

      {/* Sub-line progress.  Stays a hair visible at 0% so the rule
          doesn't visually "snap on" at line start. */}
      <div className="mt-3 h-px bg-line/60 relative overflow-hidden rounded-full shrink-0">
        <div
          className="absolute inset-y-0 left-0 bg-brand/45 transition-[width] duration-150 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// Icon-only button + centered modal.  Replaces the old collapsible card
// that ate ~14rem of left-column real estate even when content was short.
// Modal feels more deliberate for a "read this once before you start"
// piece of content; backdrop blur matches the SentenceRecorder modal
// elsewhere in the app for visual consistency.
function IntroButton({
  ep,
}: {
  ep: { title: string; summary: string; summary_zh?: string; topic?: string; duration_sec: number; youtube_url?: string };
}) {
  const [open, setOpen] = useState(false);

  // Trim first so a summary that's pure whitespace (rare but seen on
  // legacy episodes) doesn't show a useless Introduction button.
  const summaryEn = (ep.summary ?? "").trim();
  const summaryZh = (ep.summary_zh ?? "").trim();
  const hasContent = !!(summaryEn || summaryZh);

  // ESC closes — only attach the listener while the modal is open so we
  // don't intercept ESC for the rest of the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!hasContent) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:bg-[#eff2ef] hover:text-ink transition-colors duration-150 ease-spring"
        title="Introduction"
        aria-label="Introduction"
      >
        <BookOpen size={14} />
      </button>
      {open && (
        <div
          className="fixed inset-0 bg-ink/35 backdrop-blur-[2px] z-50 grid place-items-center p-4 md:p-6"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white shadow-xl shadow-[#00000014] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line/70">
              <BookOpen size={15} className="text-ink-3" />
              <span className="text-sm font-semibold text-ink tracking-wide">Introduction</span>
              <div className="flex-1" />
              <button
                onClick={() => setOpen(false)}
                className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:bg-[#eff2ef] hover:text-ink transition-colors duration-150 ease-spring"
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3 text-sm leading-[1.65] max-h-[70vh] overflow-y-auto">
              {summaryZh && <div className="text-ink">{summaryZh}</div>}
              {summaryEn && (
                <div className="text-ink-2 italic text-xs leading-[1.6]">{summaryEn}</div>
              )}
              {ep.youtube_url && (
                <a
                  href={ep.youtube_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-brand hover:underline pt-1"
                >
                  <FilmStrip size={12} /> 原片 YouTube
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// "怎么学" methodology button.  Auto-opens once on first Learn visit
// (gated by localStorage), and stays accessible from the meta bar so
// users can revisit the four-step listening flow + chunk/emotion tips
// without hunting for a hidden setting.
const HOWTO_SEEN_KEY = "learn-howto-seen";

function HowToButton() {
  const [open, setOpen] = useState(false);

  // First-visit auto-open.  We defer the open until after mount so the
  // modal animates over a fully-rendered page rather than flashing during
  // initial paint.  Persists immediately on first show so future visits
  // (even without dismiss) don't re-pop.
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(HOWTO_SEEN_KEY) === "1"; } catch { /* private mode */ }
    if (!seen) {
      const t = window.setTimeout(() => {
        setOpen(true);
        try { localStorage.setItem(HOWTO_SEEN_KEY, "1"); } catch { /* ignore */ }
      }, 350);
      return () => window.clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:bg-[#eff2ef] hover:text-ink transition-colors duration-150 ease-spring"
        title="学习方法"
        aria-label="怎么学"
      >
        <Question size={14} />
      </button>
      <HowToModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

