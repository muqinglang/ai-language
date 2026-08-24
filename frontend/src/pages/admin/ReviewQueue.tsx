import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Pager } from "@/components/Pager";

const PAGE_SIZE = 50;

/**
 * Req 5: morning review queue.
 * Lists every episode currently in draft / reviewing status — typically
 * what the auto-scheduler dropped overnight. Admin clicks 审核 to land
 * on the standard episode edit page (which already has the ReviewPane
 * affordances via the import flow + manual edits).
 */
const TOPIC_NAME: Record<string, string> = {
  ai: "AI 与大模型", tech: "科技编程", business: "商业创业",
  investing: "投资理财", career: "职场成长", lifestyle: "日常生活",
  travel: "旅行文化", food: "美食烹饪", health: "健康健身",
  psychology: "心理成长", science: "科学科普", education: "教育学习",
  entertainment: "影视娱乐", fashion: "时尚美妆", sports: "体育运动",
  outdoor: "户外探险", reading: "阅读书评", other: "其他",
};

export function AdminReviewQueue() {
  const [page, setPage] = useState(0);
  const { data: pageData, isLoading } = useQuery({
    queryKey: ["admin-review-queue", page],
    queryFn: () => api.adminReviewQueue(PAGE_SIZE, page * PAGE_SIZE),
    refetchInterval: 30_000,
  });
  const items = pageData?.items;

  // Group by speaker for the day-header style in the mockup
  const byCreator = new Map<string, typeof items>();
  for (const e of items ?? []) {
    const k = e.speaker_name ?? "未知博主";
    if (!byCreator.has(k)) byCreator.set(k, []);
    byCreator.get(k)!.push(e);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold">📥 待审 Queue</h2>
        <div className="text-xs text-ink-2">
          {pageData?.total ?? 0} 个未发布 · 来自定时导入或人工导入
        </div>
      </div>

      {isLoading && <div className="card p-5 text-sm text-ink-2">加载中…</div>}
      {!isLoading && !items?.length && (
        <div className="card p-8 text-center text-sm text-ink-2">
          🎉 全部审过了！没有等待发布的视频。
        </div>
      )}

      {Array.from(byCreator.entries()).map(([creator, eps]) => (
        <div key={creator} className="card p-5 mb-3">
          <div className="text-xs font-bold text-ink-2 pb-2 mb-3 border-b border-line">
            📺 {creator} ({eps?.length ?? 0})
          </div>
          <div className="space-y-2">
            {eps?.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[80px_1fr_220px_130px_70px] gap-3 items-center py-2"
              >
                <div
                  className="aspect-video rounded-md bg-cover bg-center bg-[#eff2ef]"
                  style={{ backgroundImage: `url(${e.thumbnail_url})` }}
                />
                <div>
                  <div className="text-sm font-medium text-ink truncate" title={e.title}>
                    {e.title}
                  </div>
                  <div className="text-2xs text-ink-3 mt-0.5">
                    {e.category_name ?? "—"} · {TOPIC_NAME[e.topic] ?? e.topic} · ★{e.difficulty} · {e.accent} ·{" "}
                    {Math.round(e.duration_sec / 60)} 分 {e.duration_sec % 60} 秒
                  </div>
                </div>
                <div className="text-2xs text-ink-2">
                  <span className="inline-block bg-amber-50 text-amber-900 px-1.5 py-0.5 rounded mr-1">
                    {e.chunks_count} chunks
                  </span>
                  <span className="inline-block bg-emerald-50 text-emerald-900 px-1.5 py-0.5 rounded">
                    {e.subtitles_count} 字幕
                  </span>
                </div>
                <div>
                  <span
                    className={`text-2xs px-2 py-0.5 rounded-full font-semibold ${
                      e.status === "reviewing"
                        ? "bg-[#fff2d6] text-[#b27700]"
                        : "bg-[#eff2ef] text-ink-2"
                    }`}
                  >
                    {e.status === "reviewing" ? "草稿 · 待审" : e.status}
                  </span>
                </div>
                <div>
                  <Link
                    to={`/admin/episodes/${e.id}`}
                    className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white font-semibold inline-block"
                  >
                    审核 →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <Pager page={page} pageSize={PAGE_SIZE} total={pageData?.total ?? 0} onPage={setPage} />
    </div>
  );
}
