import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Cards, CaretRight, Clock, FilmStrip, PlayCircle } from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

function fmtSegmentDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Collection() {
  const { id } = useParams<{ id: string }>();

  const { data: collection, isLoading, error } = useQuery({
    queryKey: ["collection", id],
    queryFn: () => api.collection(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <Shell hideSearch>
        <div className="text-ink-3 text-sm">加载中…</div>
      </Shell>
    );
  }

  if (error || !collection) {
    return (
      <Shell hideSearch>
        <div className="card p-10 text-center">
          <div className="text-base font-semibold">没找到这个合集</div>
          {id && (
            <div className="text-2xs text-ink-3 mt-1.5 break-all">id: {id}</div>
          )}
          <Link to="/catalog" className="text-brand text-sm hover:underline mt-3 inline-block">
            回 Discover
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell hideSearch>
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink mb-5"
      >
        <ArrowLeft size={14} />
        首页
      </Link>

      <div className="card overflow-hidden mb-6">
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-0">
          <div className="aspect-video md:aspect-auto bg-black">
            <img
              src={collection.thumbnail_url}
              alt=""
              className="w-full h-full object-cover"
            />
          </div>
          <div className="p-5 md:p-7 flex flex-col gap-3">
            <div className="inline-flex items-center gap-1.5 text-2xs text-[#285e48] font-semibold uppercase tracking-wider">
              📚 完整课程
            </div>
            <h1 className="text-xl md:text-2xl font-bold leading-[1.3] break-words">
              {collection.title}
            </h1>
            {collection.creator_name && (
              <div className="text-xs text-ink-2">
                作者 · <span className="text-ink">{collection.creator_name}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2 mt-1">
              <span className="inline-flex items-center gap-1">
                <FilmStrip size={13} />
                {collection.segment_count} 段
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock size={13} />
                共 {fmtDuration(collection.total_duration_sec)}
              </span>
            </div>
            <Link
              to={`/learn/${collection.first_episode_id}`}
              className="btn-primary inline-flex items-center gap-1.5 self-start mt-2 text-sm"
            >
              <PlayCircle size={15} weight="bold" />
              从第 1 段开始
            </Link>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold">全部段落</h3>
        <span className="text-xs text-ink-3">按时间顺序</span>
      </div>
      <div className="flex flex-col gap-2.5">
        {collection.segments.map((seg) => {
          const published = seg.status === "published";
          // Reviewing segments render as static divs (not Links) and
          // grayed-out so the learner sees the table-of-contents in
          // full but can't drill into a half-baked segment.
          const inner = (
            <>
              <div
                className={`shrink-0 w-9 h-9 md:w-10 md:h-10 rounded-lg grid place-items-center font-bold text-base ${
                  published
                    ? "bg-[#eaf3ec] text-[#285e48]"
                    : "bg-[#eff2ef] text-ink-3"
                }`}
              >
                {seg.segment_index}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-sm md:text-base font-semibold leading-[1.4] break-words ${
                    published ? "text-ink" : "text-ink-3"
                  }`}
                >
                  {seg.title}
                </div>
                {seg.topic_zh && (
                  <div className="text-xs text-ink-3 mt-0.5 line-clamp-1 break-words">
                    {seg.topic_zh}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-1.5 text-2xs text-ink-3">
                  <span className="inline-flex items-center gap-1">
                    <Clock size={11} />
                    {fmtSegmentDuration(seg.duration_sec)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Cards size={11} />
                    {seg.chunks_count} chunks
                  </span>
                  {!published && (
                    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-[#fff2d6] text-[#b27700] font-semibold">
                      审核中
                    </span>
                  )}
                </div>
              </div>
              <CaretRight
                size={16}
                className={`shrink-0 ${
                  published ? "text-ink-3 group-hover:text-brand" : "text-ink-3/40"
                }`}
              />
            </>
          );
          return published ? (
            <Link
              key={seg.id}
              to={`/learn/${seg.id}`}
              className="card p-3 md:p-4 hover:border-ink-2/30 hover:shadow-sm transition flex items-center gap-3.5 group"
            >
              {inner}
            </Link>
          ) : (
            <div
              key={seg.id}
              className="card p-3 md:p-4 flex items-center gap-3.5 opacity-60 cursor-not-allowed"
            >
              {inner}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}
