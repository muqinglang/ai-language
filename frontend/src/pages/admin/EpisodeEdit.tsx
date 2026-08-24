import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TextareaHTMLAttributes } from "react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "@/lib/api";

const ACCENTS = ["US", "UK", "AU", "CA", "IN", "ZA"];
const CHUNK_TYPES = ["idiomatic", "collocation", "discourse", "functional", "cultural"];

function statusBadge(status: string) {
  const map: Record<string, [string, string]> = {
    draft: ["草稿", "bg-[#eff2ef] text-ink-2"],
    reviewing: ["待审核", "bg-[#fff2d6] text-[#b27700]"],
    published: ["已发布", "bg-[#e6f7ef] text-[#16a070]"],
    archived: ["已下架", "bg-[#eff2ef] text-ink-2"],
  };
  const [label, cls] = map[status] ?? [status, "bg-[#eff2ef] text-ink-2"];
  return <span className={`text-2xs px-2.5 py-1 rounded-full font-semibold ${cls}`}>{label}</span>;
}

const BROKEN_CODECS = ["av1", "vp9", "vp09"];
const SAFE_CODECS = ["h264", "avc1"];

function codecBadge(codec: string) {
  const base = "text-2xs px-2.5 py-1 rounded-full font-semibold";
  if (SAFE_CODECS.includes(codec))
    return <span className={`${base} bg-[#e6f7ef] text-[#16a070]`}>H.264 ✓</span>;
  if (BROKEN_CODECS.includes(codec))
    return <span className={`${base} bg-[#e8f2eb] text-brand`}>⚠️ iPhone 不兼容</span>;
  return <span className={`${base} bg-[#eff2ef] text-ink-2`}>编码未扫描</span>;
}

// Textarea that grows to fit its content (the 中文摘要 was a fixed 80px
// box that showed a long summary as a tiny mid-scroll sliver).
function AutoTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}

