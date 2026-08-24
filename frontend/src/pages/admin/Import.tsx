import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type DownloadProgress } from "@/lib/api";
import { Pager } from "@/components/Pager";
import { ReviewPane } from "./ReviewPane";

// Persists the active import task id across refresh / tab close so an
// admin who closes the page mid-import comes back to the live progress
// panel instead of a blank form. Cleared when the task hits a terminal
// state or the admin explicitly resets the form.
const ACTIVE_TASK_KEY = "js_admin_import_active_task";
// In-flight statuses for which we want the live progress panel to
// auto-attach from history (so admin can resume tracking ANY running
// task, not just one they started in this tab). pending_review is
// included because it needs admin action — surfacing it is the point.
const IN_FLIGHT_STATUSES = new Set([
  "queued", "fetching_metadata", "selecting_segment", "splitting_chapters",
  "downloading", "downloading_full", "transcribing", "chunking",
  "dialoging", "persisting", "pending_review",
]);
function isInFlight(status: string): boolean {
  if (IN_FLIGHT_STATUSES.has(status)) return true;
  // multi-segment progress markers ("full_segment_2_of_5", "[2/5] downloading")
  return /^full_segment_\d+_of_\d+$/.test(status) || /^\[\d+\/\d+\]/.test(status);
}

// Minutes since the task's last status update. Used to spot stuck
// pipelines (yt-dlp silently retrying on expired cookies, etc.) without
// the admin having to guess whether the bar is just slow.
function staleMinutes(updated_at: string): number {
  const t = new Date(updated_at).getTime();
  if (!isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function fmtSec(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60 | 0).toString().padStart(2, "0")}`;
}

function fmtBytes(b: number) {
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(2)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

function fmtRate(bps: number) {
  if (bps >= 1 << 20) return `${(bps / (1 << 20)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KiB/s`;
  return `${Math.round(bps)} B/s`;
}

// No new bytes for this long = throttled or cut off, not merely slow.
// 20s is ~10 backend samples, past any single-sample jitter.
const STALL_SEC = 20;

/** Live download readout, every number measured off the file on disk.
 *
 *  There is deliberately no completion percentage: ranged downloads are
 *  performed by ffmpeg, which never tells yt-dlp the total size, so any
 *  percent here would be invented. The bar tracks the one total we do
 *  know — the attempt's timeout budget. */
function DownloadMeter({ d }: { d: DownloadProgress }) {
  const stalled = d.stalled_sec >= STALL_SEC;
  const pctElapsed = Math.min(100, (d.elapsed_sec / Math.max(d.deadline_sec, 1)) * 100);
  return (
    <div
      className={`mt-3 rounded-lg border p-3 ${
        stalled ? "border-red-200 bg-red-50/60" : "border-[#ffd9a3] bg-[#f7fbf8]"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <b className="text-ink text-xs">⬇ {d.label}</b>
        <span className="tabular-nums text-ink">
          已下载 <b>{fmtBytes(d.bytes)}</b>
        </span>
        <span className={`tabular-nums ${stalled ? "text-red-600 font-semibold" : "text-ink-2"}`}>
          {fmtRate(d.rate_bps)}
        </span>
        <span className="tabular-nums text-ink-2">已用 {fmtSec(d.elapsed_sec)}</span>
        <span className="tabular-nums text-ink-3">超时剩余 {fmtSec(d.remaining_sec)}</span>
      </div>
      <div className="h-1.5 bg-[#eceef4] rounded mt-2 overflow-hidden">
        <div
          className={`h-full transition-all ${stalled ? "bg-red-400" : "bg-brand"}`}
          style={{ width: `${pctElapsed}%` }}
        />
      </div>
      <div className="text-2xs text-ink-3 mt-1">
        {stalled
          ? `⚠️ 已 ${fmtSec(d.stalled_sec)} 没有新数据 —— YouTube 多半在限速或已掐断连接`
          : "进度条是本次尝试的超时倒计时，不是下载完成度：ffmpeg 不上报总大小，所以这里只给实测字节数"}
      </div>
    </div>
  );
}

export function AdminImport() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  // Req 1: defaults are undefined so backend infers via LLM. Admin can still
  // override by picking explicitly. Once import completes, the actual
  // AI-decided values are surfaced via the "✨ AI 已选" chips on the episode
  // returned by the task — read in the live progress card below.
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [accent, setAccent] = useState<string | undefined>(undefined);
  const [difficulty, setDifficulty] = useState<number | undefined>(undefined);
  const [segmentsCount, setSegmentsCount] = useState(1);
  // Optional free-text directive that biases the LLM segment picker
  // to one sub-area (e.g. "cooking" / "AI alignment"). Empty = picker
  // chooses by general learning value (legacy behavior).
  const [topicHint, setTopicHint] = useState("");
  // Import mode: "highlight" picks 1-N AI-chosen windows; "full" splits
  // the whole video into 2-3min segments forming a Collection (legacy);
  // "chapters" keeps the whole video as ONE Episode with AI nav markers.
  const [mode, setMode] = useState<"highlight" | "full" | "chapters">("highlight");
  const [created, setCreated] = useState<number | null>(() => {
    const v = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_TASK_KEY) : null;
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  // Mirror `created` into localStorage so a refresh restores the live
  // progress panel for the same in-flight task.
  useEffect(() => {
    if (created != null) localStorage.setItem(ACTIVE_TASK_KEY, String(created));
    else localStorage.removeItem(ACTIVE_TASK_KEY);
  }, [created]);

  const { data: cats } = useQuery({ queryKey: ["cats"], queryFn: api.categories });
  const { data: task } = useQuery({
    queryKey: ["task", created],
    queryFn: () => api.adminImportGet(created!),
    enabled: !!created,
    refetchInterval: (q) =>
      q.state.data && ["published", "reviewing", "failed", "pending_review"].includes(q.state.data.status)
        ? false
        : 1000,
  });

  // Once the task fully terminates (review/published/failed), drop the
  // localStorage handle so the next fresh visit starts blank — but keep
  // the in-session `created` so the completion panel stays visible.
  useEffect(() => {
    if (task && ["reviewing", "published", "failed"].includes(task.status)) {
      localStorage.removeItem(ACTIVE_TASK_KEY);
    }
  }, [task?.status]);

  const [importError, setImportError] = useState<string | null>(null);

  const mutate = useMutation({
    mutationFn: () =>
      api.adminImportCreate({
        youtube_url: url,
        category_id: categoryId,
        // Req 1: omit when undefined so backend's LLM inferrer kicks in
        ...(accent !== undefined && { accent }),
        ...(difficulty !== undefined && { difficulty }),
        segments_count: mode === "highlight" ? segmentsCount : 1,
        topic_hint: topicHint.trim(),
        mode,
        force: false,
      }),
    onSuccess: (t) => {
      setImportError(null);
      setCreated(t.id);
      qc.invalidateQueries({ queryKey: ["admin-imports"] });
    },
    onError: (err: Error) => {
      // Parse the 409 dedup response to show the user a clear message
      // with a "force re-import" option.
      try {
        const body = JSON.parse(err.message.replace(/^4\d\d\s*/, ""));
        const detail = body?.detail ?? body;
        if (detail?.kind === "episode_exists" || detail?.kind === "import_in_flight") {
          setImportError(detail.message);
        } else {
          setImportError(err.message);
        }
      } catch {
        setImportError(err.message);
      }
    },
  });

  const forceImport = useMutation({
    mutationFn: () =>
      api.adminImportCreate({
        youtube_url: url,
        category_id: categoryId,
        ...(accent !== undefined && { accent }),
        ...(difficulty !== undefined && { difficulty }),
        segments_count: mode === "highlight" ? segmentsCount : 1,
        topic_hint: topicHint.trim(),
        mode,
        force: true,
      }),
    onSuccess: (t) => {
      setImportError(null);
      setCreated(t.id);
      qc.invalidateQueries({ queryKey: ["admin-imports"] });
    },
    onError: (err: Error) => setImportError(err.message),
  });

  const cancelMut = useMutation({
    mutationFn: (id: number) => api.adminImportCancel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-imports"] });
      qc.invalidateQueries({ queryKey: ["task"] });
    },
    onError: (err: Error) => alert("取消失败：" + err.message),
  });

  const stages = [
    { n: 1, label: "字幕拉取" },
    { n: 2, label: "AI 选段" },
    { n: 3, label: "下载 & 字幕" },
    { n: 4, label: "Chunk 提取" },
    { n: 5, label: "对话 & 入库" },
  ];

  // Backend `task.status` → human-readable Chinese sub-label. Shows under the
  // active stage card so the user can see exactly which sub-step is running
  // (e.g. download takes 30-60s and would otherwise look frozen at "处理中…").
  const STATUS_LABEL: Record<string, string> = {
    queued: "排队中",
    fetching_metadata: "拉取元数据 & 字幕",
    selecting_segment: "LLM 选段中",
    downloading: "下载视频片段",
    transcribing: "处理 / 翻译字幕",
    chunking: "提取 Chunk",
    dialoging: "生成对话脚本",
    persisting: "落库",
    qa: "落库",
    reviewing: "✓ 待审核",
    failed: "失败",
  };

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold">YouTube 导入</h2>
      </div>

      {/* State machine per mockup:
          - no task yet → show editable ① 粘贴 + ② 分类 form (the user is
            about to submit a brand-new import)
          - task exists → collapse both into "✓ done" cards showing the
            URL and the AI-inferred meta. Mockup reference: section 4
            of /admin-redesign.html (the "导入完成" state). */}
      {!task && (
        <>
          <div className="card p-5 mb-4">
            <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
              <i className="inline-block w-1 h-3.5 bg-brand rounded" />① 粘贴 YouTube 链接
            </h3>
            <div className="flex gap-2">
              <input className="input flex-1" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn-primary" onClick={() => mutate.mutate()} disabled={mutate.isPending}>
                🚀 提交到 Pipeline
              </button>
            </div>
            {importError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3 text-xs text-red-700">
                <div>{importError}</div>
                <button
                  onClick={() => forceImport.mutate()}
                  disabled={forceImport.isPending}
                  className="mt-2 px-3 py-1 bg-red-100 hover:bg-red-200 rounded text-red-700 font-medium"
                >
                  {forceImport.isPending ? "导入中..." : "强制重新导入"}
                </button>
              </div>
            )}
          </div>

          <div className="card p-5 mb-4">
            <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
              <i className="inline-block w-1 h-3.5 bg-brand rounded" />② 分类与元信息
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="分类">
                <select
                  className="input"
                  value={categoryId ?? ""}
                  onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
                >
                  <option value="">✨ AI 自动推断（推荐）</option>
                  {cats?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="难度">
                <select
                  className="input"
                  value={difficulty ?? ""}
                  onChange={(e) =>
                    setDifficulty(e.target.value === "" ? undefined : Number(e.target.value))
                  }
                >
                  <option value="">✨ AI 自动推断（推荐）</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      ★{n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="口音">
                <select
                  className="input"
                  value={accent ?? ""}
                  onChange={(e) =>
                    setAccent(e.target.value === "" ? undefined : e.target.value)
                  }
                >
                  <option value="">✨ AI 自动推断（推荐）</option>
                  <option value="US">🇺🇸 美国</option>
                  <option value="UK">🇬🇧 英国</option>
                  <option value="AU">🇦🇺 澳大利亚</option>
                  <option value="CA">🇨🇦 加拿大</option>
                  <option value="IN">🇮🇳 印度</option>
                </select>
              </Field>
              <Field label="导入模式">
                <select
                  className="input"
                  value={mode}
                  onChange={(e) =>
                    setMode(e.target.value as "highlight" | "full" | "chapters")
                  }
                >
                  <option value="highlight">⚡ AI 精选片段（默认）</option>
                  <option value="chapters">🎬 全片 + 章节导航</option>
                  <option value="full">📚 全片切分（合集 · 旧版）</option>
                </select>
              </Field>
              {mode === "highlight" ? (
                <Field label="切段数">
                  <select
                    className="input"
                    value={segmentsCount}
                    onChange={(e) => setSegmentsCount(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n === 1 ? "1 段（默认）" : `${n} 段`}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : mode === "chapters" ? (
                <Field label="说明">
                  <div className="text-2xs text-ink-3 leading-[1.5] pt-2">
                    保留整片为 1 个 Episode，LLM 生成章节标记供页内跳转（不切分、不影响对话）。
                  </div>
                </Field>
              ) : (
                <Field label="说明">
                  <div className="text-2xs text-ink-3 leading-[1.5] pt-2">
                    LLM 把整片切成 2-3 分钟 / 段（最多 20 段），并行处理。
                  </div>
                </Field>
              )}
            </div>
            {/* topic_hint — biases the LLM segment picker to one sub-area.
                Empty = default behavior (picks by "learning value"). */}
            <div className="mt-3">
              <Field label="想要的方向（可选）">
                <input
                  className="input"
                  placeholder='例如：cooking / AI 提示词 / 面试准备 — 留空 = AI 自由挑'
                  value={topicHint}
                  onChange={(e) => setTopicHint(e.target.value)}
                />
                <div className="text-2xs text-ink-3 mt-1.5 leading-[1.5]">
                  AI 会只挑这个方向的片段。1 小时的播客里跨多个话题时特别有用 ——
                  不写就是「随便挑」，写了就是「只挑做饭/只挑 AI 对齐」。
                </div>
              </Field>
            </div>
          </div>
        </>
      )}

      {task && (
        <CollapsedHeader
          task={task}
          onResetForNewImport={() => {
            setCreated(null);
            setUrl("");
            setCategoryId(undefined);
            setDifficulty(undefined);
            setAccent(undefined);
            setSegmentsCount(1);
            setTopicHint("");
            setMode("highlight");
            setImportError(null);
          }}
        />
      )}

      {task && (
        <div className="card p-5">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
            <i className="inline-block w-1 h-3.5 bg-brand rounded" />③ Pipeline 进度
          </h3>
          <div className="grid grid-cols-5 gap-2.5">
            {stages.map((s) => {
              const done = task.stage > s.n || task.status === "reviewing" || task.status === "published";
              const running = task.stage === s.n && task.status !== "queued" && !done;
              const subLabel = running ? (STATUS_LABEL[task.status] ?? task.status) : null;
              return (
                <div key={s.n} className="card p-3">
                  <div className="text-2xs text-ink-3 font-bold tracking-wider">STAGE {s.n}</div>
                  <h4 className="text-sm mt-1">{s.label}</h4>
                  <span
                    className={`text-2xs px-2 py-0.5 rounded-full inline-block mt-1.5 font-semibold ${
                      done
                        ? "bg-[#e6f7ef] text-[#16a070]"
                        : running
                          ? "bg-[#fff2d6] text-[#b27700]"
                          : "bg-[#eff2ef] text-ink-2"
                    }`}
                  >
                    {done ? "✓ 完成" : running ? "处理中…" : "排队中"}
                  </span>
                  {subLabel && (
                    <div className="text-2xs text-ink-2 mt-1 truncate" title={subLabel}>
                      {subLabel}
                    </div>
                  )}
                  <div className="h-1 bg-[#eceef4] rounded mt-2 overflow-hidden">
                    <div
                      className="h-full bg-brand transition-all"
                      style={{ width: done ? "100%" : running ? "60%" : "0%" }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-xs text-ink-2 mt-3 flex flex-wrap items-center gap-2">
            <span>
              当前状态: <b className="text-ink">{task.status}</b> · 进度 {task.progress}%
              {task.episode_id && (
                <>
                  {" "}
                  · 生成的 episode_id = <b className="text-ink">{task.episode_id}</b>
                </>
              )}
            </span>
            {(() => {
              if (!isInFlight(task.status) || task.status === "pending_review") return null;
              // A live download proves the task is alive even though its DB
              // row hasn't been touched for minutes (mark() only fires on
              // stage transitions). Defer to the measured byte counter and
              // let DownloadMeter own the stall warning — otherwise every
              // slow-but-healthy download is libeled as "大概率卡住".
              if (task.download && task.download.stalled_sec < 20) return null;
              const m = staleMinutes(task.updated_at);
              if (m < 2) return null;
              const tone =
                m >= 5
                  ? "bg-red-50 text-red-700 border-red-200"
                  : "bg-[#fff2d6] text-[#b27700] border-[#ffd9a3]";
              return (
                <>
                  <span className={`px-2 py-0.5 rounded-full text-2xs font-semibold border ${tone}`}>
                    已 {m} 分钟未更新{m >= 5 ? " · 大概率卡住" : ""}
                  </span>
                  <button
                    onClick={() => {
                      if (confirm(
                        "强制取消？\n\n这会立刻把任务标为 failed，让你能重试或删除。\n" +
                        "后台 yt-dlp 进程仍会按自己的超时(~10 分钟)收尾，但行立刻释放。\n\n" +
                        "提示：YouTube cookies 可能过期 —— 重试前先跑 scripts/refresh-yt-cookies.sh。",
                      )) cancelMut.mutate(task.id);
                    }}
                    disabled={cancelMut.isPending}
                    className="px-2 py-0.5 rounded bg-red-50 text-red-600 hover:bg-red-100 text-2xs font-semibold disabled:opacity-50"
                  >
                    强制取消
                  </button>
                </>
              );
            })()}
          </div>
          {task.download && <DownloadMeter d={task.download} />}
        </div>
      )}

      {/* Req 3: inline review pane(s) once pipeline completed. Multi-segment
          imports stack one pane per produced episode (each segment gets its
          own ep_id stamped into selected_segment.segments[i].episode_id by
          pipeline._process_segment). */}
      {task && (task.status === "reviewing" || task.status === "published") && (
        <ReviewPanes task={task} />
      )}

      {task && task.status === "pending_review" && (
        <SegmentPreview task={task} onApproved={() => setCreated(task.id)} />
      )}

      <ImportHistory setCreatedFromHistory={setCreated} currentTaskId={created} />
    </>
  );
}


function SegmentPreview({ task, onApproved }: { task: { id: number; selected_segment: Record<string, unknown> }; onApproved: () => void }) {
  const qc = useQueryClient();
  const sel = task.selected_segment as { segments?: Array<{ source_start: number; source_end: number; reason?: string }>; full_duration?: number };
  const initial = sel?.segments ?? [];
  const fullDur = sel?.full_duration ?? 0;
  const [segs, setSegs] = useState(initial);

  const approve = useMutation({
    mutationFn: () => api.adminImportApprove(task.id, segs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", task.id] });
      onApproved();
    },
  });

  if (!segs.length) return null;

  const adjust = (idx: number, field: "source_start" | "source_end", delta: number) => {
    setSegs((prev) => {
      const copy = prev.map((s) => ({ ...s }));
      copy[idx][field] = Math.max(0, Math.min(copy[idx][field] + delta, fullDur || 99999));
      return copy;
    });
  };

  return (
    <div className="card p-5 mt-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <i className="inline-block w-1 h-3.5 bg-brand rounded" />
        AI 选段预览 — 确认或微调后开始下载
      </h3>
      <div className="flex flex-col gap-3">
        {segs.map((s, i) => (
          <div key={i} className="card p-3 flex items-center gap-3">
            <span className="text-xs font-bold text-ink-2 w-6">#{i + 1}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => adjust(i, "source_start", -15)} className="px-1.5 py-0.5 text-2xs bg-[#f0f3f0] rounded">-15s</button>
              <span className="text-xs font-mono w-12 text-center">{fmtSec(s.source_start)}</span>
              <button onClick={() => adjust(i, "source_start", 15)} className="px-1.5 py-0.5 text-2xs bg-[#f0f3f0] rounded">+15s</button>
            </div>
            <span className="text-ink-2">—</span>
            <div className="flex items-center gap-1">
              <button onClick={() => adjust(i, "source_end", -15)} className="px-1.5 py-0.5 text-2xs bg-[#f0f3f0] rounded">-15s</button>
              <span className="text-xs font-mono w-12 text-center">{fmtSec(s.source_end)}</span>
              <button onClick={() => adjust(i, "source_end", 15)} className="px-1.5 py-0.5 text-2xs bg-[#f0f3f0] rounded">+15s</button>
            </div>
            <span className="text-2xs text-ink-2 flex-1 min-w-0 truncate">{s.reason ?? ""}</span>
            <span className="text-2xs text-ink-3">{Math.round(s.source_end - s.source_start)}s</span>
          </div>
        ))}
      </div>
      <button
        onClick={() => approve.mutate()}
        disabled={approve.isPending}
        className="btn-primary mt-4"
      >
        {approve.isPending ? "下载中..." : `确认并下载 ${segs.length} 段`}
      </button>
    </div>
  );
}


/**
 * Compact "✓ done" stack for ① 链接 + ② 元信息, shown once an import is
 * in flight. Matches the mockup's done-state design — the editable form
 * collapses into a green-bordered single-line URL row + a 4-column AI
 * meta row with ✨ AI suggested chips. Admin can click "+ 新建导入" to
 * reset back to the editable form for the next URL.
 */
function CollapsedHeader({
  task,
  onResetForNewImport,
}: {
  task: { youtube_url: string; episode_id: number | null };
  onResetForNewImport: () => void;
}) {
  // Read AI-inferred values from the just-created episode. Only available
  // after stage 5 commit; before that we render the row with placeholders.
  const { data: ep } = useQuery({
    queryKey: ["admin-episode", task.episode_id],
    queryFn: () => api.adminGetEpisode(task.episode_id!),
    enabled: !!task.episode_id,
  });
  const TOPIC_NAME: Record<string, string> = {
    ai: "AI 与大模型", tech: "科技编程", business: "商业创业",
    investing: "投资理财", career: "职场成长", lifestyle: "日常生活",
    travel: "旅行文化", food: "美食烹饪", health: "健康健身",
    psychology: "心理成长", science: "科学科普", education: "教育学习",
    entertainment: "影视娱乐", fashion: "时尚美妆", sports: "体育运动",
    outdoor: "户外探险", reading: "阅读书评", other: "其他",
  };
  const ACCENT_LABEL: Record<string, string> = {
    US: "🇺🇸 US", UK: "🇬🇧 UK", AU: "🇦🇺 AU",
    CA: "🇨🇦 CA", IN: "🇮🇳 IN", ZA: "🇿🇦 ZA",
  };
  return (
    <>
      {/* ① 链接 — collapsed */}
      <div
        className="rounded-xl border border-[#16a070]/40 bg-[#fafbfc] p-3 mb-3 flex items-center justify-between gap-2"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-[#e6f7ef] text-[#16a070] shrink-0">
            ✓
          </span>
          <span className="text-sm shrink-0">
            <b>① 链接</b>
            <span className="text-ink-3"> · </span>
          </span>
          <code
            className="text-xs text-ink-2 truncate font-mono"
            title={task.youtube_url}
          >
            {task.youtube_url}
          </code>
        </div>
        <button
          onClick={onResetForNewImport}
          className="text-xs px-2.5 py-1 rounded-lg bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2 shrink-0"
          title="清空表单，开始一个新的导入"
        >
          + 新建导入
        </button>
      </div>

      {/* ② 元信息 — collapsed with AI suggested chips */}
      <div
        className="rounded-xl border border-[#16a070]/40 bg-[#fafbfc] p-3.5 mb-3"
      >
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-[#e6f7ef] text-[#16a070]">
            ✓
          </span>
          <span className="text-sm">
            <b>② 元信息</b>
          </span>
          {!ep && (
            <span className="text-2xs text-ink-3 ml-2">
              （pipeline 完成后填充）
            </span>
          )}
        </div>
        {ep && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetaChip label="分类" value={ep.category_name ?? "—"} />
              <MetaChip label="话题" value={TOPIC_NAME[ep.topic] ?? ep.topic} />
              <MetaChip label="难度" value={`★${ep.difficulty}`} />
              <MetaChip label="口音" value={ACCENT_LABEL[ep.accent] ?? ep.accent} />
            </div>
            <div className="text-2xs text-ink-3 mt-2">
              → 全部 AI 推断；点 ④ 审核区右侧的 ✏️ 高级编辑可手改
            </div>
          </>
        )}
      </div>
    </>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs text-ink-3 mb-0.5">{label}</div>
      <div className="text-sm text-ink font-medium flex items-center gap-1.5">
        {value}
        <span className="text-2xs px-1.5 py-0.5 rounded-full bg-[#eaf3ec] text-[#f97316] font-semibold">
          ✨ AI
        </span>
      </div>
    </div>
  );
}


/**
 * Renders one ReviewPane per produced episode. Single-segment imports get
 * exactly one (task.episode_id); multi-segment imports get one per entry in
 * task.selected_segment.segments[*].episode_id.
 */
function ReviewPanes({
  task,
}: {
  task: {
    id: number;
    episode_id: number | null;
    selected_segment: Record<string, unknown> | null;
  };
}) {
  // Collect episode IDs from selected_segment.segments first, fall back to the
  // top-level task.episode_id (single segment path).
  const ids: number[] = [];
  const segs = (task.selected_segment as { segments?: Array<{ episode_id?: number }> } | null)?.segments;
  if (segs?.length) {
    for (const s of segs) if (s.episode_id) ids.push(s.episode_id);
  }
  if (!ids.length && task.episode_id) ids.push(task.episode_id);
  if (!ids.length) return null;
  return (
    <>
      {ids.map((id) => (
        <ReviewPane key={id} episodeId={id} />
      ))}
    </>
  );
}

function ImportHistory({
  setCreatedFromHistory,
  currentTaskId,
}: {
  setCreatedFromHistory?: (id: number) => void;
  currentTaskId?: number | null;
}) {
  const qc = useQueryClient();
  const [histPage, setHistPage] = useState(0);
  const HIST_SIZE = 20;
  const { data: histData } = useQuery({
    queryKey: ["admin-imports", histPage],
    queryFn: () => api.adminImports(HIST_SIZE, histPage * HIST_SIZE),
    refetchInterval: 10_000,
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.adminImportDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-imports"] }),
  });
  // Retry hooks the new task's id into the live-progress UI on the parent
  // (via setCreatedFromHistory), so the user sees pipeline stages on the
  // same screen instead of having to find their retry in the history table.
  const retryMut = useMutation({
    mutationFn: (id: number) => api.adminImportRetry(id),
    onSuccess: (newTask: { id: number }) => {
      setCreatedFromHistory?.(newTask.id);
      qc.invalidateQueries({ queryKey: ["admin-imports"] });
    },
  });
  const cancelMut = useMutation({
    mutationFn: (id: number) => api.adminImportCancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-imports"] }),
    onError: (err: Error) => alert("取消失败：" + err.message),
  });

  const recent = histData?.items ?? [];
  if (recent.length === 0 && histPage === 0) return null;

  return (
    <div className="card p-5 mt-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <i className="inline-block w-1 h-3.5 bg-brand rounded" />
        历史导入
        <span className="text-2xs text-ink-3 font-normal ml-1">
          （本页 {recent.length} 条 · 总计 {histData?.total ?? 0}）
        </span>
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-ink-2 border-b border-line text-left">
              <th className="py-2 px-2">#</th>
              <th className="py-2 px-2">URL</th>
              <th className="py-2 px-2">状态</th>
              <th className="py-2 px-2">Episode</th>
              <th className="py-2 px-2">错误</th>
              <th className="py-2 px-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((t) => (
              <tr key={t.id} className="border-b border-line/50 hover:bg-[#f5f7f4]">
                <td className="py-2 px-2 text-ink-2">{t.id}</td>
                <td className="py-2 px-2 max-w-[200px] truncate" title={t.youtube_url}>
                  {t.youtube_url.replace(/https?:\/\/(www\.)?youtube\.com\/watch\?v=/, "")}
                </td>
                <td className="py-2 px-2">
                  <span
                    className={`px-2 py-0.5 rounded-full text-2xs font-semibold ${
                      t.status === "failed"
                        ? "bg-red-50 text-red-600"
                        : t.status === "reviewing" || t.status === "published"
                          ? "bg-[#e6f7ef] text-[#16a070]"
                          : "bg-[#fff2d6] text-[#b27700]"
                    }`}
                  >
                    {t.status}
                  </span>
                  {t.download && (
                    <div
                      className={`text-2xs mt-1 tabular-nums ${
                        t.download.stalled_sec >= STALL_SEC ? "text-red-600" : "text-ink-3"
                      }`}
                    >
                      {fmtBytes(t.download.bytes)} · {fmtRate(t.download.rate_bps)}
                      {t.download.stalled_sec >= STALL_SEC && ` · 停滞 ${fmtSec(t.download.stalled_sec)}`}
                    </div>
                  )}
                </td>
                <td className="py-2 px-2">{t.episode_id ?? "—"}</td>
                <td className="py-2 px-2 max-w-[200px] truncate text-red-500" title={t.error}>
                  {t.error || "—"}
                </td>
                <td className="py-2 px-2 flex gap-1 flex-wrap">
                  {t.status === "pending_review" && (
                    <button
                      onClick={() => setCreatedFromHistory?.(t.id)}
                      className="px-2 py-0.5 rounded bg-brand text-white hover:opacity-90"
                      title="打开审核面板，预览/微调段位后确认下载"
                    >
                      👁 审核
                    </button>
                  )}
                  {isInFlight(t.status) && t.status !== "pending_review" && t.id !== currentTaskId && (
                    <button
                      onClick={() => setCreatedFromHistory?.(t.id)}
                      className="px-2 py-0.5 rounded bg-[#fff2d6] text-[#b27700] hover:bg-[#ffe7b3]"
                      title="把这条进行中的任务挂到上方进度面板"
                    >
                      📡 查看进度
                    </button>
                  )}
                  {/* Same deference as the live panel: bytes still moving
                      means alive, however old the row's updated_at is. */}
                  {isInFlight(t.status) && t.status !== "pending_review"
                    && !(t.download && t.download.stalled_sec < STALL_SEC)
                    && staleMinutes(t.updated_at) >= 2 && (
                    <button
                      onClick={() => {
                        if (confirm("强制取消？任务会标 failed 释放掉，方便重试。\n提示：YouTube cookies 可能过期。"))
                          cancelMut.mutate(t.id);
                      }}
                      disabled={cancelMut.isPending}
                      className="px-2 py-0.5 rounded bg-red-50 text-red-600 hover:bg-red-100 font-semibold disabled:opacity-50"
                      title={`已 ${staleMinutes(t.updated_at)} 分钟未更新 —— 大概率卡住`}
                    >
                      🛑 取消
                    </button>
                  )}
                  {(t.status === "failed" || t.status === "reviewing" || t.status === "published") && (
                    <button
                      onClick={() => retryMut.mutate(t.id)}
                      className="px-2 py-0.5 rounded bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2"
                      title="用同一 URL 重新导入"
                    >
                      🔁 重试
                    </button>
                  )}
                  {/* Delete is allowed for any non-running terminal-ish row,
                       plus pending_review (so admin can clear duplicate
                       paused tasks). Not while actively downloading. */}
                  {(t.status === "failed" || t.status === "reviewing" || t.status === "published" || t.status === "pending_review") && (
                    <button
                      onClick={() => {
                        if (confirm("确认删除此导入记录？")) deleteMut.mutate(t.id);
                      }}
                      className="px-2 py-0.5 rounded bg-[#f0f3f0] hover:bg-red-50 text-ink-2 hover:text-red-600"
                    >
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager
        page={histPage}
        pageSize={HIST_SIZE}
        total={histData?.total ?? 0}
        onPage={setHistPage}
      />
    </div>
  );
}


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-ink-2 mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}
