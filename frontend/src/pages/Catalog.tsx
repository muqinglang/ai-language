import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Cards, MagnifyingGlass, Play, SlidersHorizontal, X } from "@phosphor-icons/react";
import { EpisodeCardView } from "@/components/EpisodeCard";
import { Pager } from "@/components/Pager";
import { Shell } from "@/components/Shell";
import { api, type DiscoverItem } from "@/lib/api";
import { TOPIC_META } from "@/lib/topicMeta";

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// A collection card — backend already folded the same-source segments
// into one DiscoverItem (kind="collection"), so this is pure render.
function CollectionCard({ item }: { item: DiscoverItem }) {
  const topic = TOPIC_META[item.topic];
  const showTopic = topic && item.topic !== "other";
  return (
    <Link
      to={`/collection/${item.youtube_id}`}
      className="card overflow-hidden block hover:border-ink-2/40 hover:shadow-md transition-all group"
    >
      <div className="aspect-[16/10] bg-[#f0f3f0] relative overflow-hidden">
        {item.thumbnail_url && (
          <img
            src={item.thumbnail_url}
            alt=""
            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          />
        )}
        {showTopic && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 bg-white/95 text-ink text-2xs px-2 py-1 rounded-md font-medium shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: topic.color }} />
            {topic.name}
          </span>
        )}
        <span className="absolute right-2 top-2 bg-brand text-white text-2xs px-2 py-0.5 rounded-md font-semibold">
          📚 {item.segment_count} 段切片
        </span>
        <span className="absolute right-2 bottom-2 bg-black/60 text-white text-2xs px-2 py-0.5 rounded-md font-medium">
          共 {fmtDur(item.total_duration_sec)}
        </span>
        <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-11 h-11 rounded-full bg-white/95 grid place-items-center shadow-lg">
            <Play size={20} className="text-ink translate-x-[1px]" weight="fill" />
          </div>
        </div>
      </div>
      <div className="px-3.5 py-3">
        <h4 className="text-sm font-semibold leading-snug line-clamp-2">{item.title}</h4>
        <div className="flex items-center gap-3 text-2xs text-ink-3 mt-2.5">
          <span className="inline-flex items-center gap-1">
            <Cards size={12} />
            {item.segment_count} 段
          </span>
          {item.creator && <span className="truncate">{item.creator}</span>}
        </div>
      </div>
    </Link>
  );
}

const DIFFS = [
  { v: undefined, label: "全部" },
  { v: 1, label: "入门" },
  { v: 2, label: "进阶" },
  { v: 3, label: "中级" },
  { v: 4, label: "高级" },
  { v: 5, label: "母语" },
];

const SORTS = [
  { v: "latest", label: "最新" },
  { v: "shortest", label: "时长升序" },
];

type ChipOption<T> = { v: T; label: string; dotColor?: string };