export function AdminEpisodeEdit() {
  const { id: idStr } = useParams();
  const id = Number(idStr);
  const qc = useQueryClient();
  const nav = useNavigate();

  const { data: cats } = useQuery({ queryKey: ["cats"], queryFn: api.categories });
  const { data: topics } = useQuery({ queryKey: ["topics"], queryFn: api.topics });
  const { data: ep, isLoading } = useQuery({
    queryKey: ["admin-episode", id],
    queryFn: () => api.adminGetEpisode(id),
    enabled: !!id,
  });

  type Meta = {
    title: string;
    summary: string;
    youtube_url: string;
    video_url: string;
    thumbnail_url: string;
    duration_sec: number;
    accent: string;
    difficulty: number;
    category_id: number | null;
    topic: string;
    subtopic: string;
  };
  const EMPTY_META: Meta = {
    title: "",
    summary: "",
    youtube_url: "",
    video_url: "",
    thumbnail_url: "",
    duration_sec: 0,
    accent: "US",
    difficulty: 3,
    category_id: null,
    topic: "other",
    subtopic: "",
  };
  const [meta, setMeta] = useState<Meta>(EMPTY_META);
  // Snapshot of what's persisted, for dirty detection. Updated on
  // hydrate and on every successful save.
  const [savedSnapshot, setSavedSnapshot] = useState<Meta>(EMPTY_META);

  // Hydrate form on episode load
  useEffect(() => {
    if (ep) {
      const m: Meta = {
        title: ep.title,
        summary: ep.summary,
        youtube_url: ep.youtube_url,
        video_url: ep.video_url,
        thumbnail_url: ep.thumbnail_url,
        duration_sec: ep.duration_sec,
        accent: ep.accent,
        difficulty: ep.difficulty,
        category_id: ep.category_id,
        topic: ep.topic ?? "other",
        subtopic: ep.subtopic ?? "",
      };
      setMeta(m);
      setSavedSnapshot(m);
    }
  }, [ep]);

  const dirty = JSON.stringify(meta) !== JSON.stringify(savedSnapshot);

  // Warn before tab close / refresh while there are unsaved metadata
  // edits (in-app route nav is rarer here and left to the user).
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const saveMeta = useMutation({
    mutationFn: (m: Meta) => api.adminUpdateEpisode(id, m),
    onSuccess: (_d, m) => {
      setSavedSnapshot(m);
      qc.invalidateQueries({ queryKey: ["admin-episode", id] });
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
    },
  });
  const publish = useMutation({
    mutationFn: () => api.adminPublishEpisode(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-episode", id] });
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
    },
  });
  const unpublish = useMutation({
    mutationFn: () => api.adminUnpublishEpisode(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-episode", id] });
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
    },
  });
  const delEpisode = useMutation({
    mutationFn: () => api.adminDeleteEpisode(id),
    onSuccess: () => nav("/admin/episodes"),
  });
  const { data: tcStatus } = useQuery({
    queryKey: ["transcode-status"],
    queryFn: () => api.adminTranscodeStatus(),
    refetchInterval: 3000,
  });
  const tcState = tcStatus?.states?.[String(id)] || ep?.transcode_state || "";
  const prevTcRef = useRef("");
  useEffect(() => {
    if (tcState && tcState !== prevTcRef.current) {
      prevTcRef.current = tcState;
      if (tcState === "done") qc.invalidateQueries({ queryKey: ["admin-episode", id] });
    }
  }, [tcState, qc, id]);
  const transcodeOne = useMutation({
    mutationFn: () => api.adminTranscodeEpisode(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["transcode-status"] }),
    onError: (e: unknown) => alert("转码失败：" + (e instanceof Error ? e.message : String(e))),
  });

  const updateChunk = useMutation({
    mutationFn: (args: { id: number; body: Record<string, unknown> }) =>
      api.adminUpdateChunk(args.id, args.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", id] }),
  });
  const deleteChunk = useMutation({
    mutationFn: (cid: number) => api.adminDeleteChunk(cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", id] }),
  });
  const addChunk = useMutation({
    mutationFn: (body: Parameters<typeof api.adminAddChunk>[1]) => api.adminAddChunk(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", id] }),
  });

  const updateSub = useMutation({
    mutationFn: (args: { id: number; body: Record<string, unknown> }) =>
      api.adminUpdateSubtitle(args.id, args.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", id] }),
  });
  const deleteSub = useMutation({
    mutationFn: (sid: number) => api.adminDeleteSubtitle(sid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", id] }),
  });

  if (isLoading || !ep) return <div className="text-ink-2 text-sm">loading…</div>;

  return (
    <>
    <div className="max-w-5xl mx-auto">
      <div className="sticky top-0 z-20 mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-[#f5f7f4]/95 backdrop-blur px-1 py-3 border-b border-line">
        <div className="min-w-0">
          <Link to="/admin/episodes" className="text-xs text-ink-2 hover:text-ink">
            ← 返回视频管理
          </Link>
          <h2 className="text-lg font-bold mt-0.5 flex items-center gap-2 flex-wrap">
            编辑视频 #{ep.id} {statusBadge(ep.status)}
            {codecBadge(ep.video_codec)}
            {tcState === "running" && (
              <span className="text-2xs px-2.5 py-1 rounded-full font-semibold bg-[#fff2d6] text-[#b27700]">转码中…</span>
            )}
            {tcState === "queued" && (
              <span className="text-2xs px-2.5 py-1 rounded-full font-semibold bg-[#eff2ef] text-ink-2">排队中</span>
            )}
            {tcState !== "running" && tcState !== "queued" && BROKEN_CODECS.includes(ep.video_codec) && (
              <button
                onClick={() => transcodeOne.mutate()}
                disabled={transcodeOne.isPending}
                className="text-2xs px-2.5 py-1 rounded-md bg-brand text-white hover:opacity-90 disabled:opacity-50"
                title="原地转码为 H.264，文件名不变；后台单飞队列处理"
              >
                {tcState === "error" ? "转码失败 · 重试" : "转 H.264（iPhone 兼容）"}
              </button>
            )}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        {dirty && (
          <span className="text-2xs text-[#b27700] inline-flex items-center gap-1 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]" />
            未保存
          </span>
        )}
        <button
          onClick={() => saveMeta.mutate(meta)}
          disabled={!dirty || saveMeta.isPending}
          className="btn-primary disabled:opacity-40"
          title={dirty ? "保存基本信息改动" : "没有未保存的改动"}
        >
          {saveMeta.isPending ? "保存中…" : dirty ? "保存" : "已保存"}
        </button>
        {ep.status === "published" ? (
          <button
            onClick={() => unpublish.mutate()}
            disabled={unpublish.isPending}
            className="btn-ghost"
          >
            ⬇ 下架
          </button>
        ) : (
          <button
            onClick={() => publish.mutate()}
            disabled={publish.isPending}
            className="btn-primary !bg-[#16a070]"
          >
            🚀 发布
          </button>
        )}
        <Link
          to={`/learn/${ep.id}`}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost"
          title="在前台学习页打开（新标签页）"
        >
          👁 查看
        </Link>
        <details className="relative group">
          <summary className="btn-ghost list-none cursor-pointer select-none [&::-webkit-details-marker]:hidden">
            AI 重新生成 ▾
          </summary>
          <div className="absolute right-0 mt-1 w-52 bg-white border border-line rounded-lg shadow-lg p-1 z-30">
            {(
              [
                ["🔄 重新提取 Chunks", "用已有字幕重新提取 Chunks？现有 Chunks 会被替换", async () => { const r = await api.adminRegenerateChunks(id); return `✓ 已重新生成 ${r.chunks_count} 个 Chunks`; }],
                ["🔄 重新生成对话", "", async () => { await api.adminRegenerateScenario(id); return "✓ 对话场景已更新"; }],
                ["🔄 重写中文介绍", "", async () => { await api.adminRegenerateSummaryZh(id); return "✓ 中文介绍已更新"; }],
                ["🔄 Lesson Brief", "重新生成 Lesson Brief？现有内容会被替换", async () => { await api.adminRegenerateLessonBrief(id); return "✓ Lesson Brief 已更新"; }],
                ["🔄 重译字幕", "重译当前集所有字幕的中文？所有 text_zh 会被覆盖（不影响英文）", async () => { const r = await api.adminRetranslateSubtitles(id); return `✓ 已重译 ${r.updated}/${r.total} 行字幕`; }],
              ] as [string, string, () => Promise<string>][]
            ).map(([label, confirmMsg, run]) => (
              <button
                key={label}
                onClick={async (e) => {
                  const d = (e.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null;
                  if (confirmMsg && !confirm(confirmMsg)) return;
                  if (d) d.open = false;
                  try {
                    const msg = await run();
                    alert(msg);
                    qc.invalidateQueries({ queryKey: ["admin-episode", id] });
                  } catch (err: unknown) {
                    alert("操作失败：" + (err instanceof Error ? err.message : String(err)));
                  }
                }}
                className="w-full text-left px-3 py-2 rounded-md text-sm hover:bg-[#f0f3f0]"
              >
                {label}
              </button>
            ))}
          </div>
        </details>
        <details className="relative">
          <summary className="btn-ghost list-none cursor-pointer select-none [&::-webkit-details-marker]:hidden">
            更多 ▾
          </summary>
          <div className="absolute right-0 mt-1 w-40 bg-white border border-line rounded-lg shadow-lg p-1 z-30">
            <button
              onClick={(e) => {
                const d = (e.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null;
                if (d) d.open = false;
                if (confirm("确认删除？此操作不可恢复")) delEpisode.mutate();
              }}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-brand hover:bg-red-50"
            >
              删除视频
            </button>
          </div>
        </details>
        </div>
      </div>

      {/* ---- Section 1: Metadata ---- */}
      <section className="card p-5 mb-4">
        <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
          <i className="inline-block w-1 h-3.5 bg-brand rounded" />
          基本信息
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-xs text-ink-2 mb-1.5 block">标题</label>
            <input
              className="input"
              value={meta.title}
              onChange={(e) => setMeta({ ...meta, title: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-ink-2 mb-1.5 block">中文摘要</label>
            <AutoTextarea
              className="input min-h-[56px] leading-relaxed"
              value={meta.summary}
              onChange={(e) => setMeta({ ...meta, summary: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-ink-2 mb-1.5 block">分类</label>
            <select
              className="input"
              value={meta.category_id ?? ""}
              onChange={(e) =>
                setMeta({ ...meta, category_id: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">— 未分类 —</option>
              {cats?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-ink-2 mb-1.5 block">话题（Topic）</label>
            <select
              className="input"
              value={meta.topic}
              onChange={(e) => setMeta({ ...meta, topic: e.target.value })}
            >
              {topics?.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-ink-2 mb-1.5 block">
              子方向（Subtopic）
              <span className="text-ink-3 font-normal ml-1">· 话题内的窄聚类</span>
            </label>
            <input
              className="input"
              placeholder='例如 cooking / interview-prep / gpt-prompts'
              value={meta.subtopic}
              onChange={(e) => setMeta({ ...meta, subtopic: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-ink-2 mb-1.5 block">难度</label>
            <select
              className="input"
              value={meta.difficulty}
              onChange={(e) => setMeta({ ...meta, difficulty: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  ★{n} {["入门", "进阶", "中级", "高级", "母语"][n - 1]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-ink-2 mb-1.5 block">口音</label>
            <select
              className="input"
              value={meta.accent}
              onChange={(e) => setMeta({ ...meta, accent: e.target.value })}
            >
              {ACCENTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>

        <details className="mt-4 group">
          <summary className="text-xs text-ink-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1">
            <span className="inline-block group-open:rotate-90 transition-transform">▸</span>
            系统信息（一般不用改）
          </summary>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div>
              <label className="text-xs text-ink-2 mb-1.5 block">时长（秒）</label>
              <input
                className="input"
                type="number"
                value={meta.duration_sec}
                onChange={(e) => setMeta({ ...meta, duration_sec: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="text-xs text-ink-2 mb-1.5 block">封面图</label>
              <input
                className="input font-mono text-xs"
                value={meta.thumbnail_url}
                onChange={(e) => setMeta({ ...meta, thumbnail_url: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-ink-2 mb-1.5 block">视频地址</label>
              <input
                className="input font-mono text-xs"
                value={meta.video_url}
                onChange={(e) => setMeta({ ...meta, video_url: e.target.value })}
                placeholder="/media/sample.mp4 或 https://…"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-ink-2 mb-1.5 block">YouTube 源链接</label>
              <input
                className="input font-mono text-xs"
                value={meta.youtube_url}
                onChange={(e) => setMeta({ ...meta, youtube_url: e.target.value })}
              />
            </div>
          </div>
        </details>
      </section>

      {/* ---- Section 2: Chunks ---- */}
      <section className="card p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <i className="inline-block w-1 h-3.5 bg-brand rounded" />
            Chunks · {ep.chunks.length}
          </h3>
          <button
            onClick={() => {
              const text = prompt("新 chunk 的英文表达：");
              if (text?.trim()) addChunk.mutate({ text: text.trim() });
            }}
            className="text-xs px-3 py-1.5 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3]"
          >
            + 添加 Chunk
          </button>
        </div>
        <div className="space-y-3">
          {ep.chunks.map((c) => (
            <ChunkEditor
              key={c.id}
              chunk={c}
              onSave={(body) => updateChunk.mutate({ id: c.id, body })}
              onDelete={() => {
                if (confirm(`删除 chunk "${c.text}"？`)) deleteChunk.mutate(c.id);
              }}
            />
          ))}
          {ep.chunks.length === 0 && (
            <div className="text-xs text-ink-2 text-center py-4">还没有 chunk</div>
          )}
        </div>
      </section>

    </div>

    {/* Subtitles break OUT of the centered max-w-5xl column: editing
        transcripts needs the full main-column width so long English
        lines aren't cramped. Capped at screen-2xl so it stays readable
        on ultra-wide displays. */}
    <div className="max-w-screen-2xl mx-auto">
      {/* ---- Section 3: Subtitles ---- */}
      <section className="card p-5 mb-4">
        <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
          <i className="inline-block w-1 h-3.5 bg-brand rounded" />
          字幕 · {ep.subtitles.length}
        </h3>
        <div className="hidden md:grid grid-cols-[2.5rem_8rem_1fr_1fr_3.5rem] gap-3 px-2 pb-2 text-2xs text-ink-3 border-b border-line">
          <span>#</span>
          <span>时间 (s)</span>
          <span>英文</span>
          <span>中文</span>
          <span></span>
        </div>
        <div className="divide-y divide-[#f3f4f8]">
          {ep.subtitles.map((s) => (
            <SubEditor
              key={s.id}
              sub={s}
              onSave={(body) => updateSub.mutate({ id: s.id, body })}
              onDelete={() => {
                if (confirm(`删除字幕 #${s.seq}？`)) deleteSub.mutate(s.id);
              }}
            />
          ))}
        </div>
      </section>
    </div>

    <div className="max-w-5xl mx-auto">
      {/* ---- Section 4: AI metadata (read-only) ---- */}
      {ep.ai_metadata && Object.keys(ep.ai_metadata).length > 0 && (
        <section className="card p-5">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
            <i className="inline-block w-1 h-3.5 bg-brand rounded" />
            AI Pipeline 元数据
          </h3>
          <pre className="text-2xs bg-[#f8faf8] p-3 rounded overflow-auto">
            {JSON.stringify(ep.ai_metadata, null, 2)}
          </pre>
        </section>
      )}
    </div>
    </>
  );
}

// ---------- Chunk inline editor ----------
function ChunkEditor({
  chunk,
  onSave,
  onDelete,
}: {
  chunk: {
    id: number; text: string; chunk_type: string;
    why_explanation: string; usage_scenario: string; difficulty: number;
  };
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(chunk.text);
  const [type, setType] = useState(chunk.chunk_type);
  const [why, setWhy] = useState(chunk.why_explanation);
  const [scenario, setScenario] = useState(chunk.usage_scenario);
  const [diff, setDiff] = useState(chunk.difficulty);
  const dirty =
    text !== chunk.text || type !== chunk.chunk_type ||
    why !== chunk.why_explanation || scenario !== chunk.usage_scenario || diff !== chunk.difficulty;

  return (
    <div className="border border-line rounded-lg p-3 bg-[#f8faf8]">
      <div className="grid grid-cols-[1fr_140px_80px_auto] gap-2 mb-2">
        <input
          className="input !py-1.5 font-semibold"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          className="input !py-1.5 text-xs"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {CHUNK_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="input !py-1.5 text-xs"
          value={diff}
          onChange={(e) => setDiff(Number(e.target.value))}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              ★{n}
            </option>
          ))}
        </select>
        <button
          onClick={onDelete}
          className="text-xs px-2 text-ink-3 hover:text-brand"
          title="删除"
        >
          ✕
        </button>
      </div>
      <textarea
        className="input !py-1.5 text-xs min-h-[50px] mb-2"
        placeholder="为什么这样说（语用解释）…"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
      />
      <input
        className="input !py-1.5 text-xs mb-2"
        placeholder="使用场景"
        value={scenario}
        onChange={(e) => setScenario(e.target.value)}
      />
      {dirty && (
        <button
          onClick={() => onSave({ text, chunk_type: type, why_explanation: why, usage_scenario: scenario, difficulty: diff })}
          className="btn-primary !py-1 !px-3 !text-xs"
        >
          保存修改
        </button>
      )}
    </div>
  );
}

// ---------- Subtitle inline editor ----------
function SubEditor({
  sub,
  onSave,
  onDelete,
}: {
  sub: { id: number; seq: number; start_ms: number; end_ms: number; text_en: string; text_zh: string };
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [en, setEn] = useState(sub.text_en);
  const [zh, setZh] = useState(sub.text_zh);
  const [startS, setStartS] = useState((sub.start_ms / 1000).toFixed(2));
  const [endS, setEndS] = useState((sub.end_ms / 1000).toFixed(2));
  const startMs = Math.round(parseFloat(startS) * 1000);
  const endMs = Math.round(parseFloat(endS) * 1000);
  const timeValid =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const dirty =
    en !== sub.text_en ||
    zh !== sub.text_zh ||
    startMs !== sub.start_ms ||
    endMs !== sub.end_ms;

  const taCls =
    "w-full bg-transparent border border-line/60 rounded px-2 py-1.5 leading-[1.5] resize-none focus:bg-[#f2f8f4] focus:border-brand/40 outline-none overflow-hidden";

  return (
    <div className="py-3 hover:bg-[#f8faf8] grid gap-2 md:grid-cols-[2.5rem_8rem_1fr_1fr_3.5rem] md:gap-3 md:items-start md:px-2">
      <div className="text-ink-3 text-xs md:pt-1.5">#{sub.seq}</div>
      <div className="flex items-center gap-1 md:flex-col md:items-stretch md:gap-1">
        <input
          type="number"
          step="0.01"
          value={startS}
          onChange={(e) => setStartS(e.target.value)}
          className={`w-20 md:w-full text-xs tabular-nums bg-transparent border rounded px-1.5 py-1 outline-none focus:bg-[#f2f8f4] ${
            timeValid ? "border-line/60 focus:border-brand/40" : "border-red-400"
          }`}
          title="开始时间（秒）"
        />
        <span className="text-ink-3 text-xs md:hidden">–</span>
        <input
          type="number"
          step="0.01"
          value={endS}
          onChange={(e) => setEndS(e.target.value)}
          className={`w-20 md:w-full text-xs tabular-nums bg-transparent border rounded px-1.5 py-1 outline-none focus:bg-[#f2f8f4] ${
            timeValid ? "border-line/60 focus:border-brand/40" : "border-red-400"
          }`}
          title="结束时间（秒）"
        />
      </div>
      <div>
        <span className="md:hidden text-2xs text-ink-3 block mb-0.5">英文</span>
        <AutoTextarea
          className={taCls}
          value={en}
          onChange={(e) => setEn(e.target.value)}
        />
      </div>
      <div>
        <span className="md:hidden text-2xs text-ink-3 block mb-0.5">中文</span>
        <AutoTextarea
          className={`${taCls} text-ink-2`}
          value={zh}
          onChange={(e) => setZh(e.target.value)}
        />
      </div>
      <div className="flex md:flex-col items-center gap-1.5 md:pt-1">
        {dirty && (
          <button
            onClick={() =>
              timeValid &&
              onSave({
                text_en: en,
                text_zh: zh,
                start_ms: startMs,
                end_ms: endMs,
              })
            }
            disabled={!timeValid}
            className="text-2xs px-2 py-1 rounded bg-ink text-white disabled:opacity-40"
            title={timeValid ? "保存" : "结束时间必须大于开始时间"}
          >
            存
          </button>
        )}
        <button
          onClick={onDelete}
          className="text-2xs px-2 py-1 rounded text-ink-3 hover:text-brand"
          title="删除这行字幕"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
