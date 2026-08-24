import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";

export function AdminDashboard() {
  const { data: stats } = useQuery({ queryKey: ["admin-stats"], queryFn: api.adminStats });
  const { data: episodes } = useQuery({
    queryKey: ["admin-episodes-dash"],
    queryFn: () => api.adminListEpisodes({ limit: 15 }),
  });

  const recent = episodes?.items ?? [];

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold">Dashboard</h2>
        <div className="flex gap-2">
          <Link to="/" target="_blank" className="btn-ghost text-sm">
            前台首页 ↗
          </Link>
          <Link to="/admin/import" className="btn-primary">
            + 新建导入任务
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <Kpi k="总视频数" v={stats?.total_episodes ?? 0} d={`已发布 ${stats?.published ?? 0} · 审核中 ${stats?.reviewing ?? 0} · 草稿 ${stats?.draft ?? 0}`} />
        <Kpi k="用户数" v={stats?.total_users ?? 0} d="" />
        <Kpi k="AI 对话次数" v={stats?.total_conversations ?? 0} d="" />
        <Kpi k="Chunk 库" v={stats?.total_chunks ?? 0} d="" />
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-bold mb-3">最新视频</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-ink-2 bg-[#f8faf8]">
              <th className="text-left py-2.5 px-2">#</th>
              <th className="text-left py-2.5 px-2">标题</th>
              <th className="text-left py-2.5 px-2">状态</th>
              <th className="text-left py-2.5 px-2">Chunks</th>
              <th className="text-left py-2.5 px-2">字幕</th>
              <th className="text-left py-2.5 px-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((ep) => (
              <tr key={ep.id} className="border-t border-line">
                <td className="py-2.5 px-2 text-ink-2">{ep.id}</td>
                <td className="py-2.5 px-2 truncate max-w-[320px] font-medium">
                  {ep.title}
                </td>
                <td className="py-2.5 px-2">
                  <span
                    className={`text-2xs px-2 py-0.5 rounded-full ${
                      ep.status === "published"
                        ? "bg-green-50 text-green-700"
                        : ep.status === "reviewing"
                        ? "bg-orange-50 text-orange-600"
                        : "bg-gray-100 text-ink-2"
                    }`}
                  >
                    {ep.status}
                  </span>
                </td>
                <td className="py-2.5 px-2 text-ink-2">{ep.chunks_count}</td>
                <td className="py-2.5 px-2 text-ink-2">{ep.subtitles_count}</td>
                <td className="py-2.5 px-2 flex gap-2">
                  <Link
                    to={`/learn/${ep.id}`}
                    target="_blank"
                    className="text-xs text-brand hover:underline"
                  >
                    查看
                  </Link>
                  <Link
                    to={`/admin/episodes/${ep.id}`}
                    className="text-xs text-ink-2 hover:text-ink"
                  >
                    编辑
                  </Link>
                </td>
              </tr>
            ))}
            {!recent.length && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-ink-2 text-sm">
                  还没有视频
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Kpi({ k, v, d }: { k: string; v: number; d: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-2">{k}</div>
      <div className="text-2xl font-extrabold tracking-tight mt-1">{v}</div>
      <div className="text-2xs text-ink-2 mt-1">{d}</div>
    </div>
  );
}
