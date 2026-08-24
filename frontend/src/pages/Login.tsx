import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { LogoMark, Wordmark } from "@/components/Logo";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { api, setSession, type AuthConfig, type TokenPayload } from "@/lib/api";
import { isHandheld } from "@/lib/device";

/** Render a date as "5月10日" in the user's local TZ. */
function formatExpiryDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  } catch {
    return iso;
  }
}

/**
 * Map api.login()'s thrown error into a user-friendly Chinese message.
 * The api wrapper throws `Error("<status> <body>")` for non-2xx, so we
 * key off the leading status code rather than parsing the JSON detail.
 * trial_expired (403 with structured detail) is parsed inline so we can
 * show the actual expiry date.
 */
function friendlyLoginError(e: Error): string {
  const msg = e.message || "";
  if (msg.startsWith("401")) {
    // The backend distinguishes one 401: a Google-created account has no
    // password, so "wrong password" would send the user in circles.
    if (msg.includes("Google")) return "该邮箱通过 Google 注册，请用下方 Google 登录";
    return "用户名或密码错误";
  }
  if (msg.startsWith("403")) {
    // 403 body shape: `403 {"detail":{"code":"trial_expired","expired_at":"...","message":"..."}}`
    const m = msg.match(/"code":"trial_expired"[^}]*"expired_at":"([^"]+)"/);
    if (m) {
      return `您的试用已于 ${formatExpiryDate(m[1])} 到期。请联系管理员延期。`;
    }
    if (msg.includes("registration closed")) return "注册已关闭，请联系管理员开通账号";
    return "账号被禁用，请联系管理员";
  }
  if (msg.startsWith("404")) return "账号不存在";
  if (msg.startsWith("429")) return "尝试太频繁，稍后再试";
  if (msg.startsWith("5")) return "服务器开小差了，稍后再试";
  if (/network|failed to fetch/i.test(msg)) return "网络异常，请检查网络后重试";
  return "登录失败，请稍后再试";
}

/** Signup shares most failure modes with login but has two of its own. */
function friendlySignupError(e: Error): string {
  const msg = e.message || "";
  if (msg.startsWith("409")) {
    if (msg.includes("用户名")) return "该用户名已被占用";
    return "该邮箱已注册，请直接登录";
  }
  // Pydantic validation (422) — surface our own rule rather than its JSON.
  if (msg.startsWith("422")) {
    if (msg.includes("密码")) return "密码至少 6 位";
    return "邮箱格式不正确";
  }
  return friendlyLoginError(e);
}

type Mode = "login" | "signup";

