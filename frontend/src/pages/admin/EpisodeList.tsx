import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Pager } from "@/components/Pager";

const BROKEN_CODECS = ["av1", "vp9", "vp09"];
const SAFE_CODECS = ["h264", "avc1"];

function codecBadge(codec: string) {
  if (SAFE_CODECS.includes(codec))
    return <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-[#e6f7ef] text-[#16a070]">H.264 ✓</span>;
  if (BROKEN_CODECS.includes(codec))
    return <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-[#e8f2eb] text-brand">⚠️ iPhone 不兼容</span>;
  return <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-[#eff2ef] text-ink-2">未扫描</span>;
}

const STATUS_OPTIONS: { v: string | undefined; label: string; cls: string }[] = [
  { v: undefined, label: "全部", cls: "" },
  { v: "draft", label: "草稿", cls: "bg-[#eff2ef] text-ink-2" },
  { v: "reviewing", label: "待审核", cls: "bg-[#fff2d6] text-[#b27700]" },
  { v: "published", label: "已发布", cls: "bg-[#e6f7ef] text-[#16a070]" },
  { v: "archived", label: "已下架", cls: "bg-[#eff2ef] text-ink-2" },
];

function statusBadge(status: string) {
  const opt = STATUS_OPTIONS.find((o) => o.v === status);
  const cls = opt?.cls ?? "bg-[#eff2ef] text-ink-2";
  const label = opt?.label ?? status;
  return <span className={`text-2xs px-2 py-0.5 rounded-full font-semibold ${cls}`}>{label}</span>;
}

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const PAGE_SIZE = 50;

export function AdminEpisodeList() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const { data: pageData, isLoading } = useQuery({
    queryKey: ["admin-episodes", status, q, page],
    queryFn: () =>
      api.adminListEpisodes({
        status,
        q: q || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });
  const data = pageData?.items;
  // Filters change the result set — snap back to page 1.
  useEffect(() => { setPage(0); }, [status, q]);

  const publish = useMutation({
    mutationFn: (id: number) => api.adminPublishEpisode(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episodes"] }),
  });
  const unpublish = useMutation({
    mutationFn: (id: number) => api.adminUnpublishEpisode(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episodes"] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.adminDeleteEpisode(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episodes"] }),
  });

  // "Push to prod" — only wired on the local dev stack (which runs the
  // pipeline). The remote ECS leaves PUBLISH_TARGET_* empty → button hidden.
  const { data: pushTarget } = useQuery({
    queryKey: ["admin-push-target"],
    queryFn: () => api.adminPushTarget(),
    staleTime: 5 * 60_000,
  });
  const push = useMutation({
    mutationFn: (id: number) => api.adminPushToProd(id),
    onSuccess: (r) => alert(`✅ 已推送到生产 ${r.target}\n${r.count} 个 Episode：${r.episode_ids.join(", ")}`),
    onError: (e: unknown) => alert(`❌ 推送失败：${e instanceof Error ? e.message : String(e)}`),
  });

  // Live transcode queue. Poll every 3s while the page is open; the
  // endpoint is a tiny in-memory snapshot so this is cheap.
  const { data: tc } = useQuery({
    queryKey: ["transcode-status"],
    queryFn: () => api.adminTranscodeStatus(),
    refetchInterval: 3000,
  });
  // When the queue signature changes (something finished / started),
  // refetch the episode list so video_codec / badges update.
  const sigRef = useRef("");
  useEffect(() => {
    if (!tc) return;
    const sig = JSON.stringify(tc.states) + "|" + tc.active;
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
    }
  }, [tc, qc]);

  const scan = useMutation({
    mutationFn: () => api.adminScanCodecs(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
      alert(`扫描完成：共 ${r.scanned} 个，更新 ${r.updated} 个。\nH.264: ${r.by_codec.h264 ?? 0} · iPhone 不兼容: ${r.iphone_broken}`);
    },
  });
  const transcodeOne = useMutation({
    mutationFn: (id: number) => api.adminTranscodeEpisode(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transcode-status"] });
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
    },
  });
  const transcodeAll = useMutation({
    mutationFn: () => api.adminTranscodeAllAv1(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["transcode-status"] });
      alert(`已加入队列：${r.queued} 个（共 ${r.total_av1} 个 AV1）。单飞队列后台逐个转，可关闭页面。`);
    },
  });

  const states: Record<string, string> = tc?.states ?? {};
  const av1Count = (data ?? []).filter((e) => BROKEN_CODECS.includes(e.video_codec)).length;
  const activeId = tc?.active ?? null;
  const queuedN = tc?.queued?.length ?? 0;

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold">视频管理</h2>
        <Link to="/admin/import" className="btn-primary">
          + 导入新视频
        </Link>
      </div>

      <div className="card p-4 mb-4 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-ink-2">状态</span>
        {STATUS_OPTIONS.map((o) => (
          <button
            key={o.label}
            onClick={() => setStatus(o.v)}
            className={`chip ${status === o.v ? "chip-on" : ""}`}
          >
            {o.label}
          </button>
        ))}
        <div className="flex-1" />
        <input
          className="input !py-2 max-w-xs"
          placeholder="搜索标题…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="card p-4 mb-4 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-ink-2">iPhone 兼容</span>
        <button
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
          className="text-xs px-3 py-1.5 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3] disabled:opacity-50"
          title="ffprobe 所有视频，回填编码（首次需要先扫描）"
        >
          {scan.isPending ? "扫描中…" : "扫描编码"}
        </button>
        <button
          onClick={() => {
            if (confirm(`将 ${av1Count} 个 AV1 视频加入转码队列？后台单飞逐个转，每个约 3-5 分钟。`))
              transcodeAll.mutate();
          }}
          disabled={transcodeAll.isPending || av1Count === 0}
          className="text-xs px-3 py-1.5 rounded-md bg-brand text-white hover:opacity-90 disabled:opacity-40"
        >
          一键转码全部 AV1（{av1Count}）
        </button>
        {(activeId != null || queuedN > 0) && (
          <span className="text-xs text-[#b27700]">
            {activeId != null ? `转码中: #${activeId}` : "队列就绪"}
            {queuedN > 0 && ` · 队列 ${queuedN}`}
          </span>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-ink-2 bg-[#f8faf8]">
              <th className="text-left py-3 px-4">封面</th>
              <th className="text-left py-3 px-2">标题</th>
              <th className="text-left py-3 px-2">分类</th>
              <th className="text-left py-3 px-2">难度</th>
              <th className="text-left py-3 px-2">时长</th>
              <th className="text-left py-3 px-2">字幕/Chunk</th>
              <th className="text-left py-3 px-2">iPhone 兼容</th>
              <th className="text-left py-3 px-2">状态</th>
              <th className="text-right py-3 px-4">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-ink-2">
                  loading…
                </td>
              </tr>
            )}
            {!isLoading && data?.length === 0 && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-ink-2">
                  暂无视频
                </td>
              </tr>
            )}
            {data?.map((ep) => (
              <tr key={ep.id} className="border-t border-line hover:bg-[#f8faf8]">
                <td className="py-3 px-4">
                  <div className="w-16 h-10 bg-[#f0f3f0] rounded overflow-hidden">
                    {ep.thumbnail_url && (
                      <img src={ep.thumbnail_url} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                </td>
                <td className="py-3 px-2 max-w-[280px]">
                  <div className="font-semibold text-ink truncate">{ep.title}</div>
                  <div className="text-2xs text-ink-2 truncate">{ep.summary}</div>
                </td>
                <td className="py-3 px-2 text-xs">{ep.category_name ?? "—"}</td>
                <td className="py-3 px-2 text-xs">{"★".repeat(ep.difficulty)}</td>
                <td className="py-3 px-2 text-xs font-variant-numeric tabular-nums">
                  {fmtDuration(ep.duration_sec)}
                </td>
                <td className="py-3 px-2 text-xs">
                  {ep.subtitles_count} / {ep.chunks_count}
                </td>
                <td className="py-3 px-2">
                  {(() => {
                    const st = states[String(ep.id)] || ep.transcode_state || "";
                    if (st === "running")
                      return <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-[#fff2d6] text-[#b27700]">转码中…</span>;
                    if (st === "queued")
                      return <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-[#eff2ef] text-ink-2">排队中</span>;
                    if (BROKEN_CODECS.includes(ep.video_codec))
                      return (
                        <div className="flex items-center gap-1.5">
                          {codecBadge(ep.video_codec)}
                          <button
                            onClick={() => transcodeOne.mutate(ep.id)}
                            disabled={transcodeOne.isPending}
                            className="text-2xs px-2 py-0.5 rounded-md bg-brand text-white hover:opacity-90 disabled:opacity-50"
                          >
                            {st === "error" ? "重试" : "转 H.264"}
                          </button>
                          {st === "error" && <span className="text-2xs text-brand">失败</span>}
                        </div>
                      );
                    return codecBadge(ep.video_codec);
                  })()}
                </td>
                <td className="py-3 px-2">{statusBadge(ep.status)}</td>
                <td className="py-3 px-4 text-right">
                  <div className="inline-flex gap-1">
                    <Link
                      to={`/learn/${ep.id}`}
                      className="text-xs px-2.5 py-1 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3]"
                      title="在前台用学习页打开（admin 也能看）"
                    >
                      查看
                    </Link>
                    <Link
                      to={`/admin/episodes/${ep.id}`}
                      className="text-xs px-2.5 py-1 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3]"
                    >
                      编辑
                    </Link>
                    {ep.status !== "published" ? (
                      <button
                        onClick={() => publish.mutate(ep.id)}
                        disabled={publish.isPending}
                        className="text-xs px-2.5 py-1 rounded-md bg-[#16a070] text-white hover:bg-[#138a5c]"
                      >
                        发布
                      </button>
                    ) : (
                      <button
                        onClick={() => unpublish.mutate(ep.id)}
                        disabled={unpublish.isPending}
                        className="text-xs px-2.5 py-1 rounded-md bg-[#fff2d6] text-[#b27700] hover:bg-[#ffe7b3]"
                      >
                        下架
                      </button>
                    )}
                    {pushTarget?.enabled && (
                      <button
                        onClick={() => {
                          if (
                            confirm(
                              `推送「${ep.title}」所属合集到生产？\n` +
                                `目标：${pushTarget.target}\n` +
                                `会导出该视频的全部分段并上传（已存在则覆盖）。`,
                            )
                          )
                            push.mutate(ep.id);
                        }}
                        disabled={push.isPending}
                        className="text-xs px-2.5 py-1 rounded-md bg-[#eef3ff] text-[#2b5cff] hover:bg-[#dde7ff] disabled:opacity-50"
                        title="导出该视频所属合集并发布到生产 ECS"
                      >
                        {push.isPending ? "推送中…" : "↗ 推送生产"}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm(`确认删除「${ep.title}」？此操作不可恢复`)) del.mutate(ep.id);
                      }}
                      className="text-xs px-2.5 py-1 rounded-md text-ink-2 hover:bg-[#e8f2eb] hover:text-brand"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        total={pageData?.total ?? 0}
        onPage={setPage}
      />

      <div className="text-xs text-ink-2 mt-3">
        共 <b className="text-ink">{pageData?.total ?? 0}</b> 个视频
        {status && <> · 筛选状态: <b className="text-ink">{STATUS_OPTIONS.find((o) => o.v === status)?.label}</b></>}
      </div>
    </>
  );
}
