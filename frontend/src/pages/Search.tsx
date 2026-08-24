import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";

const SIZE = 30;
// search type value → has_more bucket key
const HAS_MORE_KEY = {
  episode: "episodes",
  subtitle: "subtitles",
  chunk: "chunks",
} as const;

export function Search() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "";
  const type = (sp.get("type") as "all" | "subtitle" | "chunk" | "episode") ?? "all";
  const [draft, setDraft] = useState(q);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["search", q, type],
      queryFn: ({ pageParam }) =>
        api.search(q, type, { limit: SIZE, offset: pageParam * SIZE }),
      initialPageParam: 0,
      // "all" is a preview tab — no load-more. A specific tab pages on
      // its own has_more bucket.
      getNextPageParam: (last, all) => {
        if (type === "all") return undefined;
        return last.has_more[HAS_MORE_KEY[type]] ? all.length : undefined;
      },
      enabled: q.length > 0,
    });

  const episodes = data?.pages.flatMap((p) => p.episodes) ?? [];
  const subtitles = data?.pages.flatMap((p) => p.subtitles) ?? [];
  const chunks = data?.pages.flatMap((p) => p.chunks) ?? [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(sp);
    next.set("q", draft);
    setSp(next);
  };

  return (
    <Shell>
      <form onSubmit={submit} className="mb-6">
        <input
          className="input !py-3 !text-base"
          placeholder="搜视频、字幕、Chunk、场景…  例: 'ended up'"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        />
      </form>

      {q && (
        <div className="flex gap-2 mb-5">
          {(["all", "episode", "subtitle", "chunk"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                const next = new URLSearchParams(sp);
                next.set("type", t);
                setSp(next);
              }}
              className={`chip ${type === t ? "chip-on" : ""}`}
            >
              {({ all: "全部", episode: "视频", subtitle: "字幕", chunk: "Chunk" } as const)[t]}
            </button>
          ))}
        </div>
      )}

      {!q && <p className="text-ink-2 text-sm">输入关键词开始搜索。</p>}

      {isLoading && <p className="text-ink-2 text-sm">搜索中…</p>}

      {data && (
        <div className="flex flex-col gap-8">
          {episodes.length > 0 && (
            <section>
              <h3 className="text-sm font-bold mb-3">视频 · {episodes.length}</h3>
              <div className="grid grid-cols-4 gap-3">
                {episodes.map((e) => (
                  <Link key={e.id} to={`/learn/${e.id}`} className="card p-3 hover:border-ink-2/50">
                    <div className="text-sm font-semibold line-clamp-2">{e.title}</div>
                    <div className="text-2xs text-ink-2 mt-1.5 line-clamp-2">{e.summary}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {subtitles.length > 0 && (
            <section>
              <h3 className="text-sm font-bold mb-3">字幕 · {subtitles.length}</h3>
              <div className="flex flex-col gap-2">
                {subtitles.map((s) => (
                  <Link
                    key={s.id}
                    to={`/learn/${s.episode_id}`}
                    className="card p-3.5 hover:border-ink-2/50"
                  >
                    <div className="text-2xs text-ink-2 mb-1">
                      {s.episode_title} · #{s.seq}
                    </div>
                    <div className="text-sm">{highlight(s.text_en, q)}</div>
                    <div className="text-xs text-ink-2 mt-1">{s.text_zh}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {chunks.length > 0 && (
            <section>
              <h3 className="text-sm font-bold mb-3">Chunk · {chunks.length}</h3>
              <div className="flex flex-col gap-2">
                {chunks.map((c) => (
                  <Link
                    key={c.id}
                    to={`/learn/${c.episode_id}`}
                    className="card p-3.5 hover:border-ink-2/50"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold">{c.text}</span>
                      <span className="text-2xs bg-chunk-1 px-2 py-0.5 rounded-full">
                        {c.chunk_type}
                      </span>
                    </div>
                    <div className="text-xs text-ink-2 mt-1.5 leading-[1.55]">
                      {c.why_explanation}
                    </div>
                    <div className="text-2xs text-ink-3 mt-1.5">来自: {c.episode_title}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {q && !isLoading && !episodes.length && !subtitles.length && !chunks.length && (
            <p className="text-ink-2 text-sm">没有找到匹配结果。</p>
          )}

          {hasNextPage && (
            <div className="flex justify-center">
              <button
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="btn-ghost disabled:opacity-50"
              >
                {isFetchingNextPage ? "加载中…" : "加载更多"}
              </button>
            </div>
          )}
          {type === "all" && (episodes.length > 0 || subtitles.length > 0 || chunks.length > 0) && (
            <p className="text-2xs text-ink-3 text-center">
              「全部」只显示预览 — 点上方某个类型 tab 看完整结果
            </p>
          )}
        </div>
      )}
    </Shell>
  );
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-chunk-1 px-1 rounded">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
