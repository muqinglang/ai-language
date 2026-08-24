import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { BookmarkSimple, FilmStrip, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { Shell } from "@/components/Shell";

// Favorites are "回看素材" — videos the user wants to revisit casually.
// (Sentence favouriting was removed; per-line study now lives in notes /
// user-marked chunks.)  Chunks live in the 学习本 (Library) because
// they're target study material with a daily-review loop.

function EmptyHint({
  Icon,
  title,
  body,
}: {
  Icon: PhosphorIcon;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="card p-10 text-center col-span-full">
      <Icon size={28} className="text-ink-3 mx-auto mb-3" />
      <div className="text-base font-semibold">{title}</div>
      <div className="text-xs text-ink-3 mt-1.5 max-w-sm mx-auto leading-[1.6]">{body}</div>
    </div>
  );
}

export function Favorites() {
  const [q, setQ] = useState("");
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["favs-enriched"],
      queryFn: ({ pageParam }) => api.listFavoritesEnriched(30, pageParam * 30),
      initialPageParam: 0,
      getNextPageParam: (last, all) => (last.has_more ? all.length : undefined),
    });

  // This page only surfaces episode favorites (chunks/subtitles live in
  // 学习本). The enriched endpoint paginates the combined favorites
  // timeline, so episodes accumulate across pages.
  const episodes = useMemo(
    () => data?.pages.flatMap((p) => p.episodes) ?? [],
    [data],
  );
  const query = q.trim().toLowerCase();
  const filteredEpisodes = useMemo(() => {
    if (!query) return episodes;
    return episodes.filter((e) => e.title.toLowerCase().includes(query));
  }, [episodes, query]);

  return (
    <Shell hideSearch>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h2 className="text-xl font-bold">我的收藏</h2>
        <div className="input flex items-center gap-2 !py-2 w-full sm:w-72">
          <MagnifyingGlass size={14} className="text-ink-3 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜收藏的视频…"
            className="flex-1 min-w-0 outline-none bg-transparent text-sm"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="text-ink-3 hover:text-ink shrink-0"
              aria-label="清除"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {isLoading && <p className="text-ink-3 text-sm">加载中...</p>}

      {!isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {episodes.length === 0 && (
            <EmptyHint
              Icon={FilmStrip}
              title="还没有收藏视频"
              body={
                <>
                  在视频列表或播放页的标题旁点 <BookmarkSimple size={12} className="inline align-text-top" /> 就会出现在这里。收藏过的视频可以快速回来重听。
                </>
              }
            />
          )}
          {episodes.length > 0 && filteredEpisodes.length === 0 && (
            <div className="card p-6 text-center text-ink-3 text-sm col-span-full">
              没有匹配「{q}」的视频
            </div>
          )}
          {filteredEpisodes.map((e) => (
            <Link
              key={e.fav_id}
              to={`/learn/${e.episode_id}`}
              className="card hover:shadow-md transition overflow-hidden"
            >
              <img
                src={e.thumbnail_url}
                alt=""
                className="w-full h-36 object-cover"
              />
              <div className="p-3">
                <h4 className="font-semibold text-sm line-clamp-2">{e.title}</h4>
                <span className="text-xs text-ink-3 mt-1">
                  {Math.floor(e.duration_sec / 60)}:{String(e.duration_sec % 60).padStart(2, "0")}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {hasNextPage && (
        <div className="flex justify-center mt-6">
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="btn-ghost disabled:opacity-50"
          >
            {isFetchingNextPage ? "加载中…" : "加载更多收藏"}
          </button>
        </div>
      )}
    </Shell>
  );
}