function ChipRow<T>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ChipOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="text-xs text-ink-2 min-w-[48px] mt-2">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <button
            key={i}
            onClick={() => onChange(o.v)}
            className={`chip inline-flex items-center gap-1.5 ${value === o.v ? "chip-on" : ""}`}
          >
            {o.dotColor && (
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: o.dotColor }}
              />
            )}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Catalog() {
  const [sp, setSp] = useSearchParams();
  // Filter axes were cut from 6 → 3 (话题 primary; 博主 + 难度 behind
  // "更多筛选"). 格式/类型/口音 were dropped from the UI: they slice a
  // ~dozens-sized catalog into noise and feed the choice-paralysis the
  // anchor-path model exists to kill. The backend still accepts them.
  const topic = sp.get("topic") ?? undefined;
  const difficulty = sp.get("difficulty") ? Number(sp.get("difficulty")) : undefined;
  const sort = sp.get("sort") ?? "latest";
  const creatorParam = sp.get("creator");
  const creatorId = creatorParam ? Number(creatorParam) : undefined;

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const { data: topics } = useQuery({ queryKey: ["topics"], queryFn: api.topics });
  const { data: creators } = useQuery({ queryKey: ["creators"], queryFn: api.creators });
  const EP_SIZE = 24;
  // Page-number navigation: backend already folds same-source segments
  // into collection units and paginates by unit, so each page is N whole
  // cards. Filter changes reset to page 0; clicking 上一页/下一页
  // scrolls to top so the grid header is visible.
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [topic, difficulty, sort, creatorId]);
  const { data: pageData } = useQuery({
    queryKey: ["episodes", topic, difficulty, sort, creatorId, page],
    queryFn: () =>
      api.episodes({
        topic, difficulty, sort, creator: creatorId,
        page: page + 1, size: EP_SIZE,
      }),
  });
  const items = pageData?.items ?? [];
  const epTotal = pageData?.total ?? 0;
  const goPage = (p: number) => {
    setPage(p);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const topicOptions = useMemo<ChipOption<string | undefined>[]>(
    () => [
      { v: undefined, label: "全部" },
      ...((topics ?? []).map((t) => ({
        v: t.slug,
        label: t.name,
        dotColor: TOPIC_META[t.slug]?.color,
      }))),
    ],
    [topics],
  );

  const creatorOptions = useMemo<ChipOption<number | undefined>[]>(
    () => [
      { v: undefined, label: "全部" },
      ...((creators ?? []).map((c) => ({
        v: c.id,
        label: c.name || c.handle.replace("@", ""),
      }))),
    ],
    [creators],
  );

  const update = (key: string, v: unknown) => {
    const next = new URLSearchParams(sp);
    if (v === undefined || v === null || v === "") next.delete(key);
    else next.set(key, String(v));
    setSp(next);
  };

  const clearAll = () => {
    const next = new URLSearchParams();
    if (sort !== "latest") next.set("sort", sort);
    setSp(next);
  };

  // Count how many filter dimensions are actively narrowing the list
  // (sort isn't a narrowing filter — don't include it).
  const activeFilterCount =
    (topic ? 1 : 0) +
    (creatorId != null ? 1 : 0) +
    (difficulty != null ? 1 : 0);
  const secondaryActive = creatorId != null || difficulty != null || sort !== "latest";

  const sortLabel = SORTS.find((s) => s.v === sort)?.label ?? "最新";

  const PrimaryFilter = (
    <ChipRow
      label="话题"
      options={topicOptions}
      value={topic}
      onChange={(v) => update("topic", v)}
    />
  );

  const SecondaryFilters = (
    <>
      {creators && creators.length > 0 && (
        <ChipRow
          label="博主"
          options={creatorOptions}
          value={creatorId}
          onChange={(v) => update("creator", v)}
        />
      )}
      <ChipRow
        label="难度"
        options={DIFFS}
        value={difficulty}
        onChange={(v) => update("difficulty", v)}
      />
      <ChipRow
        label="排序"
        options={SORTS}
        value={sort}
        onChange={(v) => update("sort", v)}
      />
    </>
  );

  return (
    <Shell>
      {/* Mobile compact filter bar */}
      <div className="md:hidden flex items-center gap-2 mb-4">
        <button
          onClick={() => setFiltersOpen(true)}
          className={`chip inline-flex items-center gap-1.5 ${activeFilterCount > 0 ? "chip-on" : ""}`}
        >
          <SlidersHorizontal size={14} />
          筛选{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
        </button>
        <div className="relative">
          <select
            value={sort}
            onChange={(e) => update("sort", e.target.value === "latest" ? undefined : e.target.value)}
            className="chip appearance-none pr-6"
            style={{ paddingLeft: "0.75rem" }}
          >
            {SORTS.map((s) => (
              <option key={s.v} value={s.v}>
                排序 · {s.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 text-2xs">▾</span>
        </div>
        {activeFilterCount > 0 && (
          <button
            onClick={clearAll}
            className="ml-auto text-xs text-ink-3 hover:text-ink"
          >
            清除
          </button>
        )}
      </div>

      {/* Desktop filter card — 话题 always; the rest behind 更多筛选 */}
      <div className="hidden md:flex card p-4 mb-5 flex-col gap-3">
        {PrimaryFilter}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className={`chip inline-flex items-center gap-1.5 ${secondaryActive ? "chip-on" : ""}`}
          >
            <SlidersHorizontal size={13} />
            更多筛选{secondaryActive ? " ·" : ""}
            <span className="text-2xs">{moreOpen ? "▴" : "▾"}</span>
          </button>
          {activeFilterCount > 0 && (
            <button onClick={clearAll} className="text-xs text-ink-3 hover:text-ink">
              清除筛选
            </button>
          )}
        </div>
        {moreOpen && <div className="flex flex-col gap-3 pt-1">{SecondaryFilters}</div>}
      </div>

      <div className="flex items-center justify-between text-sm text-ink-2 mb-3">
        <span>
          共 <b className="text-ink">{epTotal}</b> 个内容
          <span className="text-ink-3"> · 同源多段已合并为合集</span>
        </span>
        <span className="md:hidden text-2xs text-ink-3">{sortLabel}</span>
      </div>

      {/* 空态。原来筛没结果时只剩一个空网格 —— 页面看起来像加载失败了，
          而实际只是筛太窄。给出原因和一步出路，别让人自己猜。 */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-line bg-white px-6 py-12 text-center">
          <MagnifyingGlass size={24} className="mx-auto text-ink-3 mb-3" />
          <div className="text-sm font-semibold mb-1">
            {activeFilterCount > 0 ? "这些条件下没有内容" : "还没有已发布的内容"}
          </div>
          <p className="text-xs text-ink-2 mb-4 max-w-sm mx-auto">
            {activeFilterCount > 0
              ? `当前有 ${activeFilterCount} 个筛选条件。放宽一点试试。`
              : "管理员导入并发布之后，视频会出现在这里。"}
          </p>
          {activeFilterCount > 0 && (
            <button onClick={clearAll} className="btn-ghost text-sm">
              清除全部筛选
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 md:gap-3.5">
          {items.map((it) =>
            it.kind === "episode" && it.episode
              ? <EpisodeCardView key={`e${it.episode.id}`} ep={it.episode} />
              : <CollectionCard key={`c${it.youtube_id}`} item={it} />,
          )}
        </div>
      )}

      <Pager page={page} pageSize={EP_SIZE} total={epTotal} onPage={goPage} />

      {/* Mobile bottom sheet */}
      {filtersOpen && (
        <div
          className="md:hidden fixed inset-0 z-50"
          onClick={() => setFiltersOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute bottom-0 inset-x-0 bg-white rounded-t-2xl max-h-[85dvh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <h3 className="font-semibold text-base">筛选</h3>
              <button
                onClick={() => setFiltersOpen(false)}
                className="w-8 h-8 grid place-items-center rounded-full text-ink-3 hover:bg-[#f0f3f0]"
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-4 py-4 flex flex-col gap-4">
              {PrimaryFilter}
              {SecondaryFilters}
            </div>
            <div className="px-4 py-3 border-t border-line flex items-center gap-2 pb-[calc(12px+env(safe-area-inset-bottom))]">
              <button
                onClick={clearAll}
                className="btn-ghost flex-1"
                disabled={activeFilterCount === 0}
              >
                清除全部
              </button>
              <button
                onClick={() => setFiltersOpen(false)}
                className="btn-primary flex-1"
              >
                查看 {epTotal} 个结果
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
