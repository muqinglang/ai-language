import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Infinity, Pencil, Plus, ShieldCheck, Trash, User } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { api, type AdminUser, currentUser } from "@/lib/api";
import { Pager } from "@/components/Pager";

const PAGE_SIZE = 50;

type Filter = "all" | "user" | "admin";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diffDays = Math.floor((now - d.getTime()) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Short calendar date, "5月10日" form, in user's local TZ. */
function fmtMonthDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** YYYY-MM-DD for native <input type=date> default value. */
function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AdminUserList() {
  const qc = useQueryClient();
  const me = currentUser();
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const [page, setPage] = useState(0);
  const { data: pageData } = useQuery({
    queryKey: ["admin-users", page],
    queryFn: () => api.adminListUsers(PAGE_SIZE, page * PAGE_SIZE),
  });
  const users = useMemo(() => pageData?.items ?? [], [pageData]);

  const filtered = useMemo(() => {
    if (filter === "all") return users;
    return users.filter((u) => u.role === filter);
  }, [users, filter]);

  const counts = useMemo(
    () => ({
      all: users.length,
      user: users.filter((u) => u.role === "user").length,
      admin: users.filter((u) => u.role === "admin").length,
    }),
    [users],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-xl font-bold mb-1">用户管理</h2>
          <p className="text-xs text-ink-3">
            小红书订单成交后，在这里用买家提供的用户名/密码开账号。
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="btn-primary inline-flex items-center gap-1.5 text-sm"
        >
          <Plus size={14} weight="bold" /> 新建账号
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        {(
          [
            { k: "all" as const, label: "全部" },
            { k: "user" as const, label: "普通用户" },
            { k: "admin" as const, label: "管理员" },
          ]
        ).map((f) => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={`chip inline-flex items-center gap-1.5 ${filter === f.k ? "chip-on" : ""}`}
          >
            {f.label}
            <span className="text-2xs opacity-70">{counts[f.k]}</span>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-3 text-2xs uppercase tracking-wider">
              <th className="py-2 px-2">用户名</th>
              <th className="py-2 px-2">邮箱</th>
              <th className="py-2 px-2">角色</th>
              <th className="py-2 px-2">有效期</th>
              <th className="py-2 px-2">备注</th>
              <th className="py-2 px-2">注册</th>
              <th className="py-2 px-2">最近活跃</th>
              <th className="py-2 px-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="border-t border-line/60 hover:bg-[#faf9f6]">
                <td className="py-2.5 px-2 font-medium">{u.username}</td>
                <td className="py-2.5 px-2 text-ink-2">{u.email}</td>
                <td className="py-2.5 px-2">
                  {u.role === "admin" ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#eaf3ec] text-brand text-2xs font-medium">
                      <ShieldCheck size={11} weight="bold" /> 管理员
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#f0f3f0] text-ink-2 text-2xs">
                      <User size={11} /> 用户
                    </span>
                  )}
                </td>
                <td className="py-2.5 px-2 align-top">
                  <ExpiryCell user={u} />
                </td>
                <td className="py-2.5 px-2 text-ink-2 max-w-[240px] truncate">
                  {u.admin_note || <span className="text-ink-3">—</span>}
                </td>
                <td className="py-2.5 px-2 text-ink-3">{fmtDate(u.created_at)}</td>
                <td className="py-2.5 px-2 text-ink-3">{fmtDate(u.last_active)}</td>
                <td className="py-2.5 px-2 text-right whitespace-nowrap">
                  <button
                    onClick={() => setEditing(u)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs text-ink-2 hover:text-ink hover:bg-[#f0f3f0] rounded"
                  >
                    <Pencil size={12} /> 编辑
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-10 text-center text-ink-3 text-sm">
                  没有用户
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager page={page} pageSize={PAGE_SIZE} total={pageData?.total ?? 0} onPage={setPage} />

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["admin-users"] });
          }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          isSelf={me?.username === editing.username}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["admin-users"] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-row expiry control: status badge + 6 quick-action buttons.
 * - Admins are exempt from expiry (backend forces null), so we just
 *   render "永久" without controls.
 * - Quick-extend buttons hit POST /admin/users/{id}/extend which
 *   anchors at max(now, current expires_at), so "+3d" works whether
 *   the trial is active or already past.
 * - "自定义" toggles a date input; on submit we PATCH expires_at.
 * - "永久" sends PATCH {clear_expiry: true} to clear the column.
 */
function ExpiryCell({ user }: { user: AdminUser }) {
  const qc = useQueryClient();
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState(toDateInputValue(user.expires_at));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  const extend = useMutation({
    mutationFn: (days: number) => api.adminExtendUser(user.id, days),
    onSuccess: invalidate,
  });

  const setPermanent = useMutation({
    mutationFn: () => api.adminPatchUser(user.id, { clear_expiry: true }),
    onSuccess: invalidate,
  });

  const setCustom = useMutation({
    mutationFn: (iso: string) => api.adminPatchUser(user.id, { expires_at: iso }),
    onSuccess: () => {
      setShowCustom(false);
      invalidate();
    },
  });

  if (user.role === "admin") {
    return (
      <div className="inline-flex items-center gap-1 text-2xs text-ink-3">
        <Infinity size={11} weight="bold" />
        <span>永久（管理员）</span>
      </div>
    );
  }

  // Status badge: 永久 / 剩 N 天 / 已过期 (red)
  let badge: React.ReactNode;
  if (!user.expires_at) {
    badge = (
      <span className="inline-flex items-center gap-1 text-2xs text-ink-3">
        <Infinity size={11} weight="bold" /> 永久
      </span>
    );
  } else {
    const ms = new Date(user.expires_at).getTime() - Date.now();
    if (ms <= 0) {
      badge = (
        <span className="inline-flex items-center gap-1 text-2xs text-red-600 font-medium">
          已过期 {fmtMonthDay(user.expires_at)}
        </span>
      );
    } else {
      const days = Math.floor(ms / 86_400_000);
      const cls = days <= 7 ? "text-[#285e48]" : "text-ink-2";
      badge = (
        <span className={`inline-flex items-center gap-1 text-2xs ${cls}`}>
          剩 {days} 天 · {fmtMonthDay(user.expires_at)}
        </span>
      );
    }
  }

  const pending = extend.isPending || setPermanent.isPending || setCustom.isPending;

  return (
    <div className="flex flex-col gap-1.5">
      {badge}
      <div className="flex flex-wrap gap-1">
        {[1, 3, 7, 30].map((d) => (
          <button
            key={d}
            onClick={() => extend.mutate(d)}
            disabled={pending}
            className="px-1.5 py-0.5 text-2xs rounded border border-line text-ink-2 hover:text-brand hover:border-[#c9dfd0] hover:bg-[#f4f9f6] transition-colors duration-150 ease-spring disabled:opacity-40"
          >
            +{d}天
          </button>
        ))}
        <button
          onClick={() => setShowCustom((v) => !v)}
          disabled={pending}
          className="px-1.5 py-0.5 text-2xs rounded border border-line text-ink-2 hover:text-brand hover:border-[#c9dfd0] transition-colors duration-150 ease-spring disabled:opacity-40"
        >
          自定义
        </button>
        <button
          onClick={() => setPermanent.mutate()}
          disabled={pending || !user.expires_at}
          className="px-1.5 py-0.5 text-2xs rounded border border-line text-ink-2 hover:text-brand hover:border-[#c9dfd0] transition-colors duration-150 ease-spring disabled:opacity-40"
        >
          设为永久
        </button>
      </div>
      {showCustom && (
        <div className="flex items-center gap-1 mt-1">
          <input
            type="date"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            className="px-1.5 py-0.5 text-2xs rounded border border-line bg-white"
          />
          <button
            onClick={() => {
              if (!customDate) return;
              // Set to end-of-day local time for the picked date so users
              // get the full day they paid for.
              const d = new Date(customDate + "T23:59:59");
              setCustom.mutate(d.toISOString());
            }}
            disabled={pending || !customDate}
            className="px-2 py-0.5 text-2xs rounded bg-brand text-white hover:bg-brand/90 transition-colors duration-150 ease-spring disabled:opacity-40"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [note, setNote] = useState("");
  // 0 = permanent (no expiry).  Other values are days from now.
  const [trialDays, setTrialDays] = useState<number>(0);
  const [err, setErr] = useState("");

  const create = useMutation({
    mutationFn: () => {
      const expires_at =
        role === "admin" || trialDays === 0
          ? null
          : new Date(Date.now() + trialDays * 86_400_000).toISOString();
      return api.adminCreateUser({
        username: username.trim(),
        password,
        email: email.trim() || undefined,
        role,
        admin_note: note.trim(),
        expires_at,
      });
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-bold mb-4">新建用户</h3>
      <div className="space-y-3">
        <Field label="用户名 *">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input"
            placeholder="买家提供的用户名"
            autoFocus
          />
        </Field>
        <Field label="密码 *">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            placeholder="买家提供的密码（至少 4 位）"
            type="text"
          />
        </Field>
        <Field label="邮箱（可选）">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            placeholder="留空自动生成 xxx@justspeak.local"
          />
        </Field>
        <Field label="角色">
          <div className="flex gap-2">
            {(["user", "admin"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`chip ${role === r ? "chip-on" : ""}`}
              >
                {r === "user" ? "普通用户" : "管理员"}
              </button>
            ))}
          </div>
        </Field>
        {role !== "admin" && (
          <Field label="有效期（试用,从今天起算）">
            <div className="flex flex-wrap gap-1.5">
              {[
                { d: 0, label: "永久" },
                { d: 1, label: "1 天" },
                { d: 3, label: "3 天" },
                { d: 7, label: "7 天" },
                { d: 30, label: "30 天" },
              ].map((p) => (
                <button
                  key={p.d}
                  type="button"
                  onClick={() => setTrialDays(p.d)}
                  className={`chip ${trialDays === p.d ? "chip-on" : ""}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="text-2xs text-ink-3 mt-1">
              永久 = 不过期。其余从创建日开始倒计时,可在列表里随时延期。
            </div>
          </Field>
        )}
        <Field label="备注（仅管理员可见）">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="input min-h-[70px]"
            placeholder="例：2026-04-20 小红书订单 / 微信收款 / 截图 xxx"
          />
        </Field>
      </div>
      {err && <div className="text-brand text-xs mt-3">{err}</div>}
      <div className="flex gap-2 mt-5">
        <button onClick={onClose} className="btn-ghost flex-1">
          取消
        </button>
        <button
          onClick={() => create.mutate()}
          disabled={!username.trim() || password.length < 4 || create.isPending}
          className="btn-primary flex-1"
        >
          {create.isPending ? "创建中…" : "创建"}
        </button>
      </div>
    </Modal>
  );
}

function EditUserModal({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<"user" | "admin">(user.role);
  const [note, setNote] = useState(user.admin_note);
  const [err, setErr] = useState("");

  const patch = useMutation({
    mutationFn: () =>
      api.adminPatchUser(user.id, {
        password: password.trim() || undefined,
        email: email !== user.email ? email : undefined,
        role,
        admin_note: note,
      }),
    onSuccess: () => onSaved(),
    onError: (e: Error) => setErr(e.message),
  });

  const del = useMutation({
    mutationFn: () => api.adminDeleteUser(user.id),
    onSuccess: () => onSaved(),
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-bold mb-1">编辑 {user.username}</h3>
      <p className="text-2xs text-ink-3 mb-4">
        用户名不可改。如需换人用同个账号，直接改密码。
      </p>
      <div className="space-y-3">
        <Field label="新密码（留空不改）">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            placeholder="至少 4 位"
            type="text"
          />
        </Field>
        <Field label="邮箱">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="角色">
          <div className="flex gap-2">
            {(["user", "admin"] as const).map((r) => (
              <button
                key={r}
                onClick={() => !isSelf && setRole(r)}
                disabled={isSelf && r !== "admin"}
                className={`chip ${role === r ? "chip-on" : ""} ${isSelf && r !== "admin" ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {r === "user" ? "普通用户" : "管理员"}
              </button>
            ))}
          </div>
          {isSelf && (
            <div className="text-2xs text-ink-3 mt-1.5">
              不能给自己降权，防止把自己锁在外面。
            </div>
          )}
        </Field>
        <Field label="备注">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="input min-h-[70px]"
          />
        </Field>
      </div>
      {err && <div className="text-brand text-xs mt-3">{err}</div>}
      <div className="flex gap-2 mt-5">
        {!isSelf && (
          <button
            onClick={() => {
              if (confirm(`删除 ${user.username}？此操作不可逆。`)) del.mutate();
            }}
            disabled={del.isPending}
            className="inline-flex items-center gap-1 px-3 py-2 text-sm text-brand hover:bg-[#eaf3ec] rounded-lg"
          >
            <Trash size={14} /> 删除
          </button>
        )}
        <div className="flex-1" />
        <button onClick={onClose} className="btn-ghost">
          取消
        </button>
        <button
          onClick={() => patch.mutate()}
          disabled={patch.isPending}
          className="btn-primary"
        >
          {patch.isPending ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-2xs text-ink-2 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/35 z-50 grid place-items-center p-4 md:p-6"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
