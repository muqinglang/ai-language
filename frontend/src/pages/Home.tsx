import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowsClockwise, Check, Compass, Fire, Lock, Play, Question } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { ApiKeyNudge } from "@/components/ApiKeyNudge";
import { HowToModal } from "@/components/HowToModal";
import { Pager } from "@/components/Pager";
import { RecentView } from "@/components/RecentView";
import { Shell } from "@/components/Shell";
import { api, currentUser, patchCurrentUser, type MyAnchor, type TopicCard } from "@/lib/api";

// Self-reported level (only stored at adopt; level-based ordering is future work).
const LEVELS: { v: number; label: string }[] = [
  { v: 1, label: "入门" },
  { v: 2, label: "进阶" },
  { v: 3, label: "中级" },
  { v: 4, label: "高级" },
];

function fmtDuration(sec: number) {
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

// ---------- Topic chip grid (shared by onboarding + switch) ----------
function TopicGrid({
  topics,
  selected,
  onPick,
}: {
  topics: TopicCard[];
  selected?: string;
  onPick: (slug: string) => void;
}) {
  if (topics.length === 0) {
    return (
      <div className="text-sm text-ink-2 card p-4">
        平台上还没有任何话题有内容。让管理员先发布几集再来。
        <Link to="/catalog" className="text-brand block mt-1.5 text-sm">
          先去 Discover 看看全部内容 →
        </Link>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
      {topics.map((t) => (
        <button
          key={t.slug}
          onClick={() => onPick(t.slug)}
          className={`text-left p-3 rounded-xl border transition ${
            selected === t.slug ? "border-brand bg-[#f4f9f6]" : "border-line hover:border-ink-2/40"
          }`}
        >
          <div className="text-base font-semibold">
            <span className="mr-1">{t.icon}</span>
            {t.name}
          </div>
          <div className="text-2xs text-ink-2 mt-0.5">{t.episode_count} 段可学</div>
        </button>
      ))}
    </div>
  );
}

// ---------- Onboarding: pick ONE topic ----------
function Onboarding({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [topic, setTopic] = useState<string | null>(null);
  const [level, setLevel] = useState<number>(2);
  const { data: topics, isLoading, error } = useQuery({
    queryKey: ["anchor-topics"],
    queryFn: () => api.anchorTopics(),
  });
  const adopt = useMutation({
    mutationFn: () => api.adoptAnchor(topic!, level),
    onSuccess: onDone,
  });

  return (
    <div className="max-w-2xl mx-auto pt-6">
      <h1 className="text-xl font-bold mb-1">选一个话题，啃两周</h1>
      <p className="text-sm text-ink-2 mb-7 leading-relaxed">
        同一个话题反复听 —— 旅行的高频词、做饭的固定搭配会不断复现，
        你慢慢就能<b className="text-ink">预测下一句</b>、<b className="text-ink">下意识模仿</b>。
        博主谁不重要，话题别换才重要。
      </p>

      <div className="mb-6">
        <div className="text-2xs uppercase tracking-widest text-ink-3 font-semibold mb-2.5">
          你想啃哪个话题
        </div>
        {isLoading ? (
          <div className="text-sm text-ink-3 card p-4">载入话题中…</div>
        ) : error ? (
          <div className="text-sm text-red-600 card p-4">
            话题加载失败：{error instanceof Error ? error.message : String(error)}
            <Link to="/catalog" className="text-brand block mt-1.5 text-xs">
              先去 Discover 看看全部内容 →
            </Link>
          </div>
        ) : (
          <TopicGrid topics={topics ?? []} selected={topic ?? undefined} onPick={setTopic} />
        )}
      </div>

      <div className="mb-7">
        <div className="text-2xs uppercase tracking-widest text-ink-3 font-semibold mb-2.5">
          你的英文水平
        </div>
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((l) => (
            <button
              key={l.v}
              onClick={() => setLevel(l.v)}
              className={`chip ${level === l.v ? "chip-on" : ""}`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {topic && (
        <button
          onClick={() => adopt.mutate()}
          disabled={adopt.isPending}
          className="btn-primary w-full disabled:opacity-50"
        >
          开始啃「{topics?.find((t) => t.slug === topic)?.name}」
        </button>
      )}

      {/* Discover, for the learner who won't commit on day one.  A first-time
          user who doesn't recognise any topic name used to have only a 12px
          grey line out of here, so this screen was a dead end — now browsing
          is a first-class second option. */}
      <div className="mt-8 pt-6 border-t border-line text-center">
        <p className="text-sm text-ink-2 mb-3 leading-relaxed">
          还拿不定主意？先去 <b className="text-ink">Discover</b> 翻一翻全部视频，
          看到喜欢的直接开学，话题随时可以再锁。
        </p>
        <Link
          to="/catalog"
          className="btn-ghost inline-flex items-center gap-1.5 text-sm"
        >
          <Compass size={15} /> 去 Discover 逛逛
        </Link>
        {/* Opt-out: skip the anchor, jump straight to "what I was watching". */}
        <div className="mt-5">
          <button
            onClick={onSkip}
            className="text-sm text-ink-2 hover:text-ink"
          >
            暂时不锁定话题，看看我学过的 →
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Switch / next-topic modal ----------
function SwitchModal({
  cur,
  finished,
  onClose,
  onSwitched,
}: {
  cur: MyAnchor;
  finished: boolean;
  onClose: () => void;
  onSwitched: () => void;
}) {
  const [picked, setPicked] = useState<TopicCard | null>(null);
  const { data: topics } = useQuery({
    queryKey: ["anchor-topics"],
    queryFn: () => api.anchorTopics(),
  });
  const sw = useMutation({
    mutationFn: (slug: string) => api.switchAnchor(slug),
    onSuccess: onSwitched,
  });
  const isRestart = picked?.slug === cur.topic.slug;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-lg w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {!picked ? (
          <>
            <h3 className="text-lg font-bold mb-1">
              {finished ? "🎉 挑下一个话题" : "换一个话题？"}
            </h3>
            <p className="text-xs text-ink-2 mb-4 leading-relaxed">
              {finished ? (
                <>
                  你已经啃完 <b className="text-ink">{cur.topic.icon} {cur.topic.name}</b>
                  （{cur.total} 段，{cur.day} 天）。挑下一个继续 —— 还是两周不准换。
                </>
              ) : (
                <>
                  你在 <b className="text-ink">{cur.topic.icon} {cur.topic.name}</b> 已经第{" "}
                  <b className="text-ink">{cur.day}</b> 天，进度{" "}
                  <b className="text-ink">{cur.done_count}/{cur.total}</b>。
                  换了<b className="text-brand">当前进度会清零</b>，从第 1 天重新开始。
                </>
              )}
            </p>
            <TopicGrid
              topics={topics ?? []}
              selected={undefined}
              onPick={(slug) => {
                const t = (topics ?? []).find((x) => x.slug === slug);
                if (t) setPicked(t);
              }}
            />
            <button onClick={onClose} className="btn-ghost w-full mt-4">
              {finished ? "先不挑，回去重看" : "算了，继续现在这个"}
            </button>
          </>
        ) : (
          <>
            <h3 className="text-lg font-bold mb-1">
              {isRestart
                ? `重新开始「${picked.name}」？`
                : `确定换到「${picked.icon} ${picked.name}」？`}
            </h3>
            <p className="text-xs text-ink-2 mb-5 leading-relaxed">
              {finished ? (
                <>开一条新话题路径，从第 1 天、第 1 段开始。前面走完的不会丢，随时能回来重看。</>
              ) : isRestart ? (
                <>
                  {cur.topic.name} 的 {cur.done_count}/{cur.total} 进度会
                  <b className="text-brand">清零</b>，从头再走一遍。
                </>
              ) : (
                <>
                  {cur.topic.name} 的 {cur.done_count}/{cur.total} 进度会
                  <b className="text-brand">永久清零</b>。这正是「不准换」的代价 ——
                  想清楚再换。
                </>
              )}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPicked(null)} className="btn-ghost flex-1">
                返回
              </button>
              <button
                onClick={() => sw.mutate(picked.slug)}
                disabled={sw.isPending}
                className="btn-primary flex-1 !bg-brand disabled:opacity-50"
              >
                {finished ? "开始这个话题" : isRestart ? "清零重来" : "清零并换"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Anchor hero (the whole Home when committed) ----------
function AnchorHome({
  data,
  onHowTo,
  onPathPage,
  onFreeMode,
}: {
  data: MyAnchor;
  onHowTo: () => void;
  onPathPage: (p: number) => void;
  onFreeMode: () => void;
}) {
  const qc = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const cur = data.path.find((p) => p.current) ?? data.path[0];
  const advance = useMutation({
    mutationFn: () => api.advanceAnchor(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-anchor"] }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["my-anchor"] });
  const pct = data.total ? Math.round((data.done_count / data.total) * 100) : 0;
  const finished = data.total > 0 && data.done_count >= data.total;
  // The anchor topic has no published episodes — either nothing was ever
  // published under it, or the clips that were got unpublished/reclassified
  // out from under a learner who had already committed.  Without this the
  // page rendered a title, an empty card and two 12px grey links: a screen
  // the user can only read as "the site is broken".
  const empty = data.total === 0;
  const seqOf = (epId: number) => data.path.findIndex((p) => p.episode_id === epId) + 1;

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-widest text-ink-3 font-semibold">
            你的话题主线 · 第 {data.day} 天
          </div>
          <h1 className="text-xl md:text-xl font-bold mt-0.5 truncate">
            啃 {data.topic.icon} {data.topic.name}
          </h1>
        </div>
        <button
          onClick={onHowTo}
          className="btn-ghost inline-flex items-center gap-1.5 shrink-0"
        >
          <Question size={14} /> 怎么学
        </button>
      </div>

      {empty && (
        <div
          className="rounded-2xl border border-[#c9dfd0] mb-6 p-6 md:p-8 text-center"
          style={{ background: "linear-gradient(135deg, #f4f9f6 0%, #f7faf8 60%)" }}
        >
          <Compass size={26} className="mx-auto text-brand mb-2" />
          <div className="text-lg font-bold mb-1.5">
            「{data.topic.icon} {data.topic.name}」下暂时没有可学的内容
          </div>
          <p className="text-sm text-ink-2 mb-5 leading-relaxed max-w-md mx-auto">
            这个话题的视频还没上架，或者已经下架了。换一个有内容的话题继续啃，
            也可以先去 Discover 把全部内容翻一遍。
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link to="/catalog" className="btn-primary inline-flex items-center gap-1.5">
              <Compass size={14} weight="bold" /> 去 Discover 挑一段
            </Link>
            <button
              onClick={() => setSwitching(true)}
              className="btn-ghost inline-flex items-center gap-1.5"
            >
              <ArrowsClockwise size={14} weight="bold" /> 换个话题
            </button>
          </div>
        </div>
      )}

      {finished && (
        <div
          className="rounded-2xl border border-[#c9dfd0] mb-6 p-6 text-center"
          style={{ background: "linear-gradient(135deg, #f4f9f6 0%, #f7faf8 60%)" }}
        >
          <div className="text-2xl mb-1">🎉</div>
          <div className="text-lg font-bold mb-1">
            你啃完了「{data.topic.icon} {data.topic.name}」
          </div>
          <p className="text-xs text-ink-2 mb-4 leading-relaxed max-w-md mx-auto">
            {data.total} 段全部啃透，坚持了 {data.day} 天。这就是「不准换」的回报 ——
            现在挑下一个话题，继续深挑。下面任意一段都能回看。
          </p>
          <button
            onClick={() => setSwitching(true)}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise size={14} weight="bold" /> 挑下一个话题
          </button>
        </div>
      )}

      {!finished && cur && (
        <div
          className="rounded-2xl overflow-hidden border border-[#c9dfd0] mb-6"
          style={{ background: "linear-gradient(135deg, #f4f9f6 0%, #f7faf8 60%)" }}
        >
          <div className="flex flex-col sm:flex-row">
            <Link
              to={`/learn/${cur.episode_id}`}
              className="sm:w-[300px] aspect-video bg-black shrink-0 relative group"
            >
              {cur.thumbnail_url && (
                <img src={cur.thumbnail_url} alt="" className="w-full h-full object-cover" />
              )}
              <div className="absolute inset-0 grid place-items-center bg-black/20 group-hover:bg-black/35 transition">
                <div className="w-12 h-12 rounded-full bg-white/90 grid place-items-center">
                  <Play size={20} weight="bold" className="text-brand ml-0.5" />
                </div>
              </div>
            </Link>
            <div className="flex-1 p-5 flex flex-col">
              <div className="text-2xs text-ink-3 font-semibold mb-1">
                第 {seqOf(cur.episode_id)} 段 / 共 {data.total} · {fmtDuration(cur.duration_sec)}
                {cur.creator && <span className="text-ink-3"> · {cur.creator}</span>}
              </div>
              <div className="text-base font-semibold leading-snug line-clamp-2 mb-3">
                {cur.title}
              </div>
              <p className="text-xs text-ink-2 mb-4 leading-relaxed">
                同一话题里高频词会反复出现 —— 听几段你就开始预测下一句了。
              </p>
              <div className="flex flex-wrap gap-2 mt-auto">
                <Link
                  to={`/learn/${cur.episode_id}`}
                  className="btn-primary inline-flex items-center gap-1.5"
                >
                  <Play size={14} weight="bold" /> 今天 20 分钟
                </Link>
                <button
                  onClick={() => advance.mutate()}
                  disabled={advance.isPending || data.done_count >= data.total}
                  className="btn-ghost disabled:opacity-40"
                  title="这段你已经能预测下一句了，解锁下一段"
                >
                  <Check size={14} weight="bold" className="inline mr-1" />
                  这段我啃透了
                </button>
              </div>
            </div>
          </div>
          <div className="px-5 pb-4">
            <div className="flex items-center justify-between text-2xs text-ink-2 mb-1.5">
              <span>路径进度 {data.done_count}/{data.total}</span>
              <span>第 {data.day} 天 / 建议坚持 14 天</span>
            </div>
            <div className="h-1.5 bg-white/70 rounded-full overflow-hidden">
              <div className="h-full bg-brand rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      )}

      <div className={`card divide-y divide-line mb-3 ${empty ? "hidden" : ""}`}>
        {data.path.map((p, i) => {
          const seq = data.page * data.page_size + i + 1;
          return (
          <div
            key={p.episode_id}
            className={`flex items-center gap-3 p-3 ${p.current ? "bg-[#f4f9f6]" : ""}`}
          >
            <div
              className={`w-6 h-6 rounded-full grid place-items-center text-2xs shrink-0 ${
                p.done
                  ? "bg-brand text-white"
                  : p.locked
                  ? "bg-[#eff2ef] text-ink-3"
                  : "border-2 border-brand text-brand"
              }`}
            >
              {p.done ? <Check size={12} weight="bold" /> : p.locked ? <Lock size={11} /> : seq}
            </div>
            <div className={`flex-1 min-w-0 ${p.locked ? "text-ink-3" : ""}`}>
              <div className="text-sm truncate">{p.title}</div>
              {p.creator && (
                <div className="text-2xs text-ink-3 truncate">{p.creator}</div>
              )}
            </div>
            {!p.locked ? (
              <Link to={`/learn/${p.episode_id}`} className="text-xs text-brand shrink-0">
                {p.done ? "重看" : "学这段"}
              </Link>
            ) : (
              <span className="text-2xs text-ink-3 shrink-0">先学完上一段</span>
            )}
          </div>
          );
        })}
      </div>
      {!empty && (
        <Pager
          page={data.page}
          pageSize={data.page_size}
          total={data.total}
          onPage={onPathPage}
        />
      )}

      {/* Escape hatches. Deliberately 13px on ink-2 rather than the 12px
          ink-3 they used to be: these are the only ways out of a path the
          learner has lost interest in, and at the old size they read as
          decoration and got skipped. */}
      <div className="flex items-center justify-between gap-3 text-sm flex-wrap">
        <button
          onClick={() => setSwitching(true)}
          className="text-ink-2 hover:text-ink inline-flex items-center gap-1.5"
        >
          <ArrowsClockwise size={13} />
          {finished ? "挑下一个话题" : "换话题（进度清零）"}
        </button>
        <div className="inline-flex items-center gap-4">
          <button
            onClick={onFreeMode}
            className="text-ink-2 hover:text-ink inline-flex items-center gap-1"
            title="保留话题进度，先按自己看过的视频学"
          >
            改用自由模式 →
          </button>
          <Link
            to="/catalog"
            className="text-brand hover:underline inline-flex items-center gap-1"
          >
            <Compass size={13} /> 探索全部内容 →
          </Link>
        </div>
      </div>

      {switching && (
        <SwitchModal
          cur={data}
          finished={finished}
          onClose={() => setSwitching(false)}
          onSwitched={() => {
            setSwitching(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

export function Home() {
  const user = currentUser();
  const qc = useQueryClient();
  const [howToOpen, setHowToOpen] = useState(false);
  // Path page state. `null` = first load, let backend auto-jump to the
  // page containing the current clip; a number = explicit Pager click.
  const [pathPage, setPathPage] = useState<number | null>(null);
  const { data: mine, isLoading } = useQuery({
    queryKey: ["my-anchor", pathPage],
    queryFn: () => api.myAnchor(pathPage ?? -1),
  });
  const { data: heat } = useQuery({ queryKey: ["me-heatmap"], queryFn: api.myHeatmap });

  // Local mirror of the onboarding-dismissed flag so toggling re-renders
  // without a full page reload (currentUser() reads localStorage, which
  // React doesn't subscribe to).
  const [dismissed, setDismissed] = useState<boolean>(
    user?.onboarding_dismissed ?? false,
  );

  const setFreeMode = (next: boolean) => {
    api.updatePreferences({ onboarding_dismissed: next }).then(() => {
      patchCurrentUser({ onboarding_dismissed: next });
      setDismissed(next);
      qc.invalidateQueries({ queryKey: ["my-recent"] });
      if (!next) qc.invalidateQueries({ queryKey: ["my-anchor"] });
    });
  };

  return (
    <Shell hideSearch>
      {heat?.current_streak ? (
        <div className="flex justify-end mb-3">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#eaf3ec] border border-[#c9dfd0] text-2xs text-[#285e48] font-medium">
            <Fire size={11} weight="bold" /> 连续 {heat.current_streak} 天
          </span>
        </div>
      ) : null}

      <ApiKeyNudge />

      {/* `dismissed` is the top-level mode switch — a committed learner
          can flip to free-mode without dropping their anchor data. */}
      {isLoading ? (
        <div className="text-ink-2 text-sm pt-10 text-center">载入中…</div>
      ) : dismissed ? (
        <RecentView onReopen={() => setFreeMode(false)} />
      ) : mine ? (
        <AnchorHome
          data={mine}
          onHowTo={() => setHowToOpen(true)}
          onPathPage={setPathPage}
          onFreeMode={() => setFreeMode(true)}
        />
      ) : (
        <Onboarding
          onDone={() => qc.invalidateQueries({ queryKey: ["my-anchor"] })}
          onSkip={() => setFreeMode(true)}
        />
      )}

      <HowToModal open={howToOpen} onClose={() => setHowToOpen(false)} />
      {!mine && !isLoading && !dismissed && (
        <div className="max-w-2xl mx-auto mt-8 text-center">
          <button
            onClick={() => setHowToOpen(true)}
            className="text-sm text-ink-2 hover:text-ink inline-flex items-center gap-1.5"
          >
            <Question size={13} /> 先看看这套方法怎么用，{user?.username ?? ""}
          </button>
        </div>
      )}
    </Shell>
  );
}
