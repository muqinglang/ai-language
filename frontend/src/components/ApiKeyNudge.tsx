import { useQuery } from "@tanstack/react-query";
import { Key, X } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";

const DISMISS_KEY = "api-key-nudge-dismissed";

/**
 * Home banner pointing a learner at 我的 API key (Me → BYOK).
 *
 * Shown only when the server actually offers BYOK (`available`, i.e. it has
 * a CREDENTIAL_ENC_KEY) and the learner hasn't set one yet.
 *
 * This used to sell BYOK as an upgrade ("don't share the platform's quota").
 * It isn't one any more: the platform's keys stopped serving learner-facing
 * calls entirely, so without a key there is no AI 对话 at all. The copy has
 * to say that plainly — a learner who reads "建议配置" and skips it will
 * hit a wall in the AI tab and think the site is broken.
 *
 * Still dismissible (localStorage): the real gate lives in the AI tab,
 * which shows its own 去配置 entry, so nagging on Home forever buys nothing.
 */
export function ApiKeyNudge() {
  const [hidden, setHidden] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  );
  const { data } = useQuery({
    queryKey: ["me-llm"],
    queryFn: () => api.getLLMSettings(),
    retry: false,
  });

  if (hidden || !data?.available || data.configured) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setHidden(true);
  };

  return (
    <div className="relative rounded-xl border border-[#c9dfd0] bg-[#f4f9f6] px-4 py-3 mb-5 flex items-start gap-3">
      <Key size={16} className="text-brand shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 pr-5">
        <div className="text-sm font-semibold">AI 对话需要你自己的 API key</div>
        <p className="text-sm text-ink-2 mt-0.5 leading-relaxed">
          AI 对话、查词解释、气泡翻译都跑在你自己的模型上，配好才能用，用多少
          花多少，额度是你自己的。DeepSeek 国内直连、最便宜，几分钟就能申请好。
          看视频、字幕、Chunks、生词本不受影响。
        </p>
        <Link
          to="/me#api-key"
          className="text-sm text-brand hover:underline inline-block mt-1.5"
        >
          去「我的 → 我的 API key」设置 →
        </Link>
      </div>
      <button
        onClick={dismiss}
        className="absolute right-2 top-2 p-1 rounded-md text-ink-3 hover:text-ink hover:bg-white/70"
        title="不再提示"
        aria-label="不再提示"
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  );
}
