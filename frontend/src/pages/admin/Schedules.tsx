import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ImportScheduleOut, type ImportScheduleCreate } from "@/lib/api";

/**
 * Req 5 admin UI · 定时导入
 * One row = one (creator, cron) rule. APScheduler running in the api process
 * fires each rule on its cron; the run picks new (un-imported) videos from
 * the channel and runs the normal import pipeline. Admin reviews next morning
 * via /admin/review-queue.
 */
export function AdminSchedules() {
  const qc = useQueryClient();
  const { data: schedules } = useQuery({
    queryKey: ["admin-schedules"],
    queryFn: api.adminListSchedules,
    refetchInterval: 15_000,
  });
  const { data: speakers } = useQuery({
    queryKey: ["admin-speakers-all"],
    queryFn: api.adminListSpeakersAll,
  });
  const [editing, setEditing] = useState<ImportScheduleOut | null>(null);
  const [creating, setCreating] = useState(false);

  const delMut = useMutation({
    mutationFn: (id: number) => api.adminDeleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-schedules"] }),
  });
  const runNowMut = useMutation({
    mutationFn: (id: number) => api.adminRunScheduleNow(id),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.adminUpdateSchedule(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-schedules"] }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold">定时导入规则</h2>
        <button
          onClick={() => setCreating(true)}
          className="btn-primary"
        >
          + 新建规则
        </button>
      </div>

      <div className="card p-5">
        {!schedules?.length ? (
          <div className="text-sm text-ink-2 py-8 text-center">
            还没有定时规则。<button onClick={() => setCreating(true)} className="text-brand underline">建一个</button>，让系统每天自动给你导某个博主的新视频。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ink-2 border-b border-line text-left">
                  <th className="py-2 px-2">名称</th>
                  <th className="py-2 px-2">博主</th>
                  <th className="py-2 px-2">调度（UTC）</th>
                  <th className="py-2 px-2">每次/段数</th>
                  <th className="py-2 px-2">上次结果</th>
                  <th className="py-2 px-2">启用</th>
                  <th className="py-2 px-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <ScheduleRow
                    key={s.id}
                    s={s}
                    onEdit={() => setEditing(s)}
                    onDelete={() => {
                      if (confirm(`确认删除规则「${s.name}」？`)) delMut.mutate(s.id);
                    }}
                    onRunNow={() => {
                      if (confirm(`立即跑一次「${s.name}」？将拉取并导入新视频。`)) {
                        runNowMut.mutate(s.id);
                      }
                    }}
                    onToggle={() => toggleMut.mutate({ id: s.id, enabled: !s.enabled })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(creating || editing) && (
        <ScheduleForm
          initial={editing}
          speakers={speakers ?? []}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ScheduleRow({
  s, onEdit, onDelete, onRunNow, onToggle,
}: {
  s: ImportScheduleOut;
  onEdit: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onToggle: () => void;
}) {
  const summary = s.last_run_summary as { ok?: number; fail?: number; note?: string };
  const lastRunBadge = (() => {
    if (!s.last_run_at) return <span className="text-ink-3">未跑过</span>;
    const ok = summary.ok ?? 0;
    const fail = summary.fail ?? 0;
    const cls = fail > 0 ? "bg-red-50 text-red-700" : ok > 0 ? "bg-emerald-50 text-emerald-700" : "bg-[#eff2ef] text-ink-2";
    const text = summary.note ?? `${ok} 成功 / ${fail} 失败`;
    return (
      <span className={`px-2 py-0.5 rounded-full text-2xs font-semibold ${cls}`}>
        {text}
      </span>
    );
  })();
  return (
    <tr className="border-b border-line/50 hover:bg-[#f5f7f4]">
      <td className="py-2 px-2 font-medium text-ink">{s.name}</td>
      <td className="py-2 px-2">{s.speaker_name ?? `#${s.speaker_id}`}</td>
      <td className="py-2 px-2 font-mono text-2xs">{s.cron_expression}</td>
      <td className="py-2 px-2">{s.videos_per_run} 个 / {s.segments_per_video} 段</td>
      <td className="py-2 px-2">{lastRunBadge}</td>
      <td className="py-2 px-2">
        <button
          onClick={onToggle}
          className={`px-2 py-0.5 rounded-full text-2xs font-semibold ${
            s.enabled ? "bg-emerald-50 text-emerald-700" : "bg-[#eff2ef] text-ink-3"
          }`}
        >
          {s.enabled ? "已启用" : "已暂停"}
        </button>
      </td>
      <td className="py-2 px-2 flex gap-1">
        <button onClick={onRunNow} className="px-2 py-0.5 rounded bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2">
          ▶ 立即
        </button>
        <button onClick={onEdit} className="px-2 py-0.5 rounded bg-[#f0f3f0] hover:bg-[#dce4dc] text-ink-2">
          编辑
        </button>
        <button
          onClick={onDelete}
          className="px-2 py-0.5 rounded bg-[#f0f3f0] hover:bg-red-50 text-ink-2 hover:text-red-600"
        >
          删除
        </button>
      </td>
    </tr>
  );
}

function ScheduleForm({
  initial, speakers, onClose,
}: {
  initial: ImportScheduleOut | null;
  speakers: Array<{ id: number; name: string; handle: string }>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState<ImportScheduleCreate>({
    name: initial?.name ?? "",
    speaker_id: initial?.speaker_id ?? speakers[0]?.id ?? 0,
    cron_expression: initial?.cron_expression ?? "0 14 * * *",
    videos_per_run: initial?.videos_per_run ?? 1,
    segments_per_video: initial?.segments_per_video ?? 2,
    max_video_duration_sec: initial?.max_video_duration_sec ?? 1800,
    enabled: initial?.enabled ?? true,
  });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.adminCreateSchedule(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-schedules"] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: () => api.adminUpdateSchedule(initial!.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-schedules"] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  // Convert minutes-of-day in Asia/Shanghai → UTC cron, since the user
  // thinks in local time (晚上 22:00). Default 14 UTC = 22:00 CST.
  const cronFromLocal = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const utcH = (h - 8 + 24) % 24;
    return `${m} ${utcH} * * *`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="card max-w-xl w-full p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold">{initial ? `编辑规则 #${initial.id}` : "新建定时规则"}</h3>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">✕</button>
        </div>
        <div className="space-y-3">
          <Field label="规则名称">
            <input
              className="input text-sm"
              value={body.name}
              onChange={(e) => setBody({ ...body, name: e.target.value })}
              placeholder="科技博主轮巡"
            />
          </Field>
          <Field label="博主（必须先去 /admin/episodes 导一次该博主的视频，让 Speaker 进库）">
            <select
              className="input text-sm"
              value={body.speaker_id}
              onChange={(e) => setBody({ ...body, speaker_id: Number(e.target.value) })}
            >
              {speakers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（@{s.handle}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="时间（每天，本地 Asia/Shanghai 时间）">
            <select
              className="input text-sm"
              onChange={(e) =>
                setBody({ ...body, cron_expression: cronFromLocal(Number(e.target.value)) })
              }
              defaultValue=""
            >
              <option value="" disabled>从下面选一个，会自动转成 UTC cron</option>
              <option value={20 * 60}>每天 20:00</option>
              <option value={21 * 60}>每天 21:00</option>
              <option value={22 * 60}>每天 22:00（推荐：临睡前能扫一眼有没有炸）</option>
              <option value={23 * 60}>每天 23:00</option>
              <option value={2 * 60}>每天 02:00（凌晨）</option>
            </select>
          </Field>
          <Field label="或者手填 UTC cron（5 字段）">
            <input
              className="input text-sm font-mono"
              value={body.cron_expression}
              onChange={(e) => setBody({ ...body, cron_expression: e.target.value })}
              placeholder="0 14 * * *"
            />
            <div className="text-2xs text-ink-3 mt-1">
              当前：<code>{body.cron_expression}</code>（UTC）
            </div>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="每次拉几个">
              <input
                className="input text-sm"
                type="number"
                min={1}
                max={10}
                value={body.videos_per_run ?? 1}
                onChange={(e) => setBody({ ...body, videos_per_run: Number(e.target.value) })}
              />
            </Field>
            <Field label="每个切几段">
              <input
                className="input text-sm"
                type="number"
                min={1}
                max={5}
                value={body.segments_per_video ?? 2}
                onChange={(e) => setBody({ ...body, segments_per_video: Number(e.target.value) })}
              />
            </Field>
            <Field label="跳过时长 ≥（秒）">
              <input
                className="input text-sm"
                type="number"
                min={0}
                value={body.max_video_duration_sec ?? 1800}
                onChange={(e) => setBody({ ...body, max_video_duration_sec: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="text-2xs text-ink-2 leading-relaxed bg-[#f7faf7] p-3 rounded-lg">
            <b>规则说明：</b>每次跑会拉该博主最近 100 个视频的元数据，<b>跳过已导入的</b>，按上传时间从新到旧选 {body.videos_per_run ?? 1} 个，每个切 {body.segments_per_video ?? 2} 段。视频时长超过{" "}
            {Math.round((body.max_video_duration_sec ?? 1800) / 60)} 分钟会跳过。
          </div>
          <Field label="">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={body.enabled ?? true}
                onChange={(e) => setBody({ ...body, enabled: e.target.checked })}
              />
              启用（创建后立即按 cron 调度；不启用则保存但不跑）
            </label>
          </Field>
          {error && (
            <div className="text-xs text-red-600 bg-red-50 p-2 rounded">{error}</div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="btn">取消</button>
          <button
            onClick={() => (initial ? update.mutate() : create.mutate())}
            disabled={create.isPending || update.isPending}
            className="btn-primary"
          >
            {initial ? "保存" : "保存并启用"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <label className="text-xs text-ink-2 mb-1 block">{label}</label>}
      {children}
    </div>
  );
}
