import { useQuery } from "@tanstack/react-query";
import { FilmStrip, Users } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { TOPIC_META, topicColor } from "@/lib/topicMeta";

export function Creators() {
  const { data: creators, isLoading } = useQuery({
    queryKey: ["creators"],
    queryFn: api.creators,
  });

  return (
    <Shell hideSearch>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-2xs uppercase tracking-widest text-ink-3 font-semibold mb-1">
          <Users size={12} weight="bold" />
          Creators
        </div>
        <h1 className="text-2xl font-bold leading-tight">所有博主</h1>
        <p className="text-sm text-ink-2 mt-1 max-w-xl">
          跟同一个人学，语调、节奏、常用词汇很快就能熟悉。选一个频道系统地看一遍，听感会有质变。
        </p>
      </div>

      {isLoading && <div className="text-ink-3 text-sm">加载中…</div>}

      {!isLoading && creators?.length === 0 && (
        <div className="card p-10 text-center">
          <FilmStrip size={28} className="text-ink-3 mx-auto mb-3" />
          <div className="text-base font-semibold">还没有博主</div>
          <div className="text-xs text-ink-3 mt-1">
            admin 可以在{" "}
            <Link to="/admin/import" className="text-brand hover:underline">
              导入页
            </Link>{" "}
            添加 YouTube 链接，每个创作者会自动聚合为一个频道。
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-5">
        {creators?.map((c) => {
          const initials = (c.name || c.handle.replace("@", "")).slice(0, 2).toUpperCase();
          const color = topicColor(c.top_topic ?? "other");
          return (
            <Link
              key={c.id}
              to={`/creators/${c.id}`}
              className="card overflow-hidden block hover:shadow-md transition-shadow"
            >
              <div
                className="h-24 relative"
                style={{
                  background: `linear-gradient(135deg, ${color}33 0%, ${color}11 60%)`,
                }}
              />
              <div className="px-5 pb-5 -mt-10 relative">
                <div
                  className="w-16 h-16 rounded-2xl grid place-items-center text-white font-bold text-lg border-4 border-white shadow-md"
                  style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}
                >
                  {c.avatar ? (
                    <img
                      src={c.avatar}
                      alt=""
                      className="w-full h-full rounded-xl object-cover"
                    />
                  ) : (
                    initials
                  )}
                </div>
                <div className="mt-3">
                  <h3 className="font-semibold text-base leading-snug">{c.name || c.handle}</h3>
                  <div className="text-2xs text-ink-3 mt-0.5">
                    {c.handle && c.handle !== c.name ? `${c.handle} · ` : ""}
                    {c.default_accent}
                  </div>
                </div>
                {c.description && (
                  <p className="text-xs text-ink-2 mt-2 line-clamp-2 leading-[1.5]">
                    {c.description}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-3 text-2xs text-ink-3">
                  <span className="inline-flex items-center gap-1">
                    <FilmStrip size={12} />
                    {c.episode_count} 集
                  </span>
                  {c.top_topic && (
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: color }}
                      />
                      {TOPIC_META[c.top_topic]?.name ?? c.top_topic}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </Shell>
  );
}
