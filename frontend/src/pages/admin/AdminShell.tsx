import { Link, Outlet, useLocation } from "react-router-dom";
import { LogoMark } from "@/components/Logo";
import { clearSession, currentUser } from "@/lib/api";

const ITEMS = [
  { to: "/admin", label: "Dashboard", group: "内容" },
  { to: "/admin/import", label: "YouTube 导入", group: "内容" },
  { to: "/admin/review-queue", label: "📥 待审 Queue", group: "内容" },
  { to: "/admin/schedules", label: "⏰ 定时导入", group: "内容" },
  { to: "/admin/episodes", label: "视频管理", group: "内容" },
  { to: "/admin/collections", label: "📚 合集管理", group: "内容" },
  { to: "/admin/users", label: "用户管理", group: "用户" },
];

export function AdminShell() {
  const loc = useLocation();
  const u = currentUser();
  return (
    <div className="min-h-screen p-6 grid grid-cols-[220px_1fr] gap-4 bg-[#f5f7f4]">
      <aside className="rounded-2xl bg-[#0e1119] text-gray-300 p-5">
        <div className="flex items-center gap-2.5 mb-5 pl-2">
          <LogoMark size={28} fill="#fff" />
          <div className="text-white">
            <span className="font-light opacity-70">just</span>
            <span className="font-extrabold">Speak</span>
            <span className="text-gray-500 text-xs ml-1.5">Admin</span>
          </div>
        </div>
        <div className="text-2xs uppercase tracking-[1.2px] text-gray-500 px-3 pt-3 pb-1 font-bold">
          内容
        </div>
        <nav className="flex flex-col gap-0.5">
          {ITEMS.map((i) => {
            // /admin matches exactly, all other items use prefix match so children stay highlighted
            const on = i.to === "/admin"
              ? loc.pathname === "/admin"
              : loc.pathname === i.to || loc.pathname.startsWith(i.to + "/");
            return (
              <Link
                key={i.to}
                to={i.to}
                className={`px-3 py-2.5 rounded-lg text-sm flex items-center gap-2.5 ${
                  on ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-brand" : "bg-gray-600"}`} />
                {i.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-6 pt-4 border-t border-white/10 text-xs text-gray-500">
          <div>登录为 {u?.username}</div>
          <button
            onClick={() => {
              clearSession();
              location.href = "/login";
            }}
            className="text-gray-400 hover:text-white mt-1"
          >
            登出
          </button>
        </div>
      </aside>
      <main className="card p-7">
        <Outlet />
      </main>
    </div>
  );
}
