import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { VjsPlayer } from "@/components/VjsPlayer";

/**
 * Req 3: post-import inline review/publish.
 *
 * Renders right under the "③ Pipeline 进度" card on the import page once a
 * task lands at status=reviewing. Admin can play the clip, scan generated
 * subs/chunks/words/scenario, edit title+summary inline, and publish or
 * reject — all without ever navigating away. For multi-segment imports,
 * the parent stacks one ReviewPane per produced episode.
 *
 * Mirrors the relevant subset of /admin/episodes/{id}/edit, optimised for
 * post-import speed-of-decision rather than thorough editing. Anything
 * deeper goes through the "✏️ 进高级编辑" link to the full edit page.
 */

const TOPIC_NAME: Record<string, string> = {
  ai: "AI 与大模型", tech: "科技编程", business: "商业创业",
  investing: "投资理财", career: "职场成长", lifestyle: "日常生活",
  travel: "旅行文化", food: "美食烹饪", health: "健康健身",
  psychology: "心理成长", science: "科学科普", education: "教育学习",
  entertainment: "影视娱乐", fashion: "时尚美妆", sports: "体育运动",
  outdoor: "户外探险", reading: "阅读书评", other: "其他",
};

const CHUNK_COLOR: Record<string, string> = {
  idiomatic: "bg-amber-50 text-amber-900 border-amber-200",
  collocation: "bg-sky-50 text-sky-900 border-sky-200",
  discourse: "bg-emerald-50 text-emerald-900 border-emerald-200",
  functional: "bg-violet-50 text-violet-900 border-violet-200",
  cultural: "bg-amber-50 text-amber-900 border-amber-200",
};

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

type Tab = "subs" | "chunks" | "words" | "scenario";

