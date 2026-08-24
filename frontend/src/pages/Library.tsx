import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, BookOpen, BookOpenText, Cards, CaretDown, CaretRight, Check, Confetti, MagnifyingGlass, MapPin, NotePencil, SpeakerHigh, X } from "@phosphor-icons/react";
import { Pager } from "@/components/Pager";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Shell } from "@/components/Shell";
import { primeAudio, primeWebSpeech, speakText } from "@/lib/speak";
import { api, type FavChunk, type Note, type Vocabulary } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────
// Library — the user's active study pile.  Three tabs:
//   - Words (vocabulary): manual saves + Words-tab adds, SM-2 reviewed
//   - Chunks: chunks the user marked "+ 学习本" in Learn (favorited
//     chunks repurposed as the study list)
//   - Notes: anything saved via the AskPopup "保存到笔记" + hand-typed
//     notes. Cross-episode view with episode link on each card.
// All three lists support search + infinite scroll. The Words tab also
// surfaces today's SM-2 review queue.
// ─────────────────────────────────────────────────────────────────────

const MASTERY_LABELS = ["新词", "见过", "学习中", "已掌握"];
// 掌握度：灰 → 浅绿 → 中绿 → 成功绿。最后一档沿用全站的成功色
// #16a070（比品牌绿更亮更饱和），"已掌握"读起来才像个达成。
const MASTERY_DOT_CLASS = [
  "bg-gray-300",
  "bg-[#c9dfd0]",
  "bg-[#5e9d81]",
  "bg-[#16a070]",
];

type Tab = "vocab" | "chunks" | "notes";

const PAGE_SIZE = 30;

// 朗读走全站统一入口（学员配的 CosyVoice → 平台声音 → 浏览器兜底）。
//
// 这里原本自己 new 了一个 SpeechSynthesisUtterance，于是生词本永远是浏览器
// 的机器音，跟学员在设置里挑的声音无关。lang 参数一并去掉：那个 en-GB /
// en-US 的区分本来就只是"碰运气看系统装没装对应音色"，真正的英美信号是
// 词条上的 IPA。
function speakWord(word: string) {
  primeWebSpeech();
  primeAudio();
  speakText(word, { rate: 0.9 });
}

