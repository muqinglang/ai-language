import { useState } from "react";
import { ArrowCounterClockwise, Check, SpeakerHigh } from "@phosphor-icons/react";
import { primeAudio, primeWebSpeech, speakText } from "@/lib/speak";

/** 比对用的归一化：忽略大小写、标点、多余空格。
 *  听写练的是"听出了哪些词"，不是标点和大小写 —— 因为漏了一个句号被判错，
 *  只会让人觉得这个练习在挑刺。 */
function norm(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

type WordMark = { w: string; ok: boolean };

/** 逐词比对。用最长公共子序列而不是逐位对齐：漏听一个词之后，后面
 *  所有词都会错位，逐位比会把整句判成全错，那个反馈毫无用处。 */
function compare(typed: string, truth: string): { marks: WordMark[]; hit: number; total: number } {
  const a = norm(typed);
  const b = norm(truth);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯出「原句里哪些词被听到了」
  const matched = new Set<number>();
  let i = a.length, j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { matched.add(j - 1); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  const words = truth.split(/\s+/).filter(Boolean);
  let k = 0;
  const marks: WordMark[] = words.map((w) => {
    const isWord = norm(w).length > 0;
    const ok = isWord ? matched.has(k++) : true;
    return { w, ok };
  });
  return { marks, hit: matched.size, total: b.length };
}

/**
 * 听一句 → 打出你听到的 → 回车对答案。
 *
 * 先听后看：原文默认不显示。这个顺序是有意的 —— 眼睛看到文字之后，
 * 耳朵就不再工作了，"听懂"会被"读懂"冒充。
 *
 * 只有一个揭晓动作：回车。之前还并排放着"眼睛"图标和"对答案"按钮，
 * 三个控件干同一件事，其中两个还被 flex-1 顶到了行尾 —— 宽屏上离输入框
 * 半个屏幕远。回车本来就在手指下面，剩下两个是纯噪音。
 * 输入框空着直接回车 = 我不会，直接看原文。
 *
 * 判分逐词、用最长公共子序列：漏一个词不至于让后面全错。大小写和标点
 * 不计入，练的是听出了哪些词。
 */
export function ListenAndType({
  text,
  label,
  compact = false,
}: {
  text: string;
  label?: string;
  compact?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [checked, setChecked] = useState(false);

  const play = () => {
    primeWebSpeech();
    primeAudio();
    speakText(text);
  };
  // 空着回车就是"我听不出来"，直接给原文，不打分。
  const result = checked && typed.trim() ? compare(typed, text) : null;

  return (
    <div className="rounded-ctl px-3 py-2.5" style={{ background: "var(--rv-canvas)" }}>
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={play}
          className="shrink-0 w-9 h-9 rounded-in grid place-items-center transition-colors duration-150 ease-spring active:scale-[.98]"
          style={{ background: "var(--rv-mint)", color: "var(--rv-primary)" }}
          title="Play"
          aria-label="Play this sentence"
        >
          <SpeakerHigh size={16} />
        </button>
        {label && (
          <span className="text-xs shrink-0" style={{ color: "var(--rv-faint)" }}>{label}</span>
        )}
      </div>

      {/* 原文：默认不显示。先听，听不出来再回车。 */}
      {checked && (
        <p className="text-base leading-relaxed mb-2" style={{ color: "var(--rv-ink)" }}>
          {result
            ? result.marks.map((m, i) => (
                <span
                  key={i}
                  style={
                    m.ok
                      ? undefined
                      : { background: "#fff2d6", color: "#b27700", borderRadius: 3, padding: "0 2px" }
                  }
                >
                  {m.w}{" "}
                </span>
              ))
            : text}
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          value={typed}
          onChange={(e) => { setTyped(e.target.value); setChecked(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setChecked(true); } }}
          placeholder="Type what you hear, then press Enter"
          spellCheck={false}
          className={`flex-1 min-w-0 rounded-in px-3 py-2 outline-none transition-colors duration-150 ease-spring ${compact ? "text-sm" : "text-base"}`}
          style={{ background: "var(--rv-surface)", border: "1px solid var(--rv-line)", color: "var(--rv-ink)" }}
        />
        {checked && (
          <button
            type="button"
            onClick={() => { setTyped(""); setChecked(false); }}
            className="shrink-0 p-2 rounded-in transition-colors duration-150 ease-spring"
            style={{ color: "var(--rv-faint)" }}
            title="Listen again and retype"
            aria-label="Try again"
          >
            <ArrowCounterClockwise size={15} />
          </button>
        )}
      </div>

      {result && (
        <div className="mt-1.5 text-xs inline-flex items-center gap-1.5" style={{ color: result.hit === result.total ? "var(--rv-primary)" : "var(--rv-muted)" }}>
          {result.hit === result.total ? <Check size={13} weight="bold" /> : null}
          {result.hit === result.total
            ? `All ${result.total} words`
            : `${result.hit}/${result.total} words — highlighted ones you missed`}
        </div>
      )}
    </div>
  );
}
