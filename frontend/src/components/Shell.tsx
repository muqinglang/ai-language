import { ArrowsClockwise, Books, Clock, Compass, GearSix, House, MagnifyingGlass, SignOut, Star, User } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { clearSession, currentUser } from "@/lib/api";
import { useIsHandheld } from "@/lib/device";
import { LogoMark } from "./Logo";

type NavItem = { to: string; label: string; Icon: PhosphorIcon };
const NAV: NavItem[] = [
  { to: "/", label: "Home", Icon: House },
  { to: "/catalog", label: "Discover", Icon: Compass },
  { to: "/library", label: "Library", Icon: Books },
  { to: "/review", label: "Review", Icon: ArrowsClockwise },
  { to: "/favorites", label: "Favorites", Icon: Star },
  { to: "/me", label: "Me", Icon: User },
];

/**
 * Returns days remaining (rounded down) until the user's trial expiry,
 * or null when no banner is warranted (no expiry / already past / >7d
 * out / admin role).  Used by the trial-warning banner so it only
 * appears in the last week of a trial.
 */
function trialDaysLeft(user: ReturnType<typeof currentUser>): number | null {
  if (!user || user.role === "admin" || !user.expires_at) return null;
  const ms = new Date(user.expires_at).getTime() - Date.now();
  if (ms <= 0) return null; // already expired — handled by 403 bounce
  const days = Math.floor(ms / 86_400_000);
  return days <= 7 ? days : null;
}