// Hook: bottom-of-list sentinel that fires `onHit` once when scrolled into view.
// Returns a callback ref the caller attaches to a marker <div>; using a
// callback ref (vs `useRef`) sidesteps the React types' refusal to allow
// null in RefObject under this project's strictness.
function useInfiniteSentinel(
  onHit: () => void,
  enabled: boolean,
): (el: HTMLDivElement | null) => void {
  const obsRef = useRef<IntersectionObserver | null>(null);
  return (el: HTMLDivElement | null) => {
    obsRef.current?.disconnect();
    obsRef.current = null;
    if (!el || !enabled) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) onHit();
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    obsRef.current = obs;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Library page — header, search input, tabs, list.
// ─────────────────────────────────────────────────────────────────────
export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const initialTab: Tab =
    params.get("tab") === "chunks"
      ? "chunks"
      : params.get("tab") === "notes"
        ? "notes"
        : "vocab";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [reviewMode, setReviewMode] = useState(false);
  const qc = useQueryClient();

  // One search input drives the active tab. Switching tabs preserves the
  // query so a learner who searched "fitness" can flip from Words to Notes
  // without retyping. Reset only when the user types into the box.
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Keep ?tab= in sync so links to /library?tab=notes work.
  useEffect(() => {
    const cur = params.get("tab");
    if (tab === "vocab" && cur !== null) {
      setParams({}, { replace: true });
    } else if (tab !== "vocab" && cur !== tab) {
      setParams({ tab }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Lightweight counts in the tab labels — these unfiltered fetches are
  // capped at 200 each, which is plenty for "X · 12" style indicators
  // without paying for the full search/paginate path.
  const { data: vocabRowsAll = [] } = useQuery({
    queryKey: ["vocabulary", "all-200"],
    queryFn: () => api.listVocabulary({ limit: 200 }).then((r) => r.items),
  });
  const { data: chunksAll = [] } = useQuery({
    queryKey: ["fav-chunks", "all-200"],
    queryFn: () => api.listFavoriteChunks({ limit: 200 }).then((r) => r.items),
  });
  const { data: notesAll = [] } = useQuery({
    queryKey: ["notes", "all-200"],
    queryFn: () => api.listNotes({ limit: 200 }).then((r) => r.items),
  });

  const { data: dueRows = [] } = useQuery({
    queryKey: ["vocab-due"],
    queryFn: () => api.dueVocabulary(50),
  });

  const vocabMastered = vocabRowsAll.filter((v) => v.mastery === 3).length;

  if (reviewMode) {
    return (
      <Shell hideSearch>
        <ReviewSession
          onExit={() => {
            setReviewMode(false);
            qc.invalidateQueries({ queryKey: ["vocab-due"] });
            qc.invalidateQueries({ queryKey: ["vocabulary"] });
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell hideSearch>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="text-xl md:text-xl font-bold inline-flex items-center gap-2">
          <BookOpen size={20} className="text-brand" />
          学习本
        </h2>
        <div className="text-xs text-ink-3">
          生词 {vocabRowsAll.length} · Chunks {chunksAll.length} · 笔记 {notesAll.length}
          {vocabMastered > 0 && (
            <> · 已掌握 <span className="text-ink font-semibold">{vocabMastered}</span></>
          )}
        </div>
      </div>
      <p className="text-xs text-ink-3 mb-5">
        每天回这里走一轮，用 SM-2 间隔复习把短期记忆推到长期记忆。
      </p>

      {/* Today's review CTA — only relevant on the Words tab. */}
      {tab === "vocab" && dueRows.length > 0 && (
        <div className="card p-4 mb-5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 bg-[#fff7ed] border-[#fed7aa]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-white grid place-items-center shrink-0">
              <BookOpenText size={18} className="text-[#285e48]" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-[#285e48]">
                今日复习 {dueRows.length} 个
              </div>
              <div className="text-2xs text-ink-2 mt-0.5">
                基于 SM-2 间隔重复 — 记得就放久点，忘了就近期再来
              </div>
            </div>
          </div>
          <button
            onClick={() => setReviewMode(true)}
            className="btn-primary text-sm shrink-0 ml-auto"
          >
            开始复习
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-line mb-3">
        {([
          { k: "vocab", label: "生词", count: vocabRowsAll.length },
          { k: "chunks", label: "Chunks", count: chunksAll.length },
          { k: "notes", label: "笔记", count: notesAll.length },
        ] as { k: Tab; label: string; count: number }[]).map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`px-4 py-2.5 text-sm font-medium ${
              tab === t.k ? "text-ink border-b-2 border-ink" : "text-ink-2 hover:text-ink"
            }`}
          >
            {t.label} · {t.count}
          </button>
        ))}
      </div>

      {/* Single search input — applies to whichever tab is active. */}
      <div className="relative mb-4">
        <MagnifyingGlass
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            tab === "vocab"
              ? "搜单词…"
              : tab === "chunks"
                ? "搜 chunk 文本或解释…"
                : "搜笔记内容…"
          }
          className="w-full pl-9 pr-9 py-2 rounded-xl border border-line bg-white text-sm focus:outline-none focus:border-brand/60"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
            aria-label="清空"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {tab === "vocab" && <VocabList search={debouncedSearch} qc={qc} />}
      {tab === "chunks" && <ChunkList search={debouncedSearch} qc={qc} />}
      {tab === "notes" && <NoteList search={debouncedSearch} qc={qc} />}
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Vocabulary tab — paginated list of saved words with mastery filter.
// ─────────────────────────────────────────────────────────────────────
function VocabList({
  search,
  qc,
}: {
  search: string;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [filter, setFilter] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  // Reset paging when the query or mastery filter changes.
  useEffect(() => {
    setPage(0);
  }, [search, filter]);

  const { data: pageData, isFetching } = useQuery({
    queryKey: ["vocabulary", "page", search, filter, page],
    queryFn: () =>
      api.listVocabulary({
        mastery: filter ?? undefined,
        q: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });
  const flat = pageData?.items ?? [];
  const total = pageData?.total ?? 0;

  const updateMut = useMutation({
    mutationFn: ({ id, mastery }: { id: number; mastery: number }) =>
      api.updateVocabulary(id, mastery),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vocabulary"] });
      qc.invalidateQueries({ queryKey: ["vocab-due"] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteVocabulary(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["vocabulary"] });
      // Optimistic — drop the row from the cached page so it vanishes
      // immediately instead of waiting on the network roundtrip.
      qc.setQueriesData<{ items: Vocabulary[]; total: number; has_more: boolean }>(
        { queryKey: ["vocabulary", "page"] },
        (old) => old && { ...old, items: old.items.filter((v) => v.id !== id), total: Math.max(0, old.total - 1) },
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["vocabulary"] });
      qc.invalidateQueries({ queryKey: ["vocab-due"] });
    },
  });

  // Mastery counts come from the all-200 query so they don't shift as the
  // user scrolls; if the user has > 200 words this drifts a bit, which is
  // fine for chip labels.
  const { data: allRows = [] } = useQuery({
    queryKey: ["vocabulary", "all-200"],
    queryFn: () => api.listVocabulary({ limit: 200 }).then((r) => r.items),
  });
  const masteryCounts = [0, 0, 0, 0];
  for (const r of allRows) {
    if (r.mastery >= 0 && r.mastery <= 3) masteryCounts[r.mastery]++;
  }

  if (!isFetching && flat.length === 0 && page === 0) {
    return (
      <div className="card p-10 text-center text-ink-2 text-sm">
        {search
          ? `没有匹配「${search}」的生词。`
          : "还没有生词。在 Learn 页字幕里点单词、或在 Words tab 点 + 学习本，词就会落到这里。"}
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-2 mb-4 overflow-x-auto">
        <FilterChip
          label="全部"
          count={allRows.length}
          active={filter === null}
          onClick={() => setFilter(null)}
        />
        {MASTERY_LABELS.map((label, i) => (
          <FilterChip
            key={i}
            label={label}
            count={masteryCounts[i]}
            active={filter === i}
            onClick={() => setFilter(i)}
          />
        ))}
      </div>

      <div className="card overflow-hidden divide-y divide-line/60">
        {flat.map((v) => (
          <VocabRow
            key={v.id}
            v={v}
            expanded={expandedId === v.id}
            onToggle={() => setExpandedId(expandedId === v.id ? null : v.id)}
            onMasteryChange={(m) => updateMut.mutate({ id: v.id, mastery: m })}
            onDelete={() => deleteMut.mutate(v.id)}
          />
        ))}
      </div>

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
      {isFetching && (
        <div className="text-center text-2xs text-ink-3 mt-2">加载中…</div>
      )}
    </>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-150 ease-spring whitespace-nowrap ${
        active
          ? "bg-brand text-white"
          : "bg-[#f0f3f0] text-ink-2 hover:bg-[#e9ebee]"
      }`}
    >
      {label}
      <span className={`text-2xs ${active ? "opacity-80" : "text-ink-3"}`}>{count}</span>
    </button>
  );
}

function VocabRow({
  v,
  expanded,
  onToggle,
  onMasteryChange,
  onDelete,
}: {
  v: Vocabulary;
  expanded: boolean;
  onToggle: () => void;
  onMasteryChange: (m: number) => void;
  onDelete: () => void;
}) {
  const dotClass = MASTERY_DOT_CLASS[v.mastery] ?? MASTERY_DOT_CLASS[0];

  return (
    <div className="group">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[#f8faf8] transition-colors duration-150 ease-spring"
      >
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`}
          title={MASTERY_LABELS[v.mastery] ?? ""}
        />
        <span className="text-base font-semibold text-ink shrink-0">{v.word}</span>
        {v.ipa && (
          <span className="text-2xs text-ink-3 font-mono shrink-0">{v.ipa}</span>
        )}
        {/* min-w-0 不能省：truncate 会设 white-space:nowrap，于是这个 flex
            项的最小内容宽度 = 整条释义。没有 min-w-0 的话 flex-1 缩不下去，
            一条有二十个义项的释义（比如 ramp）会把整行、进而把整页撑宽，
            右边的「开始复习」按钮就被挤出屏幕外了。 */}
        <span className="flex-1 min-w-0 text-xs text-ink-2 truncate">
          {v.definition_zh || v.definition_en}
        </span>
        {v.context_episode_id && (
          <span className="hidden md:inline-flex items-center gap-1 text-2xs text-ink-3 shrink-0">
            <MapPin size={11} />
            1 集
          </span>
        )}
        <span className="text-ink-3 shrink-0">
          {expanded ? (
            <CaretDown size={14} />
          ) : (
            <CaretRight size={14} />
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-[#f8faf8] border-t border-line/40">
          <div className="flex items-start gap-2 mb-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                speakWord(v.word);
              }}
              className="inline-flex items-center gap-1 text-2xs text-ink-3 hover:text-brand"
              title="朗读"
            >
              <SpeakerHigh size={12} /> 朗读
            </button>
            <div className="flex-1" />
            <ConfirmButton
              onConfirm={onDelete}
              confirmLabel="移除"
              className="text-ink-3 hover:text-red-500"
              title="移除"
            >
              <X size={13} />
            </ConfirmButton>
          </div>

          {v.definition_en && (
            <div className="text-sm leading-[1.55] mb-1.5">{v.definition_en}</div>
          )}
          {v.example && (
            <div className="text-xs italic text-ink-2 mb-2 border-l-2 border-line pl-2.5 leading-[1.5]">
              {v.example}
            </div>
          )}
          {v.context_text && (
            <div className="flex items-start gap-1.5 text-2xs text-ink-3 mb-3">
              <MapPin size={11} className="shrink-0 mt-0.5" />
              <span className="flex-1">
                {v.context_text}
                {v.context_episode_id && (
                  <>
                    {" · "}
                    <Link
                      to={`/learn/${v.context_episode_id}`}
                      className="text-brand hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      去上下文
                    </Link>
                  </>
                )}
              </span>
            </div>
          )}

          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-2xs text-ink-3 mr-1">标记：</span>
            {MASTERY_LABELS.map((label, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  onMasteryChange(i);
                }}
                className={`inline-flex items-center gap-1 text-2xs px-2.5 py-1 rounded-full border transition-colors duration-150 ease-spring ${
                  v.mastery === i
                    ? "bg-brand text-white border-brand"
                    : "bg-white border-line text-ink-2 hover:border-brand/50"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    v.mastery === i ? "bg-white" : MASTERY_DOT_CLASS[i]
                  }`}
                />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Chunks tab — paginated, searchable favorited chunks.
// ─────────────────────────────────────────────────────────────────────
function ChunkList({
  search,
  qc,
}: {
  search: string;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [search]);

  const { data: pageData, isFetching } = useQuery({
    queryKey: ["fav-chunks", "page", search, page],
    queryFn: () =>
      api.listFavoriteChunks({
        q: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });
  const flat = pageData?.items ?? [];
  const total = pageData?.total ?? 0;

  const removeMut = useMutation({
    mutationFn: (chunkId: number) => api.removeFavorite("chunk", chunkId),
    onMutate: async (chunkId) => {
      await qc.cancelQueries({ queryKey: ["fav-chunks"] });
      qc.setQueriesData<{ items: FavChunk[]; total: number; has_more: boolean }>(
        { queryKey: ["fav-chunks", "page"] },
        (old) => old && { ...old, items: old.items.filter((c) => c.chunk_id !== chunkId), total: Math.max(0, old.total - 1) },
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["fav-chunks"] });
      qc.invalidateQueries({ queryKey: ["favs", "chunk"] });
      qc.invalidateQueries({ queryKey: ["favs-enriched"] });
    },
  });

  if (!isFetching && flat.length === 0 && page === 0) {
    return (
      <div className="card p-10 text-center text-ink-2 text-sm">
        {search
          ? `没有匹配「${search}」的 Chunks。`
          : (
            <>
              还没有 Chunks。在 Learn 页右栏 Chunks tab 点{" "}
              <span className="inline-flex items-center gap-0.5 align-middle text-brand">
                <Cards size={12} />
              </span>{" "}
              + 学习本，把想反复练的地道说法收到这里。
            </>
          )}
      </div>
    );
  }

  const COLOR_BY_TYPE: Record<string, string> = {
    idiomatic: "bg-chunk-1",
    collocation: "bg-chunk-2",
    discourse: "bg-chunk-3",
    functional: "bg-chunk-4",
    cultural: "bg-chunk-1",
  };

  return (
    <>
      <div className="flex flex-col gap-2.5">
        {flat.map((c) => (
          <article key={c.fav_id} className="card p-3.5 hover:border-ink-2/30 transition">
            <div className="flex items-start gap-2.5">
              <span
                className={`${COLOR_BY_TYPE[c.chunk_type] ?? "bg-chunk-1"} px-2 py-0.5 rounded text-xs font-semibold shrink-0`}
              >
                {c.text}
              </span>
              <span className="text-2xs text-ink-3 mt-1">{c.chunk_type}</span>
              <div className="flex-1" />
              <Link
                to={`/learn/${c.episode_id}`}
                className="inline-flex items-center gap-1 text-2xs text-brand hover:underline"
              >
                去原集 <ArrowRight size={11} />
              </Link>
              <button
                onClick={() => removeMut.mutate(c.chunk_id)}
                className="text-ink-3 hover:text-red-500 transition-colors duration-150 ease-spring"
                title="从学习本移除"
              >
                <X size={13} />
              </button>
            </div>
            {c.why_explanation && (
              <p className="text-xs text-ink-2 leading-[1.55] mt-2">
                {c.why_explanation}
              </p>
            )}
            {c.episode_title && (
              <p className="text-2xs text-ink-3 mt-1.5">{c.episode_title}</p>
            )}
          </article>
        ))}
      </div>
      <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
      {isFetching && (
        <div className="text-center text-2xs text-ink-3 mt-2">加载中…</div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Notes tab — cross-episode list of saved notes (📖 explanations + plain
// hand-typed). Long Markdown bodies are collapsed by default with an
// expand toggle so the list stays scannable; full-text search across
// content runs server-side via /notes?q=.
// ─────────────────────────────────────────────────────────────────────
function NoteList({
  search,
  qc,
}: {
  search: string;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [page, setPage] = useState(0);
  // Click a card → open it in a modal so long bodies don't push siblings
  // off-screen and clip under parent overflow.
  const [modalNote, setModalNote] = useState<Note | null>(null);
  useEffect(() => {
    setPage(0);
  }, [search]);

  const { data: pageData, isFetching } = useQuery({
    queryKey: ["notes", "page", search, page],
    queryFn: () =>
      api.listNotes({
        q: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });
  const flat = pageData?.items ?? [];
  const total = pageData?.total ?? 0;

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteNote(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["notes"] });
      qc.setQueriesData<{ items: Note[]; total: number; has_more: boolean }>(
        { queryKey: ["notes", "page"] },
        (old) => old && { ...old, items: old.items.filter((n) => n.id !== id), total: Math.max(0, old.total - 1) },
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
  });

  if (!isFetching && flat.length === 0 && page === 0) {
    return (
      <div className="card p-10 text-center text-ink-2 text-sm">
        {search
          ? `没有匹配「${search}」的笔记。`
          : (
            <>
              还没有笔记。在 Learn 页用 ⌘K 或选中字幕里的词组，AI 会给你一个详细解释，按
              「保存到笔记」就会落到这里。
            </>
          )}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2.5">
        {flat.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            onOpen={() => setModalNote(n)}
            onDelete={() => deleteMut.mutate(n.id)}
          />
        ))}
      </div>
      <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
      {isFetching && (
        <div className="text-center text-2xs text-ink-3 mt-2">加载中…</div>
      )}
      {modalNote && (
        <NoteDetailModal note={modalNote} onClose={() => setModalNote(null)} />
      )}
    </>
  );
}

function NoteCard({
  note,
  onOpen,
  onDelete,
}: {
  note: Note;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // 📖 = AskPopup explanation, 📝 = sentence-pattern lesson. Both follow
  // the prefix → heading → body shape, both render body via SimpleMarkdown
  // inside the detail modal.
  const isMarkdownNote = /^(📖|📝) /.test(note.content);
  const firstNl = note.content.indexOf("\n");
  const heading = isMarkdownNote
    ? note.content.slice(0, firstNl >= 0 ? firstNl : note.content.length).replace(/^(📖|📝)\s*/, "")
    : note.content.split("\n")[0];
  const body = isMarkdownNote && firstNl >= 0 ? note.content.slice(firstNl).trimStart() : "";
  // Strip Markdown syntax for the 2-line preview so headings/code/bullets
  // don't show as raw `##` / backticks in the card.
  const preview = (body || (isMarkdownNote ? "" : note.content.slice(heading.length).trim()))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();

  return (
    <article
      className="card p-3.5 hover:border-ink-2/30 hover:shadow-sm transition cursor-pointer"
      onClick={onOpen}
    >
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 w-7 h-7 rounded-lg bg-[#eaf3ec] text-[#285e48] grid place-items-center mt-0.5">
          {isMarkdownNote ? (
            <BookOpen size={14} weight="bold" />
          ) : (
            <NotePencil size={13} weight="bold" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold text-ink leading-[1.4] line-clamp-2 break-words">
            {heading || "（空）"}
          </div>
          {preview && (
            <p className="mt-1 text-xs text-ink-2 leading-[1.55] line-clamp-2 break-words">
              {preview}
            </p>
          )}
          <div className="text-2xs text-ink-3 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {note.episode_title && (
              <span>
                来自{" "}
                <Link
                  to={`/learn/${note.episode_id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-ink-2 hover:text-brand hover:underline"
                >
                  《{note.episode_title}》
                </Link>
              </span>
            )}
            {note.created_at && (
              <span title={new Date(note.created_at).toLocaleString()}>
                · {timeAgo(note.created_at)}
              </span>
            )}
          </div>
        </div>
        <ConfirmButton
          onConfirm={onDelete}
          className="text-ink-3 hover:text-red-500 transition-colors duration-150 ease-spring shrink-0"
          title="删除笔记"
        >
          <X size={13} />
        </ConfirmButton>
      </div>
    </article>
  );
}

// Modal detail view — full-screen sheet on mobile, centered dialog on
// desktop. Body scrolls inside the modal so long sentence-pattern or
// AskPopup explanations are never clipped by the page layout.
function NoteDetailModal({
  note,
  onClose,
}: {
  note: Note;
  onClose: () => void;
}) {
  const isMarkdownNote = /^(📖|📝) /.test(note.content);
  const firstNl = note.content.indexOf("\n");
  const heading = isMarkdownNote
    ? note.content.slice(0, firstNl >= 0 ? firstNl : note.content.length).replace(/^(📖|📝)\s*/, "")
    : note.content.split("\n")[0];
  const body = isMarkdownNote && firstNl >= 0
    ? note.content.slice(firstNl).trimStart()
    : note.content.slice(heading.length).trim();

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
              <h3 className="text-base font-bold text-ink leading-[1.4] break-words">
                {heading || "（空）"}
              </h3>
              <div className="text-2xs text-ink-3 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {note.episode_title && (
                  <span>
                    来自{" "}
                    <Link
                      to={`/learn/${note.episode_id}`}
                      onClick={onClose}
                      className="text-ink-2 hover:text-brand hover:underline"
                    >
                      《{note.episode_title}》
                    </Link>
                  </span>
                )}
                {note.created_at && (
                  <span title={new Date(note.created_at).toLocaleString()}>
                    · {timeAgo(note.created_at)}
                  </span>
                )}
              </div>
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

// Tiny Markdown renderer — covers H2, H3, **bold**, `code`, fenced code
// blocks, bullet lists, plain paragraphs. Mirrors the one in Learn.tsx
// without pulling react-markdown (~80kb).
function SimpleMarkdown({ text }: { text: string }) {
  type Block =
    | { kind: "h2"; text: string }
    | { kind: "h3"; text: string }
    | { kind: "code"; text: string }
    | { kind: "ul"; items: string[] }
    | { kind: "p"; text: string };

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    const lines = text.replace(/\r/g, "").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push({ kind: "code", text: buf.join("\n") });
        continue;
      }
      if (/^##\s+/.test(line)) {
        out.push({ kind: "h2", text: line.replace(/^##\s+/, "") });
        i++;
        continue;
      }
      if (/^###\s+/.test(line)) {
        out.push({ kind: "h3", text: line.replace(/^###\s+/, "") });
        i++;
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*]\s+/, ""));
          i++;
        }
        out.push({ kind: "ul", items });
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const buf: string[] = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#|```|[-*]\s)/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push({ kind: "p", text: buf.join(" ") });
    }
    return out;
  }, [text]);

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
    <div className="space-y-3 text-sm leading-[1.7] text-ink">
      {blocks.map((b, i) => {
        if (b.kind === "h2") {
          return (
            <h3 key={i} className="text-base font-bold text-ink mt-3 first:mt-0 border-b border-[#dcebe1] pb-1">
              {renderInline(b.text)}
            </h3>
          );
        }
        if (b.kind === "h3") {
          return <h4 key={i} className="text-sm font-semibold text-ink-2 mt-2.5">{renderInline(b.text)}</h4>;
        }
        if (b.kind === "code") {
          return (
            <pre key={i} className="px-3 py-2.5 rounded-lg bg-[#f4f9f6] border border-[#dcebe1] text-xs text-ink-2 font-mono whitespace-pre-wrap leading-[1.65] overflow-x-auto">
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
        return <p key={i}>{renderInline(b.text)}</p>;
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Flashcard review — recall-first (默默背单词 style) grounded in the
// real video scene the word came from. The session list is FROZEN into
// local state at start: the per-card review mutation must NOT invalidate
// the live ["vocab-due"] query mid-session (doing so reindexed the array
// under the advancing cursor and skipped words). We refresh the badge
// only on exit / complete.
// ─────────────────────────────────────────────────────────────────────
type Grade = "forgot" | "fuzzy" | "got";

// Strip the VTT/markup noise that leaks into stored subtitle text:
// <b>/<c>/timestamp tags, [♪♪♪] / [Music] markers, stray music glyphs,
// HTML entities, >> speaker dashes — then collapse whitespace. Without
// this the flashcard renders literal "</b>" and song-lyric junk.
function cleanSubtitle(s: string): string {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[♪♫►▶]/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/>>+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// From a (possibly multi-line) blob, return the single sentence that
// contains `word`. Falls back to the whole cleaned blob, or "" if the
// word isn't in there at all (caller then shows the zh prompt instead).
function pickSentence(text: string, word: string): string {
  const clean = cleanSubtitle(text);
  if (!clean) return "";
  const w = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!w) return "";
  const re = new RegExp(`\\b${w}(?:s|es|ed|ing|d)?\\b`, "i");
  // 1. Prefer a real sentence (split on . ! ?).
  const parts = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  let cand = (parts.find((p) => re.test(p)) || "").trim();
  if (!cand && re.test(clean)) cand = clean;
  if (!cand) return "";
  // 2. Run-on captions / song lyrics have no punctuation, so step 1 can
  //    return a 200-word wall. Clamp to a tight window of words centred
  //    on the target so the cloze stays one readable line.
  const MAX_WORDS = 20;
  const words = cand.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_WORDS) return cand;
  const m = cand.match(re);
  const before = m ? cand.slice(0, m.index ?? 0).split(/\s+/).filter(Boolean).length : 0;
  const PAD = 8;
  const start = Math.max(0, before - PAD);
  const end = Math.min(words.length, before + PAD + 1);
  let snippet = words.slice(start, end).join(" ");
  if (start > 0) snippet = "… " + snippet;
  if (end < words.length) snippet = snippet + " …";
  return snippet;
}

// Blank the target word inside its original sentence so the learner
// recalls it IN context. Matches the word (and a trailing -s/-ed/-ing
// so simple inflections still blank) on word boundaries, case-insensitive.
function clozeSentence(sentence: string, word: string): string | null {
  const w = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!w) return null;
  const re = new RegExp(`\\b${w}(?:s|es|ed|ing|d)?\\b`, "ig");
  if (!re.test(sentence)) return null;
  return sentence.replace(re, "______");
}

function ReviewSession({ onExit }: { onExit: () => void }) {
  const qc = useQueryClient();
  const { data: due = [], isLoading } = useQuery({
    queryKey: ["vocab-due"],
    queryFn: () => api.dueVocabulary(50),
  });

  // Frozen session queue (seeded once from `due`). Forgot/fuzzy cards get
  // appended once so they get a second pass this session.
  const [queue, setQueue] = useState<Vocabulary[]>([]);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState({ got: 0, fuzzy: 0, forgot: 0 });
  const requeued = useRef<Set<number>>(new Set());
  // Per-card grade this session, keyed by vocab id. Lets "← 上一个"
  // re-grade a card: we subtract the old grade from the tally before
  // applying the new one so the stats stay correct.
  const graded = useRef<Map<number, Grade>>(new Map());
  const enriching = useRef<Set<number>>(new Set());
  // Lazy "画面解释" cache, keyed by vocab id.
  const [explain, setExplain] = useState<
    Record<number, { loading: boolean; md?: string; error?: boolean }>
  >({});

  // Seed the frozen queue once when the due list first arrives.
  useEffect(() => {
    if (queue.length === 0 && due.length > 0) {
      setQueue([...due]);
      setPos(0);
      setDone({ got: 0, fuzzy: 0, forgot: 0 });
      requeued.current = new Set();
      graded.current = new Map();
    }
  }, [due, queue.length]);

  const reviewMut = useMutation({
    mutationFn: ({ id, grade }: { id: number; grade: Grade }) =>
      api.reviewVocabulary(id, grade),
    // NOTE: deliberately no onSuccess invalidate — see header comment.
  });

  const card = queue[pos];
  const complete = queue.length > 0 && pos >= queue.length;

  const grade = (g: Grade) => {
    if (!card) return;
    const prev = graded.current.get(card.id);
    reviewMut.mutate({ id: card.id, grade: g });
    // Re-grade (came back via ← 上一个): undo the previous tally first.
    setDone((d) => {
      const next = { ...d };
      if (prev) next[prev] = Math.max(0, next[prev] - 1);
      next[g] = next[g] + 1;
      return next;
    });
    graded.current.set(card.id, g);
    // Shaky words get one more pass at the end of this session — but only
    // append once, and never when this is a correction of an earlier grade.
    if (
      (g === "forgot" || g === "fuzzy") &&
      !prev &&
      !requeued.current.has(card.id)
    ) {
      requeued.current.add(card.id);
      setQueue((q) => [...q, card]);
    }
    setFlipped(false);
    setPos((p) => p + 1);
  };

  // ← 上一个: step back one card, land on its reveal side so the learner
  // can re-read and optionally re-grade (which overwrites — see grade()).
  const goBack = () => {
    if (pos === 0) return;
    setPos((p) => Math.max(0, p - 1));
    setFlipped(true);
  };

  // Lazily backfill Eudic-style rich fields for legacy rows on first flip.
  const ensureRich = (c: Vocabulary) => {
    if (!c || (c.senses && c.senses.length) || enriching.current.has(c.id))
      return;
    enriching.current.add(c.id);
    api
      .enrichVocabulary(c.id)
      .then((rich) =>
        setQueue((q) => q.map((x) => (x.id === rich.id ? { ...x, ...rich } : x))),
      )
      .catch(() => {
        /* leave legacy fields; non-fatal */
      });
  };

  const loadExplain = () => {
    if (!card || card.context_episode_id == null) return;
    if (explain[card.id]?.md || explain[card.id]?.loading) return;
    setExplain((e) => ({ ...e, [card.id]: { loading: true } }));
    api
      .explainInContext(card.word, card.context_episode_id, card.context_subtitle_id)
      .then((r) =>
        setExplain((e) => ({ ...e, [card.id]: { loading: false, md: r.markdown } })),
      )
      .catch(() =>
        setExplain((e) => ({ ...e, [card.id]: { loading: false, error: true } })),
      );
  };

  const exitToLibrary = () => {
    qc.invalidateQueries({ queryKey: ["vocab-due"] });
    onExit();
  };

  const restart = () => {
    qc.invalidateQueries({ queryKey: ["vocab-due"] });
    requeued.current = new Set();
    graded.current = new Map();
    setDone({ got: 0, fuzzy: 0, forgot: 0 });
    setPos(0);
    setQueue([]); // re-seed effect picks up the refetched due list
  };

  // When a card is revealed, lazily enrich it if it's a legacy row.
  useEffect(() => {
    if (flipped && card) ensureRich(card);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipped, card?.id]);

  // Keyboard: Space flips, 1/2/3 grade, ←/Backspace go back.
  useEffect(() => {
    if (complete || !card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
        e.preventDefault();
        goBack();
      } else if (e.key === "1") grade("forgot");
      else if (e.key === "2") grade("fuzzy");
      else if (e.key === "3") grade("got");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete, card, pos]);

  if (isLoading && queue.length === 0)
    return <div className="text-sm text-ink-2">加载复习卡片…</div>;

  if (queue.length === 0 || complete) {
    return (
      <div className="card p-10 text-center space-y-3 max-w-md mx-auto">
        <Confetti size={36} className="text-[#4f9c80] mx-auto" />
        <div className="text-base font-bold">
          {queue.length === 0 ? "今天没有要复习的词" : "本轮复习完成 🎉"}
        </div>
        {queue.length > 0 && (
          <div className="text-sm text-ink-2 flex items-center gap-3 justify-center flex-wrap">
            <span className="text-[#16a070]">记得 {done.got}</span>
            <span className="text-ink-3">·</span>
            <span className="text-[#b27700]">模糊 {done.fuzzy}</span>
            <span className="text-ink-3">·</span>
            <span className="text-[#2f755f]">忘了 {done.forgot}</span>
          </div>
        )}
        <div className="pt-2 flex gap-2 justify-center">
          {queue.length > 0 && due.length > 0 && (
            <button onClick={restart} className="btn-primary text-sm">
              再来一组
            </button>
          )}
          <button
            onClick={exitToLibrary}
            className="text-sm px-4 py-2 rounded-xl border border-line text-ink-2 hover:text-ink"
          >
            返回学习本
          </button>
        </div>
      </div>
    );
  }

  // The single clean video sentence this word came from (markup stripped).
  const videoSentence = pickSentence(card.context_text || "", card.word);
  const cloze = videoSentence ? clozeSentence(videoSentence, card.word) : null;
  const ex = explain[card.id];
  const ipaUs = card.ipa_us || card.ipa || "";
  const ipaUk = card.ipa_uk || "";
  // Prefer the rich sense list; fall back to the legacy single def so old
  // rows still show something while lazy-enrich runs in the background.
  const senses =
    card.senses && card.senses.length
      ? card.senses
      : card.definition_zh || card.definition_en
        ? [{ pos: "", zh: card.definition_zh, en: card.definition_en }]
        : [];
  const recallPrompt =
    senses[0]?.zh || card.definition_zh || card.definition_en || "回忆这个词的英文";

  // Highlight the target word inside the clean video sentence.
  const highlighted = (() => {
    if (!videoSentence) return null;
    const w = card.word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(\\b${w}(?:s|es|ed|ing|d)?\\b)`, "i");
    const parts = videoSentence.split(re);
    return parts.map((p, i) =>
      re.test(p) && p.toLowerCase().startsWith(card.word.toLowerCase().slice(0, 3))
        ? <mark key={i} className="bg-[#fff2cc] text-ink rounded px-0.5">{p}</mark>
        : <span key={i}>{p}</span>,
    );
  })();

  return (
    <div className="max-w-md mx-auto pt-4">
      <div className="flex justify-between items-center mb-2 text-xs text-ink-2">
        <button onClick={exitToLibrary} className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft size={12} /> 退出
        </button>
        <span>{pos + 1} / {queue.length}</span>
      </div>
      <div className="h-1 rounded-full bg-[#eff2ef] mb-3 overflow-hidden">
        <div
          className="h-full bg-brand transition-[width] duration-300"
          style={{ width: `${(pos / queue.length) * 100}%` }}
        />
      </div>

      <div
        className="card p-7 min-h-[300px] flex flex-col gap-4 cursor-pointer select-none"
        onClick={() => setFlipped((f) => !f)}
      >
        {!flipped ? (
          // ── Recall side: word blanked in its real sentence ──
          <div className="flex-1 flex flex-col justify-center text-center gap-4">
            <div className="text-2xs uppercase tracking-widest text-ink-3">
              回忆这个词
            </div>
            {cloze ? (
              <div className="text-lg leading-[1.7] text-ink px-1">{cloze}</div>
            ) : (
              <div className="text-base text-ink-2 leading-[1.6]">
                {recallPrompt}
              </div>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                speakWord(card.word);
              }}
              className="mx-auto inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-brand transition-colors duration-150 ease-spring"
              title="听发音（提示）"
            >
              <SpeakerHigh size={15} /> 听一下
            </button>
            <div className="text-xs text-ink-3 mt-auto">想不起来？点卡片翻面看答案</div>
          </div>
        ) : (
          // ── Reveal side (Eudic-style) ──
          <div className="flex flex-col gap-3">
            {/* Headword + dual UK/US pronunciation */}
            <div className="text-center">
              <h3 className="text-2xl font-bold">{card.word}</h3>
              <div className="mt-1.5 flex items-center justify-center gap-4 text-sm text-ink-3">
                {ipaUk && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      speakWord(card.word);
                    }}
                    className="inline-flex items-center gap-1 hover:text-brand transition-colors duration-150 ease-spring"
                    title="听发音（英式音标见左）"
                  >
                    <span className="text-2xs text-ink-3">英</span>
                    <span className="font-mono">{ipaUk}</span>
                    <SpeakerHigh size={14} />
                  </button>
                )}
                {ipaUs && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      speakWord(card.word);
                    }}
                    className="inline-flex items-center gap-1 hover:text-brand transition-colors duration-150 ease-spring"
                    title="听发音（美式音标见左）"
                  >
                    <span className="text-2xs text-ink-3">美</span>
                    <span className="font-mono">{ipaUs}</span>
                    <SpeakerHigh size={14} />
                  </button>
                )}
                {!ipaUk && !ipaUs && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      speakWord(card.word);
                    }}
                    className="inline-flex items-center gap-1 hover:text-brand"
                    title="听发音"
                  >
                    <SpeakerHigh size={15} /> 听发音
                  </button>
                )}
              </div>
            </div>

            {/* Inflections */}
            {card.inflections && (
              <div className="text-center text-xs text-ink-3">
                <span className="text-ink-3/70">变形：</span>
                {card.inflections}
              </div>
            )}

            {/* Sense list (numbered, POS-tagged) */}
            {senses.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-line/60 pt-3">
                {senses.map((s, i) => (
                  <div key={i} className="flex gap-2 text-sm leading-[1.55]">
                    {senses.length > 1 && (
                      <span className="text-ink-3 shrink-0">{i + 1}.</span>
                    )}
                    <div>
                      {s.pos && (
                        <span className="mr-1.5 text-xs italic text-brand">
                          {s.pos}
                        </span>
                      )}
                      <span className="text-ink">{s.zh}</span>
                      {s.en && (
                        <div className="text-xs text-ink-3 leading-[1.5] mt-0.5">
                          {s.en}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 来自视频 — the real sentence this word came from */}
            <div className="border-t border-line/60 pt-3">
              <div className="text-2xs text-ink-3 mb-1.5 flex items-center gap-1">
                📺 来自视频
                {card.context_episode_id != null && (
                  <Link
                    to={`/learn/${card.context_episode_id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-auto text-brand font-medium hover:underline"
                  >
                    ▶ 在原片重看
                  </Link>
                )}
              </div>
              {highlighted ? (
                <div className="text-sm leading-[1.65] text-ink bg-[#f8faf8] border border-line/60 rounded-lg p-2.5">
                  {highlighted}
                </div>
              ) : (
                <div className="text-xs text-ink-3 italic">
                  这个词没有保存原片例句
                </div>
              )}
            </div>

            {/* 画面解释 (on demand) */}
            {card.context_episode_id != null && !ex?.md && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  loadExplain();
                }}
                disabled={ex?.loading}
                className="self-start inline-flex items-center gap-1 text-xs text-ink-2 hover:text-brand disabled:opacity-50"
              >
                💡 {ex?.loading ? "正在讲画面…" : "要画面解释"}
              </button>
            )}
            {ex?.error && (
              <div className="text-xs text-[#2f755f]">画面解释生成失败，稍后再试。</div>
            )}
            {ex?.md && (
              <div
                className="border-t border-line pt-3 mt-1"
                onClick={(e) => e.stopPropagation()}
              >
                <SimpleMarkdown text={ex.md} />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex justify-start">
        <button
          onClick={(e) => { e.stopPropagation(); goBack(); }}
          disabled={pos === 0}
          className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
          title="回到上一个词（可重新评分）"
        >
          <ArrowLeft size={13} /> 上一个
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-2">
        <button
          onClick={(e) => { e.stopPropagation(); grade("forgot"); }}
          className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] font-semibold text-sm"
        >
          <ArrowCounterClockwise size={14} /> 忘了
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); grade("fuzzy"); }}
          className="inline-flex items-center justify-center py-2.5 rounded-xl bg-[#fffbeb] border border-[#fde68a] text-[#b27700] font-semibold text-sm"
        >
          模糊
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); grade("got"); }}
          className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#f0fdf4] border border-[#bbf7d0] text-[#15803d] font-semibold text-sm"
        >
          <Check size={14} weight="bold" /> 记得
        </button>
      </div>
    </div>
  );
}
