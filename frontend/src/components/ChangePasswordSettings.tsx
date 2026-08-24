import { Check, Lock, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { api, errorDetail } from "@/lib/api";

/**
 * 修改密码 —— 全站唯一的改密入口（我的 → 设置）。
 *
 * 后端 POST /auth/change-password 会校验「当前密码」再改，所以光有一个被盗
 * 的会话改不了密码。Google 登录的账号没有密码，后端会返回提示。
 */
export function ChangePasswordSettings() {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const submit = async () => {
    setError("");
    setOk(false);
    if (newPw.length < 6) {
      setError("新密码至少 6 位");
      return;
    }
    if (newPw !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(oldPw, newPw);
      setOk(true);
      setOldPw("");
      setNewPw("");
      setConfirm("");
    } catch (e) {
      setError(errorDetail(e, "修改失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4 md:p-5 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Lock size={14} className="text-ink-2" />
        <h3 className="text-base font-semibold">修改密码</h3>
      </div>

      {ok && (
        <div className="flex items-center gap-1.5 mb-3 px-3 py-2 rounded-lg bg-[#f0fdf4] border border-[#bbf7d0] text-xs text-[#166534]">
          <Check size={13} weight="bold" /> 密码已修改，下次登录用新密码
        </div>
      )}
      {error && (
        <div className="flex items-start gap-1.5 mb-3 px-3 py-2 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-xs text-[#b91c1c]">
          <WarningCircle size={13} weight="bold" className="shrink-0 mt-px" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      <div className="space-y-3 max-w-sm">
        <label className="block">
          <span className="text-2xs text-ink-3 font-medium">当前密码</span>
          <input
            className="input mt-1"
            type="password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="block">
          <span className="text-2xs text-ink-3 font-medium">新密码（至少 6 位）</span>
          <input
            className="input mt-1"
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="block">
          <span className="text-2xs text-ink-3 font-medium">确认新密码</span>
          <input
            className="input mt-1"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>
        <button
          className="btn-primary"
          onClick={() => void submit()}
          disabled={busy || !oldPw || !newPw || !confirm}
        >
          {busy ? "修改中..." : "修改密码"}
        </button>
      </div>
    </div>
  );
}
