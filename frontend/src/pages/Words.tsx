import { useQuery } from "@tanstack/react-query";
import { BookOpen, Sparkle, SpeakerHigh } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { primeAudio, primeWebSpeech, speakText } from "@/lib/speak";

const CEFR_LEVELS = [
  { v: undefined, label: "全部" },
  { v: "A2", label: "A2" },
  { v: "B1", label: "B1" },
  { v: "B2", label: "B2" },
  { v: "C1", label: "C1" },
  { v: "C2", label: "C2" },
];

const CEFR_COLOR: Record<string, string> = {
  A1: "#94a3b8",
  A2: "#64748b",
  B1: "#0ea5e9",
  B2: "#10b981",
  C1: "#f59e0b",
  C2: "#ef4444",
};

// 走全站统一入口，用学员自己配的声音；没配才落到浏览器机器音。
function speakWord(word: string) {
  primeWebSpeech();
  primeAudio();
  speakText(word, { rate: 0.9 });
}

export function Words() {
  const [cefr, setCefr] = useState<string | undefined>();
  const { data: words, isLoading } = useQuery({
    queryKey: ["global-featured-words", cefr],
    queryFn: () => api.globalFeaturedWords(cefr, 200),
  });

  return (
    <Shell>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-2xs uppercase tracking-widest text-ink-3 font-semibold mb-1">
          <Sparkle size={12} weight="bold" />
          Featured Words
        </div>
        <h1 className="text-2xl font-bold leading-tight">推荐词</h1>
        <p className="text-sm text-ink-2 mt-1 max-w-xl">
          AI 从每集视频里挑出的高价值单词 —— CEFR B2+、上下文清晰、能跨集复用。按等级筛选，
          或者点单词回到出现它的那一集。
        </p>
      </div>

      {/* CEFR filter */}
      <div className="flex gap-1.5 mb-5">
        {CEFR_LEVELS.map((lvl) => (
          <button
            key={lvl.label}
            onClick={() => setCefr(lvl.v)}
            className={`chip inline-flex items-center gap-1.5 ${
              cefr === lvl.v ? "chip-on" : ""
            }`}
          >
            {lvl.v && (
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: CEFR_COLOR[lvl.v] }}
              />
            )}
            {lvl.label}
          </button>
        ))}
      </div>

      {isLoading && <div className="text-ink-3 text-sm">加载中…</div>}

      {!isLoading && words?.length === 0 && (
        <div className="card p-10 text-center">
          <BookOpen size={28} className="text-ink-3 mx-auto mb-3" />
          <div className="text-base font-semibold">还没有推荐词</div>
          <div className="text-xs text-ink-3 mt-1">
            打开任意一集视频，在"推荐词"tab 让 AI 帮你挑出这一集的核心词汇。
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        {words?.map((w) => (
          <div key={w.word} className="card p-5 hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                {/* 喇叭紧跟单词，不要靠 justify-between 顶到卡片另一头。 */}
                <div className="flex items-center gap-1.5">
                  <h3 className="text-xl font-bold leading-tight">{w.word}</h3>
                  <button
                    onClick={() => speakWord(w.word)}
                    className="w-7 h-7 rounded text-ink-3 hover:text-brand hover:bg-[#eaf3ec] grid place-items-center shrink-0"
                    title="发音"
                    aria-label={`朗读 ${w.word}`}
                  >
                    <SpeakerHigh size={14} />
                  </button>
                </div>
                {w.ipa && <div className="text-2xs text-ink-3 font-mono mt-0.5">{w.ipa}</div>}
                <div className="flex items-center gap-2 mt-1 text-2xs text-ink-3">
                  {w.pos && <span>{w.pos}</span>}
                  {w.cefr && (
                    <span
                      className="inline-flex items-center gap-1 font-semibold"
                      style={{ color: CEFR_COLOR[w.cefr] ?? "#64748b" }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: CEFR_COLOR[w.cefr] ?? "#64748b" }}
                      />
                      {w.cefr}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {w.definition_en && (
              <p className="text-xs text-ink-2 leading-snug mt-3 line-clamp-3">{w.definition_en}</p>
            )}
            {w.definition_zh && (
              <p className="text-xs text-ink-3 mt-1.5">{w.definition_zh}</p>
            )}
            {w.example && (
              <p className="text-2xs italic text-ink-2 mt-3 pl-2 border-l-2 border-line line-clamp-2">
                {w.example}
              </p>
            )}
            <div className="mt-3 pt-3 border-t border-line flex items-center justify-between">
              <span className="text-2xs text-ink-3">{w.episode_count} 集出现</span>
              <Link
                to={`/learn/${w.top_episode_id}`}
                className="text-2xs text-brand hover:underline"
              >
                回上下文 →
              </Link>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
