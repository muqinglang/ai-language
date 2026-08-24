import { useQuery } from "@tanstack/react-query";
import { BookOpen, Cards, CaretRight, ChatCircle, Fire, GraduationCap, Lock, Medal, Monitor, ShareNetwork, Sparkle, Trophy } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { LLMKeySettings } from "@/components/LLMKeySettings";
import { VoiceSettings } from "@/components/VoiceSettings";
import { Shell } from "@/components/Shell";
import { api, currentUser } from "@/lib/api";

function timeAgo(iso: string | null): string {
  if (!iso) return "--";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return `${days} 天前`;
}

function daysSince(iso: string | null): string {
  if (!iso) return "--";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return `${days}`;
}

function Heatmap({ data }: { data: NonNullable<Awaited<ReturnType<typeof api.myHeatmap>>> }) {
  // Build a 7 × 12 grid where rows are day-of-week (Mon..Sun) and columns
  // are weeks going back from today. Matches GitHub's contribution layout.
  const start = new Date(data.start);
  const end = new Date(data.end);
  const days: { date: Date; count: number }[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    days.push({ date: new Date(cursor), count: data.counts[iso] ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const bucket = (c: number) => {
    // 一条由浅到深的绿色阶。原来是橙色阶，换品牌色时如果只替换其中
    // 一两格，整条阶梯会变成"橙→橙→绿"，比不换更乱。
    if (c === 0) return "bg-[#eaeee9]";
    if (c === 1) return "bg-[#dcebe1]";
    if (c <= 3) return "bg-[#a8ccb6]";
    if (c <= 6) return "bg-[#5e9d81]";
    return "bg-brand";
  };

  // Arrange into columns by week. First column may be partial (pad to 7).
  const weeks: { date: Date; count: number }[][] = [];
  let cur: { date: Date; count: number }[] = [];
  days.forEach((d) => {
    cur.push(d);
    if (d.date.getDay() === 6) {
      weeks.push(cur);
      cur = [];
    }
  });
  if (cur.length) weeks.push(cur);

  return (
    <div className="card p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="text-base font-semibold">学习日历</h3>
          <div className="text-2xs text-ink-3 mt-0.5">
            过去 12 周 · 共 {data.total_active_days} 天有学习 · 最长连续 {data.best_streak} 天
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-2xs text-ink-3">
          少
          {[0, 1, 2, 4, 7].map((n) => (
            <span key={n} className={`w-2.5 h-2.5 rounded-sm ${bucket(n)}`} />
          ))}
          多
        </div>
      </div>
      <div className="flex gap-0.5 overflow-x-auto">
        {weeks.map((w, i) => {
          // Pad front of the first week so Sunday starts the row.
          const pad = i === 0 ? 7 - w.length : 0;
          return (
            <div key={i} className="flex flex-col gap-0.5">
              {Array.from({ length: pad }).map((_, j) => (
                <div key={`p${j}`} className="w-2.5 h-2.5 rounded-sm invisible" />
              ))}
              {w.map((d) => (
                <div
                  key={d.date.toISOString()}
                  title={`${d.date.toISOString().slice(0, 10)} · ${d.count} 次活动`}
                  className={`w-2.5 h-2.5 rounded-sm ${bucket(d.count)}`}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 「我的」页分两个 tab。
 *
 * 概览是每次都会看的东西（进度、日历、成就、继续学习）；设置是配好一次就
 * 不再动的东西（两把 key、朗读音色）。混在一条长滚动里的结果是：日常想看
 * 进度得滚过一堆配置表单，而配置本身又埋在页面底部找不到。
 */
type MeTab = "overview" | "settings";

export function Me() {
  const user = currentUser();
  // 首页横幅的「去设置」指向 /me#api-key，直接落到设置 tab。
  const [tab, setTab] = useState<MeTab>(() =>
    window.location.hash === "#api-key" ? "settings" : "overview",
  );
  const { data: llm } = useQuery({
    queryKey: ["me-llm"],
    queryFn: () => api.getLLMSettings(),
    retry: false,
  });
  const { data, isLoading } = useQuery({
    queryKey: ["me-stats"],
    queryFn: () => api.myStats(),
  });
  const { data: heat } = useQuery({
    queryKey: ["me-heatmap"],
    queryFn: () => api.myHeatmap(),
  });
  const { data: vocabPage } = useQuery({
    queryKey: ["vocabulary-count"],
    queryFn: () => api.listVocabulary({ limit: 1 }),
  });
  const vocabCount = vocabPage?.total ?? 0;

  return (
    <Shell hideSearch>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6 md:mb-8">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-300 to-brand grid place-items-center text-white text-2xl font-bold">
            {user?.username?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold leading-tight">{user?.username}</h2>
              {heat && heat.current_streak > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#eaf3ec] border border-[#c9dfd0] text-2xs text-[#285e48] font-medium">
                  <Fire size={11} weight="bold" /> 连续 {heat.current_streak} 天
                </span>
              )}
            </div>
            <p className="text-xs text-ink-3 mt-1">
              {data
                ? `加入 ${daysSince(data.joined_at)} 天 · 最近学习 ${timeAgo(data.last_active)}`
                : "加载中..."}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost inline-flex items-center gap-1.5">
            <ShareNetwork size={14} /> 分享
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 mb-6 border-b border-line">
        {([
          { k: "overview", label: "概览" },
          { k: "settings", label: "设置" },
        ] as const).map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors duration-150 ease-spring ${
              tab === t.k
                ? "border-brand text-ink font-semibold"
                : "border-transparent text-ink-3 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "settings" && (
        <>
          {/* BYOK — 学员可以把 AI 对话指到自己的 key；服务端没配
              CREDENTIAL_ENC_KEY 时组件自己不渲染。 */}
          <LLMKeySettings />
          {/* 声音排在 key 之后：能选哪些音色取决于配了哪把 key。 */}
          {llm?.available && <VoiceSettings data={llm} />}
        </>
      )}

      {tab === "overview" && isLoading && (
        <p className="text-ink-3 text-sm">加载中...</p>
      )}

      {tab === "overview" && data && (
        <>
          {/* Stats grid — 5 cards matching the design spec. */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            <StatCard label="学过视频" value={data.episodes_started} Icon={Monitor} />
            <StatCard label="已完成" value={data.episodes_finished} Icon={GraduationCap} />
            <StatCard label="生词本" value={vocabCount} Icon={BookOpen} />
            <StatCard label="掌握 Chunks" value={data.chunks_mastered} Icon={Cards} />
            <StatCard label="AI 对话" value={data.conversations_count} Icon={ChatCircle} />
          </div>

          {/* Heatmap */}
          {heat && (
            <div className="mb-6">
              <Heatmap data={heat} />
            </div>
          )}

          {/* Achievements */}
          <AchievementsRow
            currentStreak={heat?.current_streak ?? 0}
            bestStreak={heat?.best_streak ?? 0}
            totalActive={heat?.total_active_days ?? 0}
            vocabCount={vocabCount}
            chunksMastered={data.chunks_mastered}
          />

          {/* 继续学习 — Notes used to live next to this section but now
              live in /library (Notes tab), so this row spans full width. */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold">继续学习</h3>
              <Link to="/library?tab=notes" className="text-xs text-brand hover:underline">
                所有笔记 →
              </Link>
            </div>
            {data.in_progress.length === 0 ? (
              <p className="text-ink-3 text-sm">
                还没有在学视频，
                <Link to="/" className="text-brand hover:underline">去首页看看</Link>
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {data.in_progress.map((ep) => {
                  const pct = ep.subtitles_count
                    ? Math.round((ep.last_seq / ep.subtitles_count) * 100)
                    : 0;
                  return (
                    <Link
                      key={ep.episode_id}
                      to={`/learn/${ep.episode_id}`}
                      className="card p-3 flex items-center gap-3 hover:shadow-md transition"
                    >
                      <img
                        src={ep.thumbnail_url}
                        alt=""
                        className="w-20 h-12 rounded object-cover shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{ep.title}</p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-brand rounded-full"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-ink-3 shrink-0">{pct}%</span>
                        </div>
                      </div>
                      <CaretRight size={14} className="text-ink-3 shrink-0" />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}

// Single stat tile.  Lucide icon + label on top, big number below.
function StatCard({
  label,
  value,
  Icon,
}: {
  label: string;
  value: number;
  Icon: PhosphorIcon;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 text-2xs text-ink-3 font-medium mb-1.5">
        <Icon size={12} />
        {label}
      </div>
      <div className="text-2xl font-bold leading-none">{value}</div>
    </div>
  );
}

// Achievements row — four threshold badges derived from stats we
// already have.  Each is just "did you pass this line?" — no new
// backend tracking needed.
function AchievementsRow({
  currentStreak,
  bestStreak,
  totalActive,
  vocabCount,
  chunksMastered,
}: {
  currentStreak: number;
  bestStreak: number;
  totalActive: number;
  vocabCount: number;
  chunksMastered: number;
}) {
  const badges: Array<{
    Icon: PhosphorIcon;
    title: string;
    desc: string;
    unlocked: boolean;
  }> = [
    {
      Icon: Fire,
      title: "连续 7 天",
      desc: "连续学习一周",
      unlocked: bestStreak >= 7 || currentStreak >= 7,
    },
    {
      Icon: BookOpen,
      title: "首个 10 词",
      desc: "生词本 ≥ 10",
      unlocked: vocabCount >= 10,
    },
    {
      Icon: Sparkle,
      title: "10 个 Chunks",
      desc: "掌握 ≥ 10 个 chunk",
      unlocked: chunksMastered >= 10,
    },
    {
      Icon: Trophy,
      title: "连续 30 天",
      desc: "30 天不间断",
      unlocked: bestStreak >= 30 || currentStreak >= 30,
    },
  ];
  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <Medal size={14} className="text-ink-2" />
        <h3 className="text-base font-semibold">成就</h3>
        <span className="text-2xs text-ink-3">
          累计学习 {totalActive} 天 · 最长连续 {bestStreak}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {badges.map((b, i) => (
          <div
            key={i}
            className={`card p-3.5 flex items-center gap-3 transition ${
              b.unlocked ? "" : "opacity-50"
            }`}
          >
            <div
              className={`w-10 h-10 rounded-xl grid place-items-center shrink-0 ${
                b.unlocked
                  ? "bg-[#eaf3ec] text-[#4f9c80]"
                  : "bg-[#f0f3f0] text-ink-3"
              }`}
            >
              {b.unlocked ? (
                <b.Icon size={17} />
              ) : (
                <Lock size={14} />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{b.title}</div>
              <div className="text-2xs text-ink-3 truncate">{b.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
