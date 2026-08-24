import { Key } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

/** AI 功能要用学员自己的 API key，而 TA 还没配。
 *
 * 平台不再替任何人垫模型，所以这一屏是走到 AI tab 的必经之路，不是边角
 * 情况 —— 它得像个入口而不像个故障。 */
export function NeedApiKey({ message }: { message: string }) {
  return (
    <div className="py-6">
      <div className="rounded-2xl border border-[#c9dfd0] bg-[#f4f9f6] p-5">
        <div className="flex items-center gap-2 text-base font-semibold text-ink mb-1.5">
          <Key size={15} className="text-brand" />
          先配一个自己的 API key
        </div>
        <p className="text-xs text-ink-2 leading-relaxed mb-3">
          {message}
          <br />
          AI 对话、查词解释、气泡翻译都跑在你自己的模型上，用多少花多少，额度
          是你自己的，谁也共用不到。DeepSeek 国内直连、最便宜，几分钟就能申请好。
        </p>
        <Link
          to="/me#api-key"
          className="btn-primary inline-flex items-center gap-1.5 no-underline"
        >
          <Key size={14} /> 去配置
        </Link>
      </div>
    </div>
  );
}
