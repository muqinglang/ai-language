import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretRight, Check, Compass, Lock, Play, Sparkle } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { api, patchCurrentUser } from "@/lib/api";

function fmtDuration(sec: number) {
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

/**
 * Home opt-out view. Shown when the learner explicitly skipped the
 * topic-anchor onboarding ("先随便看 →"). Renders:
 *   1. A "continue learning" hero of the most recently touched Episode
 *   2. When that Episode is part of a collection (shares youtube_url
 *      with siblings), a ToC of all segments — current one highlighted
 *   3. A subtle "锁定主线，按话题啃" link to reopen the anchor onboarding
 *
 * Empty state (no Progress rows yet) routes the learner to Discover.
 */
export function RecentView({ onReopen }: { onReopen: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["my-recent"],
    queryFn: api.myRecent,
  });

  const reopen = useMutation({
    mutationFn: () => api.updatePreferences({ onboarding_dismissed: false }),
    onSuccess: () => {
      patchCurrentUser({ onboarding_dismissed: false });
      qc.invalidateQueries({ queryKey: ["my-anchor"] });
      onReopen();
    },
  });

  if (isLoading) {
    return <div className="text-ink-2 text-sm pt-10 text-center">载入中…</div>;
  }

  // Empty state — never started anything yet.
  if (!data?.hero) {
    return (
      <div className="max-w-2xl mx-auto pt-10 text-center">
        <Sparkle size={28} className="mx-auto text-ink-3 mb-3" />
        <h2 className="text-lg font-semibold mb-1.5">还没看过任何视频</h2>
        <p className="text-sm text-ink-2 mb-5">先去 Discover 挑一段感兴趣的开始。</p>
        <Link to="/catalog" className="btn-primary inline-flex items-center gap-1.5">
          <Compass size={14} weight="bold" /> 去 Discover
        </Link>
        <div className="mt-8">
          <button
            onClick={() => reopen.mutate()}
            disabled={reopen.isPending}
            className="text-sm text-ink-2 hover:text-ink inline-flex items-center gap-1.5"
          >
            <Lock size={13} /> 改回按话题主线学
          </button>
        </div>
      </div>
    );
  }

  const hero = data.hero;
  const coll = data.collection;

  return (
    <div className="max-w-2xl mx-auto pt-2">
      <div className="text-2xs uppercase tracking-widest text-ink-3 font-semibold mb-2">
        继续上次的学习
      </div>

      {/* Continue hero */}
      <Link
        to={`/learn/${hero.id}`}
        className="block card overflow-hidden hover:border-brand/40 transition group"
      >
        <div className="flex gap-3 p-3">
          <div className="relative shrink-0 w-32 sm:w-44 aspect-video rounded-lg overflow-hidden bg-[#f0f3f0]">
            {hero.thumbnail_url ? (
              <img
                src={hero.thumbnail_url}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : null}
            <div className="absolute inset-0 grid place-items-center bg-black/30 group-hover:bg-black/40 transition">
              <Play size={22} className="text-white drop-shadow" weight="fill" />
            </div>
            <div className="absolute right-1 bottom-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-2xs font-mono">
              {fmtDuration(hero.duration_sec)}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold leading-snug line-clamp-2">
              {hero.title}
            </div>
            {hero.summary_zh && (
              <div className="text-xs text-ink-2 mt-1 line-clamp-2 leading-relaxed">
                {hero.summary_zh}
              </div>
            )}
            <div className="text-2xs text-brand mt-1.5 inline-flex items-center gap-0.5">
              Continue <CaretRight size={12} weight="bold" />
            </div>
          </div>
        </div>
      </Link>

      {/* Collection ToC */}
      {coll && coll.items.length > 1 && (
        <div className="mt-7">
          <div className="text-2xs uppercase tracking-widest text-ink-3 font-semibold mb-2">
            合集里的其它段（共 {coll.items.length}）
          </div>
          <div className="card divide-y divide-line">
            {coll.items.map((it, i) => (
              <Link
                key={it.id}
                to={`/learn/${it.id}`}
                className={`flex items-center gap-3 p-2.5 hover:bg-[#f5f7f4] transition ${
                  it.is_current ? "bg-[#f4f9f6]" : ""
                }`}
              >
                <div className="shrink-0 w-7 text-center font-mono text-xs text-ink-3">
                  {it.segment_index ?? i + 1}
                </div>
                <div className="relative shrink-0 w-20 aspect-video rounded overflow-hidden bg-[#f0f3f0]">
                  {it.thumbnail_url ? (
                    <img
                      src={it.thumbnail_url}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : null}
                  <div className="absolute right-0.5 bottom-0.5 px-1 py-0 rounded bg-black/70 text-white text-2xs font-mono">
                    {fmtDuration(it.duration_sec)}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium leading-snug line-clamp-2">
                    {it.title}
                  </div>
                  <div className="text-2xs text-ink-3 mt-0.5 inline-flex items-center gap-1">
                    {it.is_current ? (
                      <span className="text-brand font-medium">↳ Now playing</span>
                    ) : it.progress_status === "finished" ? (
                      <span className="text-[#16a070] inline-flex items-center gap-0.5">
                        <Check size={11} weight="bold" /> 已完成
                      </span>
                    ) : it.progress_status === "in_progress" ? (
                      <span>学过一半</span>
                    ) : (
                      <span>未开始</span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Reopen onboarding (subtle) */}
      <div className="mt-10 text-center">
        <button
          onClick={() => reopen.mutate()}
          disabled={reopen.isPending}
          className="text-xs text-ink-3 hover:text-ink-2 inline-flex items-center gap-1.5"
        >
          <Lock size={12} /> 改回按话题主线学
        </button>
      </div>
    </div>
  );
}
