import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowSquareOut, Cards, ChartBar, FilmStrip, Microphone, Sparkle } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import { EpisodeCardView } from "@/components/EpisodeCard";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { TOPIC_META, topicColor } from "@/lib/topicMeta";

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

export function CreatorHub() {
  const { id } = useParams<{ id: string }>();
  const creatorId = Number(id);

  const { data: creator, isLoading } = useQuery({
    queryKey: ["creator", creatorId],
    queryFn: () => api.creator(creatorId),
    enabled: !!creatorId,
  });
  const EP_SIZE = 30;
  const {
    data: epPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["creator-episodes", creatorId],
    queryFn: ({ pageParam }) =>
      api.creatorEpisodes(creatorId, EP_SIZE, pageParam * EP_SIZE),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.has_more ? all.length : undefined),
    enabled: !!creatorId,
  });
  const episodes = epPages?.pages.flatMap((p) => p.items) ?? [];

  if (isLoading) {
    return (
      <Shell hideSearch>
        <div className="text-ink-3 text-sm">加载中…</div>
      </Shell>
    );
  }
  if (!creator) {
    return (
      <Shell hideSearch>
        <div className="card p-10 text-center">
          <div className="text-base font-semibold">没找到这位博主</div>
          <Link to="/creators" className="text-brand text-sm hover:underline mt-3 inline-block">
            回博主列表
          </Link>
        </div>
      </Shell>
    );
  }

  const color = topicColor(creator.top_topic ?? "other");
  const initials = (creator.name || creator.handle.replace("@", "")).slice(0, 2).toUpperCase();

  return (
    <Shell hideSearch>
      <Link
        to="/creators"
        className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink mb-5"
      >
        <ArrowLeft size={14} />
        全部博主
      </Link>

      <div className="card overflow-hidden mb-6">
        {/* Banner */}
        <div
          className="h-[140px] relative"
          style={{
            background: `linear-gradient(135deg, ${color}33 0%, ${color}11 50%, #ffffff 100%)`,
          }}
        >
          <div
            className="absolute inset-0 opacity-40"
            style={{
              background: `radial-gradient(circle at 80% 30%, ${color}22, transparent 50%)`,
            }}
          />
        </div>

        <div className="px-8 pb-8 -mt-12 relative">
          <div className="flex items-end justify-between">
            <div className="flex items-end gap-5">
              <div
                className="w-24 h-24 rounded-2xl grid place-items-center text-white text-3xl font-bold border-4 border-white shadow-lg"
                style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}
              >
                {creator.avatar ? (
                  <img
                    src={creator.avatar}
                    alt=""
                    className="w-full h-full rounded-xl object-cover"
                  />
                ) : (
                  initials
                )}
              </div>
              <div className="mb-1">
                <h1 className="text-2xl font-bold leading-tight">{creator.name || creator.handle}</h1>
                <div className="flex items-center gap-3 mt-1.5 text-xs text-ink-2">
                  {creator.top_topic && (
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: color }}
                      />
                      {TOPIC_META[creator.top_topic]?.name ?? creator.top_topic}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Microphone size={12} /> {creator.default_accent}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <FilmStrip size={12} /> {creator.episode_count} 集
                  </span>
                </div>
              </div>
            </div>
            {creator.youtube_url && (
              <a
                href={creator.youtube_url}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost inline-flex items-center gap-1.5 mb-2"
              >
                <ArrowSquareOut size={14} />
                YouTube 主页
              </a>
            )}
          </div>

          {creator.description && (
            <p className="text-sm text-ink-2 mt-5 max-w-[720px] leading-[1.65]">
              {creator.description}
            </p>
          )}

          {/* Stats */}
          <div className="grid grid-cols-4 gap-3 mt-6">
            <Stat label="总时长" value={fmtDuration(creator.total_duration_sec)} Icon={ChartBar} />
            <Stat label="Chunks" value={`${creator.total_chunks} 个`} Icon={Cards} />
            <Stat label="推荐词" value={`${creator.total_featured_words} 个`} Icon={Sparkle} />
            <Stat label="话题覆盖" value={`${creator.topics.length} 个`} Icon={FilmStrip} />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-bold">全部视频</h3>
        <span className="text-xs text-ink-3">按发布时间倒序</span>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {episodes.map((e) => (
          <EpisodeCardView key={e.id} ep={e} />
        ))}
      </div>
      {hasNextPage && (
        <div className="flex justify-center mt-6">
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="btn-ghost disabled:opacity-50"
          >
            {isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </Shell>
  );
}

function Stat({
  label,
  value,
  Icon,
}: {
  label: string;
  value: string;
  Icon: PhosphorIcon;
}) {
  return (
    <div className="p-3 rounded-lg border border-line">
      <div className="flex items-center gap-1.5 text-2xs text-ink-3 uppercase tracking-wider font-semibold">
        <Icon size={11} weight="bold" />
        {label}
      </div>
      <div className="text-lg font-bold mt-1">{value}</div>
    </div>
  );
}