export function ReviewPane({ episodeId }: { episodeId: number }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: ep, isLoading } = useQuery({
    queryKey: ["admin-episode", episodeId],
    queryFn: () => api.adminGetEpisode(episodeId),
    enabled: !!episodeId,
  });
  const { data: words } = useQuery({
    queryKey: ["episode-words", episodeId],
    queryFn: () => api.episodeFeaturedWords(episodeId),
    enabled: !!episodeId,
  });

  const [tab, setTab] = useState<Tab>("subs");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    if (ep) {
      setTitle(ep.title);
      setSummary(ep.summary);
    }
  }, [ep]);

  const saveMeta = useMutation({
    mutationFn: () => api.adminUpdateEpisode(episodeId, { title, summary }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", episodeId] }),
  });
  const publish = useMutation({
    mutationFn: () => api.adminPublishEpisode(episodeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-episode", episodeId] });
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
    },
  });
  const unpublish = useMutation({
    mutationFn: () => api.adminUnpublishEpisode(episodeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", episodeId] }),
  });
  const reject = useMutation({
    mutationFn: () => api.adminDeleteEpisode(episodeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-episode", episodeId] });
      qc.invalidateQueries({ queryKey: ["admin-episodes"] });
      qc.invalidateQueries({ queryKey: ["admin-imports"] });
    },
  });
  const regenChunks = useMutation({
    mutationFn: () => api.adminRegenerateChunks(episodeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", episodeId] }),
  });
  const regenScenario = useMutation({
    mutationFn: () => api.adminRegenerateScenario(episodeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", episodeId] }),
  });
  const regenSummaryZh = useMutation({
    mutationFn: () => api.adminRegenerateSummaryZh(episodeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-episode", episodeId] }),
  });

  if (isLoading || !ep) {
    return <div className="card p-5 text-sm text-ink-2">加载 episode #{episodeId}…</div>;
  }

  const statusBadge = (() => {
    if (ep.status === "published") return <span className="badge text-2xs px-2 py-0.5 rounded-full bg-[#e6f7ef] text-[#16a070] font-semibold">已发布</span>;
    if (ep.status === "reviewing") return <span className="text-2xs px-2 py-0.5 rounded-full bg-[#fff2d6] text-[#b27700] font-semibold">草稿 · 等待发布</span>;
    if (ep.status === "draft") return <span className="text-2xs px-2 py-0.5 rounded-full bg-[#eff2ef] text-ink-2 font-semibold">草稿</span>;
    return <span className="text-2xs px-2 py-0.5 rounded-full bg-[#eff2ef] text-ink-2 font-semibold">{ep.status}</span>;
  })();

  const segment = (ep.ai_metadata as { segment?: { source_start?: number; source_end?: number; full_duration?: number } } | null)?.segment;
  const summaryZh = (ep.ai_metadata as { summary_zh?: string } | null)?.summary_zh ?? "";

  return (
    <div className="card p-5 mt-4 border-2 border-brand/40 bg-[#fffaf6]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <i className="inline-block w-1 h-3.5 bg-brand rounded" />
          ④ 审核 &amp; 发布 · episode #{episodeId}
        </h3>
        {statusBadge}
      </div>

      {/* Layout: video + meta on left, tabs on right */}
      <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr] gap-4">
        <div>
          {ep.video_url ? (
            <VjsPlayer
              src={ep.video_url}
              poster={ep.thumbnail_url}
              vttUrl={`/api/episodes/${episodeId}/subtitles.vtt`}
            />
          ) : (
            <div className="aspect-video bg-[#0b0d17] rounded-xl grid place-items-center text-ink-3 text-xs">
              视频文件未提供
            </div>
          )}
          <div className="text-2xs text-ink-3 mt-1.5">
            {segment?.source_start != null && segment?.source_end != null && (
              <>
                片段 0:00–{fmtTime(ep.duration_sec * 1000)} · 来自原片 {fmtTime((segment.source_start ?? 0) * 1000)}{" "}
                / 全长 {fmtTime((segment.full_duration ?? 0) * 1000)}
              </>
            )}
          </div>
          <div className="mt-3">
            <label className="text-2xs text-ink-2 mb-1 block">片段标题</label>
            <input
              className="input text-sm"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title !== ep.title && saveMeta.mutate()}
            />
          </div>
          <div className="mt-2">
            <label className="text-2xs text-ink-2 mb-1 block">介绍（英文摘要）</label>
            <textarea
              className="input text-sm"
              rows={2}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onBlur={() => summary !== ep.summary && saveMeta.mutate()}
            />
          </div>
          {summaryZh && (
            <div className="mt-2 text-2xs text-ink-2 leading-relaxed">
              <span className="text-ink-3">中文摘要：</span>
              {summaryZh}
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-2xs">
            <Meta label="分类" value={ep.category_name ?? "—"} />
            <Meta label="话题" value={TOPIC_NAME[ep.topic] ?? ep.topic} />
            <Meta label="难度" value={`★${ep.difficulty}`} />
            <Meta label="口音" value={ep.accent} />
          </div>
        </div>

        {/* Right side: tabs */}
        <div className="md:min-h-[420px] flex flex-col">
          <div className="flex gap-1 mb-2 border-b border-line">
            <TabButton active={tab === "subs"} onClick={() => setTab("subs")}>
              字幕 ({ep.subtitles.length})
            </TabButton>
            <TabButton active={tab === "chunks"} onClick={() => setTab("chunks")}>
              Chunks ({ep.chunks.length})
            </TabButton>
            <TabButton active={tab === "words"} onClick={() => setTab("words")}>
              推荐词 ({words?.length ?? 0})
            </TabButton>
            <TabButton active={tab === "scenario"} onClick={() => setTab("scenario")}>
              对话场景
            </TabButton>
          </div>

          <div className="flex-1 overflow-y-auto pr-1 max-h-[420px]">
            {tab === "subs" && <SubList subs={ep.subtitles} />}
            {tab === "chunks" && <ChunksList chunks={ep.chunks} />}
            {tab === "words" && <WordsList words={words ?? []} />}
            {tab === "scenario" && (
              <ScenarioCard
                ai_metadata={ep.ai_metadata as { scenario?: string }}
                onRegen={() => regenScenario.mutate()}
                regenerating={regenScenario.isPending}
              />
            )}
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="border-t border-line mt-4 pt-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => regenChunks.mutate()}
            disabled={regenChunks.isPending}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2"
            title="让 LLM 重新提取 Chunks"
          >
            {regenChunks.isPending ? "提取中…" : "🔄 重提取 Chunks"}
          </button>
          <button
            onClick={() => regenScenario.mutate()}
            disabled={regenScenario.isPending}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2"
          >
            {regenScenario.isPending ? "生成中…" : "🔄 重生成对话"}
          </button>
          <button
            onClick={() => regenSummaryZh.mutate()}
            disabled={regenSummaryZh.isPending}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2"
          >
            {regenSummaryZh.isPending ? "翻译中…" : "🔄 翻译中文介绍"}
          </button>
          <Link
            to={`/admin/episodes/${episodeId}`}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2 inline-flex items-center"
          >
            ✏️ 高级编辑
          </Link>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => {
              if (!confirm(`确认拒绝这个 episode？这会永久删除 episode #${episodeId} 和它的所有字幕/chunks。`)) return;
              reject.mutate(undefined, {
                onSuccess: () => nav("/admin/import"),
              });
            }}
            disabled={reject.isPending}
            className="text-xs px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-medium"
          >
            🗑 拒绝（删除）
          </button>
          {ep.status === "published" ? (
            <button
              onClick={() => unpublish.mutate()}
              disabled={unpublish.isPending}
              className="text-xs px-3 py-1.5 rounded-lg bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink"
            >
              {unpublish.isPending ? "下架中…" : "⬇ 下架"}
            </button>
          ) : (
            <button
              onClick={() => publish.mutate()}
              disabled={publish.isPending}
              className="text-xs px-4 py-1.5 rounded-lg bg-brand hover:bg-brand/90 text-white font-semibold"
            >
              {publish.isPending ? "发布中…" : "✓ 发布到前台"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-ink-3 text-2xs">{label}</div>
      <div className="text-ink font-medium">{value}</div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1.5 -mb-px border-b-2 ${
        active ? "border-brand text-brand font-semibold" : "border-transparent text-ink-2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function SubList({ subs }: { subs: Array<{ seq: number; start_ms: number; end_ms: number; text_en: string; text_zh: string }> }) {
  if (!subs.length) return <div className="text-xs text-ink-3 p-3">没有字幕</div>;
  return (
    <div className="text-xs space-y-1">
      {subs.map((s) => (
        <div key={s.seq} className="grid grid-cols-[60px_1fr] gap-2 py-1.5 border-b border-line/50">
          <span className="text-ink-3 font-mono text-2xs">
            {fmtTime(s.start_ms)}–{fmtTime(s.end_ms)}
          </span>
          <div>
            <div className="text-ink">{s.text_en}</div>
            {s.text_zh && <div className="text-ink-2 text-2xs">{s.text_zh}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChunksList({ chunks }: {
  chunks: Array<{
    id: number; text: string; chunk_type: string;
    why_explanation: string; usage_scenario: string;
  }>;
}) {
  if (!chunks.length) return <div className="text-xs text-ink-3 p-3">没有 chunks</div>;
  return (
    <div className="space-y-2">
      {chunks.map((c) => (
        <div
          key={c.id}
          className={`text-xs p-2.5 rounded-lg border ${CHUNK_COLOR[c.chunk_type] ?? "bg-[#f7faf7] border-line"}`}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-sm">{c.text}</span>
            <span className="text-2xs opacity-70">{c.chunk_type}</span>
          </div>
          {c.why_explanation && (
            <div className="mt-1 text-2xs leading-relaxed">{c.why_explanation}</div>
          )}
          {c.usage_scenario && (
            <div className="mt-1 text-2xs opacity-70">场景：{c.usage_scenario}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function WordsList({ words }: {
  words: Array<{ word: string; ipa?: string | null; definition_en?: string | null; definition_zh?: string | null }>;
}) {
  if (!words.length) return <div className="text-xs text-ink-3 p-3">没有推荐词</div>;
  return (
    <div className="space-y-1.5">
      {words.map((w, i) => (
        <div key={i} className="text-xs p-2 rounded border border-line bg-white">
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-sm">{w.word}</span>
            {w.ipa && <span className="text-2xs text-ink-3 font-mono">/{w.ipa}/</span>}
          </div>
          {w.definition_zh && <div className="text-2xs text-ink-2 mt-0.5">{w.definition_zh}</div>}
          {w.definition_en && <div className="text-2xs text-ink-3 mt-0.5">{w.definition_en}</div>}
        </div>
      ))}
    </div>
  );
}

function ScenarioCard({
  ai_metadata, onRegen, regenerating,
}: { ai_metadata: { scenario?: string }; onRegen: () => void; regenerating: boolean }) {
  const scenario = ai_metadata?.scenario ?? "";
  if (!scenario) {
    return (
      <div className="text-xs text-ink-3 p-3 text-center">
        没有对话场景。
        <button onClick={onRegen} disabled={regenerating} className="ml-2 underline text-brand">
          {regenerating ? "生成中…" : "立即生成"}
        </button>
      </div>
    );
  }
  return (
    <div className="text-xs p-3 rounded-lg bg-[#f7faf7] leading-relaxed">{scenario}</div>
  );
}