export function Login() {
  const nav = useNavigate();
  const [search] = useSearchParams();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setU] = useState("");
  const [email, setEmail] = useState("");
  const [password, setP] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [cfg, setCfg] = useState<AuthConfig | null>(null);

  // Whether signup is open and whether Google is available are server
  // facts — the same build ships to a deploy with neither.  Failure to
  // fetch leaves cfg null, which renders the plain login form: the
  // safe subset that works everywhere.
  useEffect(() => {
    api.authConfig().then(setCfg).catch(() => setCfg(null));
  }, []);

  // If we got bounced here from a mid-session 403 trial_expired, show
  // the same Chinese message above the form so the user knows why
  // they were logged out.  ?expired=1&at=<iso> set by the api.ts boundary.
  useEffect(() => {
    if (search.get("expired") === "1") {
      const at = search.get("at");
      if (at) {
        setErr(`您的试用已于 ${formatExpiryDate(at)} 到期。请联系管理员延期。`);
      } else {
        setErr("试用已到期，请联系管理员延期。");
      }
    }
  }, [search]);

  // Admins land in the backend on a desktop only. On a phone or tablet
  // the admin console is unusable (dense tables, an import flow that
  // needs a local yt-dlp) and it hid the actual product behind it, so
  // a handheld admin gets the learner app like everyone else.
  const land = (r: TokenPayload) => {
    setSession(r);
    nav(r.user.role === "admin" && !isHandheld() ? "/admin" : "/");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      if (mode === "signup") {
        land(await api.register(email.trim(), password));
      } else {
        land(await api.login(username.trim(), password));
      }
    } catch (e) {
      setErr(mode === "signup" ? friendlySignupError(e as Error) : friendlyLoginError(e as Error));
    } finally {
      setLoading(false);
    }
  };

  const onGoogle = async (credential: string) => {
    setErr("");
    setLoading(true);
    try {
      land(await api.googleLogin(credential));
    } catch (e) {
      const msg = (e as Error).message || "";
      // 503 = the server can't do Google auth at all (unconfigured, or it
      // can't reach Google). That's ours to fix, not something the user
      // can retry their way out of.
      setErr(msg.startsWith("503") ? "服务器暂时无法验证 Google 登录，请用邮箱注册" : friendlyLoginError(e as Error));
    } finally {
      setLoading(false);
    }
  };

  const signupOpen = cfg?.self_signup ?? false;
  const trialDays = cfg?.trial_days ?? 0;
  const switchMode = (m: Mode) => {
    setMode(m);
    setErr("");
  };

  return (
    <div className="min-h-screen grid place-items-center bg-[#f5f7f4] p-6 md:p-8">
      <form onSubmit={submit} className="card w-full max-w-md p-8 md:p-10">
        <div className="flex items-center gap-2 mb-2">
          <LogoMark size={42} />
          <Wordmark size={28} />
        </div>
        <p className="text-ink-2 text-sm mb-6">只需要开口 · learn english by just speaking</p>

        {signupOpen && (
          <div className="flex gap-1 p-1 mb-5 rounded-lg bg-[#eff2ef]">
            {(["login", "signup"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`flex-1 py-1.5 text-sm rounded-md transition ${
                  mode === m ? "bg-white text-ink shadow-sm" : "text-ink-2 hover:text-ink"
                }`}
              >
                {m === "login" ? "登录" : "注册"}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3">
          {mode === "signup" ? (
            <div>
              <label className="text-xs text-ink-2 mb-1 block">邮箱</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </div>
          ) : (
            <div>
              <label className="text-xs text-ink-2 mb-1 block">
                {signupOpen ? "邮箱或用户名" : "用户名"}
              </label>
              <input
                className="input"
                value={username}
                onChange={(e) => setU(e.target.value)}
                placeholder={signupOpen ? "you@example.com" : "你的账号"}
                autoComplete="username"
                required
              />
            </div>
          )}
          <div>
            <label className="text-xs text-ink-2 mb-1 block">密码</label>
            <div className="relative">
              <input
                className="input !pr-10"
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setP(e.target.value)}
                placeholder={mode === "signup" ? "至少 6 位" : "你的密码"}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-ink-3 hover:text-ink hover:bg-[#eff2ef]"
                title={showPw ? "隐藏密码" : "显示密码"}
                tabIndex={-1}
              >
                {showPw ? <EyeSlash size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
        </div>

        {err && <div className="text-brand text-xs mt-3">{err}</div>}

        <button type="submit" disabled={loading} className="btn-primary w-full mt-6">
          {loading ? "…" : mode === "signup" ? "注册并开始" : "登录"}
        </button>

        {cfg?.google_client_id && (
          <>
            <div className="flex items-center gap-3 my-5">
              <div className="h-px flex-1 bg-[#eceef3]" />
              <span className="text-xs text-ink-3">或</span>
              <div className="h-px flex-1 bg-[#eceef3]" />
            </div>
            <GoogleSignInButton
              clientId={cfg.google_client_id}
              onCredential={onGoogle}
              onError={setErr}
            />
          </>
        )}

        {signupOpen ? (
          <p className="text-xs text-ink-3 mt-6 text-center leading-relaxed">
            {mode === "signup"
              ? trialDays > 0
                ? `注册即可免费试用 ${trialDays} 天，无需付款。`
                : "注册即可开始使用。"
              : "还没有账号？点上方「注册」，即刻开始。"}
          </p>
        ) : (
          <p className="text-xs text-ink-3 mt-6 text-center leading-relaxed">
            还没有账号？在小红书找到这个网站的入口帖子，
            <br />
            按帖子说明联系我开通账号。
          </p>
        )}
      </form>
    </div>
  );
}
