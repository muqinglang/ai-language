import { useEffect, useRef, useState } from "react";

/**
 * Google Identity Services sign-in button.
 *
 * Loads Google's script on demand (only when a client id is configured,
 * so the request never fires on deploys without Google sign-in), renders
 * their official button into a ref'd div, and hands the resulting ID
 * token to `onCredential`. The parent posts it to /api/auth/google.
 *
 * The script is served from accounts.google.com, which is unreachable
 * from mainland China without a VPN. When it fails to load we render a
 * short explanation instead of an invisible dead zone — a silent
 * missing button reads as a broken page.
 */

const SCRIPT_ID = "google-gsi-client";
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: {
            client_id: string;
            callback: (res: { credential?: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (parent: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

/** Resolves once window.google.accounts.id exists, rejects if it can't load. */
function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let el = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!el) {
      el = document.createElement("script");
      el.id = SCRIPT_ID;
      el.src = SCRIPT_SRC;
      el.async = true;
      el.defer = true;
      document.head.appendChild(el);
    }
    // A cached-but-still-parsing script fires load again for the new
    // listener, so attaching here is safe whether or not we created it.
    el.addEventListener("load", () => {
      window.google?.accounts?.id ? resolve() : reject(new Error("gsi missing"));
    });
    el.addEventListener("error", () => reject(new Error("gsi blocked")));
    // Google's CDN can hang rather than error out when it's being
    // filtered; don't leave the user staring at a blank slot forever.
    setTimeout(() => {
      window.google?.accounts?.id ? resolve() : reject(new Error("gsi timeout"));
    }, 8000);
  });
}

export function GoogleSignInButton({
  clientId,
  onCredential,
  onError,
}: {
  clientId: string;
  onCredential: (credential: string) => void;
  onError?: (msg: string) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);
  // Keep the latest callbacks without re-running the (one-shot) init.
  const cb = useRef(onCredential);
  const errCb = useRef(onError);
  cb.current = onCredential;
  errCb.current = onError;

  useEffect(() => {
    if (!clientId) return;
    let alive = true;
    loadGsi()
      .then(() => {
        if (!alive || !slot.current) return;
        window.google!.accounts.id.initialize({
          client_id: clientId,
          callback: (res) => {
            if (res.credential) cb.current(res.credential);
            else errCb.current?.("Google 未返回凭证，请重试");
          },
          // No One Tap auto-sign-in: it pops over the page uninvited and
          // this button is already right there.
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        window.google!.accounts.id.renderButton(slot.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "signin_with",
          logo_alignment: "center",
          width: 320,
        });
      })
      .catch(() => {
        if (alive) setBlocked(true);
      });
    return () => {
      alive = false;
    };
  }, [clientId]);

  if (!clientId) return null;
  if (blocked) {
    return (
      <p className="text-xs text-ink-3 text-center leading-relaxed">
        Google 登录加载失败（网络无法访问 Google）。
        <br />
        请用上面的邮箱注册 / 登录。
      </p>
    );
  }
  return <div ref={slot} className="flex justify-center min-h-[44px]" />;
}