export function Shell({
  children,
  searchPlaceholder,
  hideSearch,
  hideMobileTopBar,
}: {
  children: React.ReactNode;
  searchPlaceholder?: string;
  hideSearch?: boolean;
  // Drop the mobile compact top bar (logo + search + admin + logout) to
  // reclaim ~48px of vertical space. Used by /learn/:id, where the focus
  // is the video + subtitles and the bottom tab bar already covers
  // navigation. Desktop is unaffected (the bar is md:hidden anyway).
  hideMobileTopBar?: boolean;
}) {
  const loc = useLocation();
  const nav = useNavigate();
  const user = currentUser();
  const [q, setQ] = useState("");
  // Unconditional — putting the hook behind `role === "admin" &&` would
  // skip it for learners and blow up with "rendered fewer hooks than
  // expected" the first time the same mount sees a different role.
  const handheld = useIsHandheld();
  // The admin console is desktop-only (RequireAuth bounces handhelds back
  // to "/"), so don't offer a link that would immediately bounce.
  const showAdminLink = user?.role === "admin" && !handheld;

  const isActive = (to: string) =>
    loc.pathname === to || (to !== "/" && loc.pathname.startsWith(to));

  const logout = () => {
    clearSession();
    nav("/login");
  };

  const daysLeft = trialDaysLeft(user);

  return (
    // min-h-dvh + h-dvh (instead of -screen / 100vh): iOS Safari resolves
    // 100vh to the URL-bar-hidden height — when the URL bar is showing,
    // a 100vh container is taller than the visible viewport, which makes
    // the body scrollable behind the inner pages.  Subtitle auto-scroll
    // on /learn/:id then propagates to the body and the video gets
    // pushed off the top of the screen as the user listens.  100dvh is
    // dynamic and tracks the URL bar state, so the container is exactly
    // the visible height and the body never scrolls.  Desktop browsers
    // have no collapsing chrome, dvh==vh, no behavior change.
    <div className="min-h-dvh md:grid md:grid-cols-[80px_1fr]">
      {/* Desktop sidebar — hidden on phone */}
      <aside className="hidden md:flex sticky top-0 h-dvh border-r border-line bg-white flex-col items-center py-5 gap-1">
        <Link to="/" className="mb-4">
          <LogoMark size={36} />
        </Link>
        {NAV.map(({ to, label, Icon }) => {
          const on = isActive(to);
          return (
            <Link
              key={to}
              to={to}
              className={`w-14 py-2.5 rounded-xl flex flex-col items-center gap-1 text-2xs font-medium transition-colors duration-150 ease-spring ${
                on ? "bg-[#eaf3ec] text-brand" : "text-ink-3 hover:text-ink hover:bg-[#f4f7f4]"
              }`}
            >
              {/* 选中态用实心字重，而不是靠颜色单独扛。这是换 Phosphor
                  的主要收益：以前只能把 strokeWidth 从 1.75 加到 2，差别
                  肉眼几乎看不出来。 */}
              <Icon size={20} weight={on ? "fill" : "regular"} />
              {label}
            </Link>
          );
        })}
        {/* Footer — Admin (admin only) stacked above Sign out, anchored to bottom */}
        <div className="mt-auto flex flex-col items-center gap-1 w-full">
          {showAdminLink && (
            <Link
              to="/admin"
              title="Admin"
              className={`w-14 py-2.5 rounded-xl flex flex-col items-center gap-1 text-2xs font-medium ${
                isActive("/admin")
                  ? "bg-[#eaf3ec] text-brand"
                  : "text-ink-3 hover:text-ink hover:bg-[#f4f7f4]"
              }`}
            >
              <GearSix size={20} />
              Admin
            </Link>
          )}
          {user && (
            <button
              onClick={logout}
              title={`Sign out ${user.username}`}
              className="w-14 py-2.5 rounded-xl flex flex-col items-center gap-1 text-2xs font-medium text-ink-3 hover:text-ink hover:bg-[#f4f7f4]"
            >
              <SignOut size={20} />
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main className="relative px-4 pt-3 pb-[calc(80px+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-20">
        {/* Trial-expiry warning — only shows in the last 7 days.  Same
            tone (peach) as the brand-orange CTAs so it reads as a soft
            nudge, not an alarm.  Renders above all other content. */}
        {daysLeft !== null && (
          <div className="mb-3 rounded-xl border border-[#c9dfd0] bg-[#f4f9f6] px-3 py-2 flex items-start gap-2 text-xs text-[#285e48]">
            <Clock size={14} weight="bold" className="shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">
                {daysLeft === 0 ? "试用今天到期" : `试用还剩 ${daysLeft} 天`}
              </span>
              <span className="text-[#a16207] ml-1.5">联系管理员延期,数据不会丢</span>
            </div>
          </div>
        )}

        {/* Mobile-only compact top bar: logo + search icon (always
            present, navigates to /search) + (admin icon) + logout icon.
            Search needs a mobile entry point on every page, not just
            ones that opt out of `hideSearch` — Home (hideSearch=true)
            previously had no way to start a search on mobile at all. */}
        {!hideMobileTopBar && (
        <div className="md:hidden flex items-center justify-between mb-3">
          <Link to="/" className="flex items-center gap-2">
            <LogoMark size={28} />
            <span className="font-extrabold text-base tracking-tight">justSpeak</span>
          </Link>
          <div className="flex items-center gap-1">
            <Link
              to="/search"
              className="w-9 h-9 rounded-full flex items-center justify-center text-ink-3 hover:text-ink hover:bg-[#f0f3f0]"
              title="搜索"
              aria-label="搜索"
            >
              <MagnifyingGlass size={18} />
            </Link>
            {showAdminLink && (
              <Link
                to="/admin"
                className="w-9 h-9 rounded-full flex items-center justify-center text-ink-3 hover:text-ink hover:bg-[#f0f3f0]"
                title="Admin"
                aria-label="Admin"
              >
                <GearSix size={18} />
              </Link>
            )}
            {user ? (
              <button
                onClick={logout}
                title={`Sign out ${user.username}`}
                aria-label="Sign out"
                className="w-9 h-9 rounded-full flex items-center justify-center text-ink-3 hover:text-ink hover:bg-[#f0f3f0]"
              >
                <SignOut size={18} />
              </button>
            ) : (
              <Link to="/login" className="text-xs text-brand font-medium px-2">
                Sign in
              </Link>
            )}
          </div>
        </div>
        )}

        {/* Search bar (only on pages that opt in) */}
        {!hideSearch && (
          <div className="flex items-center gap-3 md:gap-4 mb-4 md:mb-6">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
              }}
              className="flex-1 max-w-xl"
            >
              <div className="input flex items-center gap-2 !py-2 md:!py-2.5">
                <MagnifyingGlass size={16} className="text-ink-3 shrink-0" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={searchPlaceholder ?? "搜视频、字幕、Chunk…"}
                  className="flex-1 min-w-0 outline-none bg-transparent text-sm"
                />
              </div>
            </form>
          </div>
        )}
        {children}
      </main>

      {/* Mobile bottom tab bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-line z-40 pb-[env(safe-area-inset-bottom)]"
      >
        {/* 列数跟着 NAV 长度走，不写死。加 Review 入口时这里还是 grid-cols-5，
            第 6 项会被挤到第二行去。 */}
        <div className="grid h-16" style={{ gridTemplateColumns: `repeat(${NAV.length}, minmax(0, 1fr))` }}>
          {NAV.map(({ to, label, Icon }) => {
            const on = isActive(to);
            return (
              <Link
                key={to}
                to={to}
                className={`flex flex-col items-center justify-center gap-0.5 text-2xs font-medium ${
                  on ? "text-brand" : "text-ink-3"
                }`}
              >
                <Icon size={20} weight={on ? "fill" : "regular"} />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
