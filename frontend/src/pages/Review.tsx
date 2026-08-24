import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise, BookOpen, Cards, CaretDown, ChatCircle, Check, CircleNotch,
  ClipboardText, Fire, Headphones, SpeakerHigh, Trophy, WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { ListenAndType } from "@/components/ListenAndType";
import { LoadingCritter } from "@/components/LoadingCritter";
import { NeedApiKey } from "@/components/NeedApiKey";
import { api, isByokRequired, errorDetail } from "@/lib/api";
import type {
  ReviewDetail, ReviewDueItem, ReviewExample, ReviewHistoryRow, ReviewResult, Vocabulary,
} from "@/lib/api";
import { primeAudio, primeWebSpeech, speakText } from "@/lib/speak";

/**
 * 对话复习 —— 你和 ChatGPT 聊完整理出的知识点，按遗忘曲线复现。
 *
 * 和「学习本」的分工：学习本收的是看视频时点出来的单词（别人的内容），
 * 这里收的是你自己聊出来的表达。两者曲线相同、队列合并（见
 * routers/review.py 的 /due），但各存各的表 —— 字段形状差得远。
 *
 * 配色是白绿（--rv-*），不是站里其他页的橙红。这是有意的过渡态：先在
 * 一个页面上看到实际效果，再决定要不要全站铺开。
 */
type Tab = "conversation" | "history" | "listening" | "vocab";

const GRADES: { k: ReviewResult; label: string; hint: string }[] = [
  { k: "incorrect", label: "Didn't know", hint: "back tomorrow" },
  { k: "partial", label: "Half there", hint: "back in 3 days" },
  { k: "correct", label: "Got it", hint: "the more you nail it, the longer the gap" },
];

const TABS = [
  { k: "conversation", label: "Conversation", Icon: ChatCircle },
  // 左侧导航已经写着 Review，这里再叫 "Review History" 是同一句说两遍，
  // 且它是四个 tab 里唯一的双词标签 —— 窄屏 flex-1 四等分时只有它换行、
  // 和其它三个单词 tab 高度对不齐。收成单词 "History"。
  { k: "history", label: "History", Icon: Cards },
  { k: "listening", label: "Listening", Icon: Headphones },
  { k: "vocab", label: "Vocabulary", Icon: BookOpen },
] as const;

export function Review() {
  const [tab, setTab] = useState<Tab>("conversation");
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(["conversation"]));
  const open = (k: Tab) => {
    setTab(k);
    setVisited((v) => (v.has(k) ? v : new Set(v).add(k)));
  };

  return (
    <Shell hideSearch>
      {/* 白绿色板只作用在这一页。全站铺开是后面单独一步。 */}
      {/* 一个列宽管到底。之前列宽只加在内层卡片上，外层容器还是全宽 ——
          同一屏里两种宽度对不齐，右边就空出一条。 */}
      <div
        className="rv max-w-5xl mx-auto"
        style={{
          ["--rv-canvas" as string]: "#f5f7f4",
          ["--rv-surface" as string]: "#ffffff",
          ["--rv-ink" as string]: "#16211f",
          ["--rv-muted" as string]: "#596861",
          ["--rv-faint" as string]: "#819087",
          ["--rv-primary" as string]: "#2f755f",
          ["--rv-mint" as string]: "#eaf3ec",
          ["--rv-line" as string]: "#dce4dc",
        }}
      >
        {/* 不放页面标题：左侧导航已经写着 Review，三个 tab 也各自说明了
            自己是干什么的，再来一行"对话复习"是同一句话说三遍。 */}
        <div
          className="rounded-2xl p-1 mb-5 flex gap-1"
          style={{ background: "var(--rv-mint)" }}
        >
          {TABS.map((t) => (
            <button
              key={t.k}
              onClick={() => open(t.k)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm whitespace-nowrap transition-colors duration-150 ease-spring"
              style={
                tab === t.k
                  ? { background: "var(--rv-surface)", color: "var(--rv-ink)", fontWeight: 600 }
                  : { color: "var(--rv-muted)" }
              }
            >
              <t.Icon size={14} /> {t.label}
            </button>
          ))}
        </div>

        {/* 访问过的 tab 只是藏起来，不卸载。
            听力那篇故事是花学员自己的 key 生成的，之前切一下 tab 就没了，
            回来只能重新生成、重新付费。同理还有已经打出来的听写答案。
            第一次访问才挂载，所以打开这一页不会四个 tab 一起发请求。 */}
        {TABS.map((t) => (
          visited.has(t.k) && (
            <div key={t.k} style={tab === t.k ? undefined : { display: "none" }}>
              {t.k === "conversation" && <ConversationTab />}
              {t.k === "history" && <HistoryTab />}
              {t.k === "listening" && <ListeningTab />}
              {t.k === "vocab" && <VocabTab />}
            </div>
          )
        ))}
      </div>
    </Shell>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl p-4 md:p-5 mb-4 ${className}`}
      style={{ background: "var(--rv-surface)", border: "1px solid var(--rv-line)" }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────── Conversation

function ConversationTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const { data: due, isLoading } = useQuery({
    queryKey: ["review-due"],
    queryFn: () => api.reviewDue(),
  });
  // 这个 tab 只管从对话导入的表达；生词在「单词」tab 里，各有各的
  // 打分接口，混在一起会让同一条数据被两套逻辑各写一次。
  const expressions = (due?.items ?? []).filter((i) => i.kind === "expression");
  // 已经在上面今日队列里出现过的，不在「最近导入」里重复列一遍。
  const dueIds = new Set(expressions.map((i) => i.id));
  const latest = (due?.latest_items ?? []).filter((i) => !dueIds.has(i.id));

  const imp = useMutation({
    mutationFn: () => api.reviewImport(raw),
    onSuccess: (r) => {
      setMsg(`Imported ${r.imported} new, updated ${r.updated} (${r.practice_date})`);
      setErr("");
      setRaw("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["review-due"] });
      qc.invalidateQueries({ queryKey: ["review-history"] });
    },
    onError: (e) => { setErr(errorDetail(e, "Import failed")); setMsg(""); },
  });

  return (
    <>
      <Card>
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between gap-2"
        >
          <span className="inline-flex items-center gap-2 text-base font-semibold" style={{ color: "var(--rv-ink)" }}>
            <ClipboardText size={16} /> Paste import
          </span>
          <span className="text-xs" style={{ color: "var(--rv-primary)" }}>
            {open ? "Collapse" : "Paste sync block from ChatGPT"}
          </span>
        </button>
        {open && (
          <div className="mt-3">
            <p className="text-xs mb-2" style={{ color: "var(--rv-muted)" }}>
              Paste the whole <code>english-review-sync</code> block from ChatGPT.
              Fences and surrounding chatter are fine — they get stripped.
            </p>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={7}
              spellCheck={false}
              placeholder={`{"space":"English Review","practiceDate":"2026-08-21","items":[...]}`}
              className="w-full rounded-xl p-3 text-xs font-mono outline-none"
              style={{ background: "var(--rv-canvas)", border: "1px solid var(--rv-line)", color: "var(--rv-ink)" }}
            />
            <button
              onClick={() => imp.mutate()}
              disabled={!raw.trim() || imp.isPending}
              className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--rv-primary)" }}
            >
              {imp.isPending ? <><CircleNotch size={13} className="animate-spin" /> Importing…</> : "Import"}
            </button>
          </div>
        )}
      </Card>

      {msg && (
        <div className="mb-4 px-3 py-2 rounded-xl text-xs inline-flex items-center gap-1.5"
             style={{ background: "var(--rv-mint)", color: "var(--rv-primary)" }}>
          <Check size={13} weight="bold" /> {msg}
        </div>
      )}
      {err && (
        <div className="mb-4 px-3 py-2 rounded-xl text-xs inline-flex items-start gap-1.5 bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c]">
          <WarningCircle size={13} weight="bold" className="shrink-0 mt-px" /> {err}
        </div>
      )}

      {isLoading && <p className="text-sm" style={{ color: "var(--rv-muted)" }}>Loading…</p>}

      {due && expressions.length === 0 && latest.length === 0 && (
        <Card>
          <div className="text-base font-semibold mb-1" style={{ color: "var(--rv-ink)" }}>Nothing due today</div>
          <p className="text-xs" style={{ color: "var(--rv-muted)" }}>
            {due.latest_count > 0
              ? `Your latest batch (${due.latest_practice_date}, ${due.latest_count} items) isn't due yet.`
              : "Paste a review block from ChatGPT to get started."}
          </p>
        </Card>
      )}

      {due && expressions.length > 0 && (
        <div
          className="rounded-2xl p-4 md:p-5"
          style={{ background: "var(--rv-mint)", border: "1px solid var(--rv-line)" }}
        >
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <h3 className="text-lg font-bold" style={{ color: "var(--rv-primary)" }}>
              {expressions.length} due today
            </h3>
            {due.latest_practice_date && (
              <span className="text-2xs shrink-0" style={{ color: "var(--rv-faint)" }}>
                Last synced {due.latest_practice_date} · {due.latest_count} items
              </span>
            )}
          </div>
          <p className="text-xs mb-4" style={{ color: "var(--rv-muted)" }}>
            Answer in your head first, then reveal and rate yourself — your rating
            decides when it comes back.
          </p>
          <div className="space-y-3">
            {expressions.map((it, i) => (
              <DueCard key={it.id} item={it} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* 最近导入的那一批，不管到没到期。
          没有这一节的话，刚粘完的内容会凭空消失 —— 导入当天的东西次日
          才首次到期，既不在今日队列里，也没有别处能看到。 */}
      {latest.length > 0 && (
        <Card className="mt-4">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <h3 className="text-lg font-bold" style={{ color: "var(--rv-ink)" }}>
              Latest import
            </h3>
            <span className="text-2xs shrink-0" style={{ color: "var(--rv-faint)" }}>
              {due?.latest_practice_date} · {latest.length} items
            </span>
          </div>
          <p className="text-xs mb-3" style={{ color: "var(--rv-muted)" }}>
            These are scheduled for tomorrow. Run through them now if you like —
            rating one puts it straight on the curve.
          </p>
          <div className="space-y-3">
            {latest.map((it, i) => (
              <DueCard key={it.id} item={it} index={i} />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}


/**
 * 结构化讲解。ChatGPT 的 example 字段可能是一句话，也可能是一整块
 * {meaning, explanation, usageTip, examples[{scenario, english, chinese}]}。
 *
 * 按 shape 渲染而不是假设字段一定在：这段 JSON 是模型生成的，字段随时会
 * 多一个少一个。任何没认出来的键都原样列出来，好过悄悄吞掉 —— 吞掉的话
 * 你得对着页面猜"我让 ChatGPT 写的那段解释去哪了"。
 */
function DetailView({ detail }: { detail?: ReviewDetail }) {
  if (!detail) return null;
  const d = detail as Record<string, unknown>;
  const examples = (Array.isArray(detail) ? detail : d.examples) as
    | ReviewExample[]
    | undefined;
  const known = new Set(["meaning", "explanation", "usageTip", "examples"]);
  const extra = Array.isArray(detail)
    ? []
    : Object.entries(d).filter(
        ([k, v]) => !known.has(k) && typeof v === "string" && v.trim(),
      );

  const line = (label: string, value: unknown) =>
    typeof value === "string" && value.trim() ? (
      <div className="mb-1.5">
        <span className="text-2xs mr-1.5" style={{ color: "var(--rv-faint)" }}>{label}</span>
        <span className="text-xs" style={{ color: "var(--rv-muted)" }}>{value}</span>
      </div>
    ) : null;

  return (
    <div className="mt-2 mb-3">
      {line("Meaning", d.meaning)}
      {line("Why", d.explanation)}
      {line("Watch out", d.usageTip)}
      {extra.map(([k, v]) => line(k, v))}
      {examples?.length ? (
        <div className="mt-2 space-y-1.5">
          {/* 例句默认不显示文字，只给播放键 —— 先用耳朵。
              眼睛一旦看到字，耳朵就不工作了，"听懂"会被"读懂"冒充。 */}
          {examples.map((ex, i) =>
            ex.english?.trim() ? (
              <ListenAndType key={i} text={ex.english} label={ex.scenario} compact />
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function DueCard({ item, index }: { item: ReviewDueItem; index: number }) {
  const qc = useQueryClient();
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState<string>("");

  const grade = useMutation({
    mutationFn: (r: ReviewResult) => api.reviewGrade(item.id, r),
    onSuccess: (r) => {
      setDone(`Next on ${r.next_due}`);
      qc.invalidateQueries({ queryKey: ["review-history"] });
    },
  });

  return (
    <div className="rounded-ctl p-3.5" style={{ background: "var(--rv-surface)", border: "1px solid var(--rv-line)" }}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-2xs font-semibold" style={{ color: "var(--rv-primary)" }}>
          Item {index + 1}
        </span>
        {item.overdue_days > 0 && (
          <span className="text-2xs" style={{ color: "var(--rv-faint)" }}>{item.overdue_days}d overdue</span>
        )}
      </div>
      <div className="text-base font-bold mb-2.5" style={{ color: "var(--rv-ink)" }}>{item.cue}</div>

      {!shown ? (
        <button
          onClick={() => setShown(true)}
          className="px-3.5 py-1.5 rounded-lg text-sm font-medium"
          style={{ border: "1px solid var(--rv-line)", color: "var(--rv-primary)" }}
        >
          Show answer
        </button>
      ) : (
        <>
          {/* 播放键放在文字前面。原来用 flex-1 把它顶到行尾，宽屏上会离
              文字几百像素远 —— 每听一句都要把鼠标横跨整个屏幕。 */}
          <div className="flex items-start gap-2 mb-2">
            <button
              onClick={() => { primeWebSpeech(); primeAudio(); speakText(item.answer); }}
              className="shrink-0 w-8 h-8 rounded-in grid place-items-center transition-colors duration-150 ease-spring active:scale-[.98]"
              style={{ color: "var(--rv-primary)", background: "var(--rv-mint)" }}
              title="Play"
              aria-label="Play the answer"
            >
              <SpeakerHigh size={14} />
            </button>
            <div className="text-base flex-1 min-w-0" style={{ color: "var(--rv-ink)" }}>{item.answer}</div>
          </div>
          {item.example && (
            <div className="text-xs mb-3 leading-relaxed" style={{ color: "var(--rv-muted)" }}>
              {item.example}
            </div>
          )}
          <DetailView detail={item.detail} />
          {!done && (
            <div className="flex flex-wrap gap-2">
              {GRADES.map((g) => (
                <button
                  key={g.k}
                  onClick={() => grade.mutate(g.k)}
                  disabled={grade.isPending}
                  className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-50"
                  style={
                    g.k === "correct"
                      ? { background: "var(--rv-primary)", color: "#fff" }
                      : { border: "1px solid var(--rv-line)", color: "var(--rv-muted)" }
                  }
                  title={g.hint}
                >
                  {g.label}
                </button>
              ))}
            </div>
          )}
          {done && (
            <div className="text-xs inline-flex items-center gap-1" style={{ color: "var(--rv-primary)" }}>
              <Check size={13} weight="bold" /> {done}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────── History

const STATUS_LABEL: Record<string, string> = {
  learning: "Learning", reviewing: "Reviewing", mastered: "Mastered",
};

function HistoryTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["review-history"],
    queryFn: () => api.reviewHistory(),
  });
  if (isLoading) return <p className="text-sm" style={{ color: "var(--rv-muted)" }}>Loading…</p>;
  if (!data?.length) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "var(--rv-muted)" }}>Nothing imported yet.</p>
      </Card>
    );
  }
  return (
    <Card className="!p-0 overflow-hidden">
      {data.map((r, i) => (
        <HistoryRowView key={r.id} row={r} first={i === 0} />
      ))}
    </Card>
  );
}

/** 一行历史。点开看完整答案 + 例句 —— 列表态必须截断（否则一条长释义
 *  会把整页撑宽），所以"看全"这件事得有个去处。 */
function HistoryRowView({ row, first }: { row: ReviewHistoryRow; first: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [graded, setGraded] = useState("");
  const grade = useMutation({
    mutationFn: (r: ReviewResult) => api.reviewGrade(row.id, r),
    onSuccess: (res) => {
      setGraded(`Next on ${res.next_due}`);
      qc.invalidateQueries({ queryKey: ["review-history"] });
      qc.invalidateQueries({ queryKey: ["review-due"] });
    },
  });
  // 可听写的例句：结构化 detail 里的 english 字段，外加纯文本 example。
  const exampleSentences = collectExamples(row);
  return (
    <div style={{ borderTop: first ? "none" : "1px solid var(--rv-line)" }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: "var(--rv-ink)" }}>{row.cue}</div>
          <div className="text-xs truncate" style={{ color: "var(--rv-muted)" }}>
            {open ? "" : row.answer}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xs" style={{ color: "var(--rv-primary)" }}>
            {STATUS_LABEL[row.status] ?? row.status} · {row.stage}/3
          </div>
          <div className="text-2xs" style={{ color: "var(--rv-faint)" }}>
            Next {row.next_due}{row.attempts > 0 && ` · ${row.correct}/${row.attempts} right`}
          </div>
        </div>
        <CaretDown
          size={14}
          className="shrink-0 transition-transform"
          style={{ color: "var(--rv-faint)", transform: open ? "rotate(180deg)" : "none" }}
        />
      </button>
      {open && (
        <div className="px-4 pb-3.5 -mt-1">
          {/* 播放键紧跟文字，不要用 flex-1 把它推到屏幕另一头 —— 宽屏上
              那会离得几百像素远，鼠标要横跨整个页面。 */}
          <div className="flex items-start gap-2">
            <button
              onClick={() => { primeWebSpeech(); primeAudio(); speakText(row.answer); }}
              className="shrink-0 w-8 h-8 rounded-in grid place-items-center transition-colors duration-150 ease-spring active:scale-[.98]"
              style={{ color: "var(--rv-primary)", background: "var(--rv-mint)" }}
              title="Play"
              aria-label="Play the answer"
            >
              <SpeakerHigh size={14} />
            </button>
            <div className="flex-1 min-w-0 text-base leading-relaxed" style={{ color: "var(--rv-ink)" }}>
              {row.answer}
            </div>
          </div>
          {row.example && (
            <div className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--rv-muted)" }}>
              {row.example}
            </div>
          )}
          <DetailView detail={row.detail} />

          {/* 例句听写。历史页不只是"看看学过什么" —— 学过的东西正是最该
              拿来练耳朵的。 */}
          {exampleSentences.length > 0 && (
            <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--rv-line)" }}>
              <div className="text-2xs mb-2" style={{ color: "var(--rv-faint)" }}>
                Dictation
              </div>
              <div className="space-y-2">
                {exampleSentences.map((ex, i) => (
                  <ListenAndType key={i} text={ex.text} label={ex.label} compact />
                ))}
              </div>
            </div>
          )}

          {/* 打分。没有这个的话，复习历史就只是个只读列表 —— 而你在这里
              重新听、重新想，正是一次真实的复习，它应该算数。 */}
          <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--rv-line)" }}>
            {graded ? (
              <div className="text-xs inline-flex items-center gap-1" style={{ color: "var(--rv-primary)" }}>
                <Check size={13} weight="bold" /> {graded}
              </div>
            ) : (
              <>
                <div className="text-2xs mb-2" style={{ color: "var(--rv-faint)" }}>
                  Still remember it? Rate yourself — that sets when it comes back.
                </div>
                <div className="flex flex-wrap gap-2">
                  {GRADES.map((g) => (
                    <button
                      key={g.k}
                      onClick={() => grade.mutate(g.k)}
                      disabled={grade.isPending}
                      className="px-3 py-1.5 rounded-in text-sm disabled:opacity-50 transition-colors duration-150 ease-spring active:scale-[.98]"
                      style={
                        g.k === "correct"
                          ? { background: "var(--rv-primary)", color: "#fff" }
                          : { border: "1px solid var(--rv-line)", color: "var(--rv-muted)" }
                      }
                      title={g.hint}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 从一条记录里凑出可以听写的英文句子。detail 的形状由模型决定，
 *  所以按 shape 取而不是假设字段一定在。 */
function collectExamples(row: ReviewHistoryRow): { text: string; label?: string }[] {
  const out: { text: string; label?: string }[] = [];
  const d = row.detail as Record<string, unknown> | undefined;
  const arr = (Array.isArray(row.detail) ? row.detail : d?.examples) as
    | { scenario?: string; english?: string }[]
    | undefined;
  for (const ex of arr ?? []) {
    if (ex?.english?.trim()) out.push({ text: ex.english.trim(), label: ex.scenario });
  }
  if (!out.length && row.example.trim() && /[a-zA-Z]/.test(row.example)) {
    out.push({ text: row.example.trim() });
  }
  return out;
}

// ─────────────────────────────── Listening

function ListeningTab() {
  const story = useMutation({ mutationFn: () => api.reviewStory([]) });
  const [showStoryText, setShowStoryText] = useState(false);

  return (
    <>
      <Card>
        <div className="text-base font-semibold mb-1" style={{ color: "var(--rv-ink)" }}>
          Turn today's expressions into a short story
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--rv-muted)" }}>
          A ~100-word passage built from what's due today. Listen first, read
          after — the point is catching them in connected speech. Runs on your
          own model and voice.
        </p>
        <button
          onClick={() => story.mutate()}
          disabled={story.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--rv-primary)" }}
        >
          {story.isPending
            ? <><CircleNotch size={13} className="animate-spin" /> Writing…</>
            : <><Headphones size={14} /> Generate a story</>}
        </button>
      </Card>

      {story.isPending && (
        <div className="py-8">
          <LoadingCritter
            label="Writing a short story from today's expressions…"
            hint="Runs on your own model · about 10-30 seconds"
          />
        </div>
      )}

      {story.isError && (
        isByokRequired(story.error)
          ? <NeedApiKey message={story.error.message} />
          : <div className="px-3 py-2 rounded-xl text-xs bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c]">
              {errorDetail(story.error, "Could not generate. Try again.")}
            </div>
      )}

      {story.data && (
        <>
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <button
                type="button"
                onClick={() => { primeWebSpeech(); primeAudio(); speakText(story.data!.story); }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-in text-sm font-medium text-white transition-colors duration-150 ease-spring active:scale-[.98]"
                style={{ background: "var(--rv-primary)" }}
              >
                <SpeakerHigh size={15} /> Play the whole story
              </button>
              <button
                type="button"
                onClick={() => setShowStoryText(!showStoryText)}
                className="px-3 py-2 rounded-in text-sm transition-colors duration-150 ease-spring"
                style={{ border: "1px solid var(--rv-line)", color: "var(--rv-muted)" }}
              >
                {showStoryText ? "Hide text" : "Show text"}
              </button>
            </div>
            {/* 原文默认收着。先整段听一遍抓大意，再逐句听写 —— 一上来
                就看到字，耳朵就不干活了。 */}
            {showStoryText && (
              <p className="text-base leading-relaxed max-w-[68ch]" style={{ color: "var(--rv-ink)" }}>
                {story.data.story}
              </p>
            )}
            <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--rv-line)" }}>
              <div className="text-xs mb-1.5" style={{ color: "var(--rv-faint)" }}>Expressions in this story</div>
              <div className="flex flex-wrap gap-1.5">
                {story.data.expressions.map((e) => (
                  <span key={e} className="px-2 py-1 rounded-in text-xs"
                        style={{ background: "var(--rv-mint)", color: "var(--rv-primary)" }}>
                    {e}
                  </span>
                ))}
              </div>
            </div>
          </Card>

          <div className="mb-2 text-sm" style={{ color: "var(--rv-muted)" }}>
            Sentence by sentence — play one, type what you hear, press Enter to check.
            Enter on an empty box just shows the line.
          </div>
          <div className="space-y-2">
            {splitSentences(story.data.story).map((sent, i) => (
              <ListenAndType key={i} text={sent} label={`Line ${i + 1}`} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** 把一段英文切成句子。
 *
 *  只在 .!? + 空格 + 大写字母 处断开，所以 "Mr. Smith" "U.S." "3.5"
 *  这类不会被切开 —— 缩写后面跟的通常不是大写开头的新句。
 *  生成的故事是 ~100 词的连续散文，这个规则足够；真要处理任意文本
 *  得上分句模型，那不值得。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// ─────────────────────────────── Vocabulary（闪卡）

/**
 * 生词复习做成闪卡，一次只给一张。
 *
 * 之前是把到期的词铺成一列，每张卡自带"Show answer"。列表形态有个根本
 * 问题：下一个词的答案就在视线里，你还没开始回忆就已经读到了。闪卡把
 * 其它的都挡住 —— 这是这个练习唯一真正的机制。
 *
 * 顺手拿回来的三件事：
 * - 键盘：空格翻面，1/2/3 打分。刷 40 个词不用碰鼠标。
 * - 连对计数：连续三个 "Got it" 才亮，亮了就有点想接着刷。
 * - 一轮结束不是空白页，而是"刚才这 6 个没记住，再来一遍"。没记住的
 *   词当场再见一次，比等明天再排队有用得多 —— 但它照样按曲线重排，
 *   这一轮的重刷不写第二次分。
 *
 * 打分接口仍是生词本自己的 /vocabulary/{id}/review，和表达那套各写各的表。
 */
const VOCAB_GRADES: {
  k: "forgot" | "fuzzy" | "got";
  label: string;
  key: string;
  hint: string;
}[] = [
  { k: "forgot", label: "Didn't know", key: "1", hint: "back tomorrow" },
  { k: "fuzzy", label: "Half there", key: "2", hint: "back in a few days" },
  { k: "got", label: "Got it", key: "3", hint: "the more you nail it, the longer the gap" },
];

function VocabTab() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["review-vocab-due"],
    queryFn: () => api.dueVocabulary(60),
  });

  // 这一轮要过的牌。默认是服务端给的到期队列，重刷错题时换成子集。
  const [deck, setDeck] = useState<Vocabulary[] | null>(null);
  const [round, setRound] = useState(0); // 换牌堆时用来重置卡片内部状态
  const active = deck ?? data ?? [];

  if (isLoading) return <p className="text-sm" style={{ color: "var(--rv-muted)" }}>Loading…</p>;
  if (!data?.length) {
    return (
      <Card>
        <div className="text-base font-semibold mb-1" style={{ color: "var(--rv-ink)" }}>No words due today</div>
        <p className="text-xs" style={{ color: "var(--rv-muted)" }}>
          Tap a word while watching to save it — it comes back here on the same curve.
        </p>
      </Card>
    );
  }

  return (
    <Deck
      key={round}
      cards={active}
      onAgain={(missed) => { setDeck(missed); setRound((r) => r + 1); }}
      onRestart={() => { setDeck(null); setRound((r) => r + 1); refetch(); }}
    />
  );
}

function Deck({
  cards, onAgain, onRestart,
}: {
  cards: Vocabulary[];
  onAgain: (missed: Vocabulary[]) => void;
  onRestart: () => void;
}) {
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [tally, setTally] = useState({ forgot: 0, fuzzy: 0, got: 0 });
  const [missed, setMissed] = useState<Vocabulary[]>([]);
  const card = cards[i];
  const done = i >= cards.length;

  const grade = useMutation({
    mutationFn: ({ id, g }: { id: number; g: "forgot" | "fuzzy" | "got" }) =>
      api.reviewVocabulary(id, g),
  });

  const answer = (g: "forgot" | "fuzzy" | "got") => {
    if (!card) return;
    grade.mutate({ id: card.id, g });
    setTally((t) => ({ ...t, [g]: t[g] + 1 }));
    if (g === "got") {
      setStreak((s) => { const n = s + 1; setBest((b) => Math.max(b, n)); return n; });
    } else {
      setStreak(0);
      setMissed((m) => (m.some((x) => x.id === card.id) ? m : [...m, card]));
    }
    setFlipped(false);
    setI((n) => n + 1);
  };

  // 键盘：空格翻面，1/2/3 打分。翻面之前不接受打分 —— 没看答案就点
  // "Got it"，那条记录是假的，而它会真的把这个词推到一年后。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (done) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); setFlipped((f) => !f); return; }
      if (!flipped) return;
      const g = VOCAB_GRADES.find((x) => x.key === e.key);
      if (g) { e.preventDefault(); answer(g.k); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 换到下一张时自动念一遍。第一张不念：那时页面上还没有过任何点击，
  // 浏览器不会放音，只会在控制台留一条被拦截的报错。
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (card) speakText(card.word, { rate: 0.9 });
  }, [card?.id]);

  if (done) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Trophy size={20} weight="fill" style={{ color: "var(--rv-primary)" }} />
          <h3 className="text-lg font-bold" style={{ color: "var(--rv-ink)" }}>
            {cards.length} {cards.length === 1 ? "card" : "cards"} done
          </h3>
        </div>
        <p className="text-sm mb-4" style={{ color: "var(--rv-muted)" }}>
          {tally.got} got it · {tally.fuzzy} half there · {tally.forgot} didn't know
          {best >= 3 && ` · best run ${best} in a row`}
        </p>
        <div className="flex flex-wrap gap-2">
          {missed.length > 0 && (
            <button
              onClick={() => onAgain(missed)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-white transition-colors duration-150 ease-spring active:scale-[.98]"
              style={{ background: "var(--rv-primary)" }}
            >
              <ArrowClockwise size={14} /> Run the {missed.length} you missed
            </button>
          )}
          <button
            onClick={onRestart}
            className="px-4 py-2 rounded-xl text-sm transition-colors duration-150 ease-spring active:scale-[.98]"
            style={{ border: "1px solid var(--rv-line)", color: "var(--rv-muted)" }}
          >
            Start over
          </button>
        </div>
        {missed.length > 0 && (
          <p className="text-xs mt-3" style={{ color: "var(--rv-faint)" }}>
            A second pass now doesn't score again — today's rating is already on the curve.
          </p>
        )}
      </Card>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* 进度条 + 连对。位置固定，翻牌时不跳。 */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--rv-mint)" }}>
          <div
            className="h-full rounded-full transition-[width] duration-300 ease-spring"
            style={{ width: `${(i / cards.length) * 100}%`, background: "var(--rv-primary)" }}
          />
        </div>
        <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--rv-muted)" }}>
          {i + 1} / {cards.length}
        </span>
        {streak >= 3 && (
          <span className="text-xs inline-flex items-center gap-1 shrink-0" style={{ color: "var(--rv-primary)" }}>
            <Fire size={13} weight="fill" /> {streak}
          </span>
        )}
      </div>

      <div className="[perspective:1200px] mb-3">
        <div
          onClick={() => setFlipped((f) => !f)}
          className="grid cursor-pointer [transform-style:preserve-3d] transition-transform duration-500 ease-spring motion-reduce:duration-0"
          style={{ transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
        >
          {/* 正面：只有词。释义、例句、词性一律不给 —— 卡片正面多一个字，
              回忆就少一分。 */}
          <Face>
            <div className="min-h-[190px] flex flex-col items-center justify-center text-center gap-2 py-8">
              <div className="text-3xl font-bold" style={{ color: "var(--rv-ink)" }}>{card.word}</div>
              {card.ipa && (
                <div className="text-sm font-mono" style={{ color: "var(--rv-faint)" }}>{card.ipa}</div>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); primeWebSpeech(); primeAudio(); speakText(card.word, { rate: 0.9 }); }}
                className="mt-1 w-10 h-10 rounded-full grid place-items-center transition-colors duration-150 ease-spring active:scale-[.98]"
                style={{ background: "var(--rv-mint)", color: "var(--rv-primary)" }}
                title="Play"
                aria-label={`Play ${card.word}`}
              >
                <SpeakerHigh size={17} />
              </button>
              <div className="text-xs mt-2" style={{ color: "var(--rv-faint)" }}>
                Recall it, then tap the card — or press Space
              </div>
            </div>
          </Face>

          {/* 背面 */}
          <Face back>
            <div className="min-h-[190px] flex flex-col justify-center py-6">
              <div className="text-xs mb-2" style={{ color: "var(--rv-faint)" }}>{card.word}</div>
              <div className="text-xl font-semibold leading-snug" style={{ color: "var(--rv-ink)" }}>
                {card.definition_zh || card.definition_en}
              </div>
              {card.definition_zh && card.definition_en && (
                <div className="text-sm mt-1.5" style={{ color: "var(--rv-muted)" }}>{card.definition_en}</div>
              )}
              {card.example && (
                <div
                  className="mt-3 pt-3 flex items-start gap-2"
                  style={{ borderTop: "1px solid var(--rv-line)" }}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); primeWebSpeech(); primeAudio(); speakText(card.example); }}
                    className="shrink-0 w-8 h-8 rounded-in grid place-items-center transition-colors duration-150 ease-spring active:scale-[.98]"
                    style={{ background: "var(--rv-mint)", color: "var(--rv-primary)" }}
                    title="Play the example"
                    aria-label="Play the example"
                  >
                    <SpeakerHigh size={14} />
                  </button>
                  <p className="flex-1 min-w-0 text-sm leading-relaxed" style={{ color: "var(--rv-muted)" }}>
                    {highlight(card.example, card.word)}
                  </p>
                </div>
              )}
            </div>
          </Face>
        </div>
      </div>

      {/* 打分只在翻面之后出现。 */}
      {flipped ? (
        <div className="flex flex-wrap gap-2">
          {VOCAB_GRADES.map((g) => (
            <button
              key={g.k}
              onClick={() => answer(g.k)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm transition-colors duration-150 ease-spring active:scale-[.98]"
              style={
                g.k === "got"
                  ? { background: "var(--rv-primary)", color: "#fff" }
                  : { border: "1px solid var(--rv-line)", color: "var(--rv-muted)" }
              }
              title={g.hint}
            >
              {g.label}
              <span className="text-2xs opacity-60 tabular-nums">{g.key}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-xs" style={{ color: "var(--rv-faint)" }}>
          Space to flip · 1 / 2 / 3 to rate
        </div>
      )}
    </div>
  );
}

/** 闪卡的一面。两面叠在同一个 grid 格子里，所以卡片高度由更高的那面
 *  决定，翻面时不会突然长高或塌下去。 */
function Face({ children, back = false }: { children: React.ReactNode; back?: boolean }) {
  return (
    <div
      className="[grid-area:1/1] [backface-visibility:hidden] rounded-2xl px-5"
      style={{
        background: "var(--rv-surface)",
        border: "1px solid var(--rv-line)",
        transform: back ? "rotateY(180deg)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

/** 例句里把这个词本身标出来。查的就是它，扫一眼要能直接落到它身上。
 *  只按词边界匹配，避免 "art" 把 "start" 里的三个字母也涂了。 */
function highlight(sentence: string, word: string) {
  const w = word.trim();
  if (!w) return sentence;
  const re = new RegExp(`(\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*)`, "gi");
  // 一个捕获组 → split 结果里奇数下标就是匹配到的那几段。
  return sentence.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} style={{ color: "var(--rv-primary)" }}>{part}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
