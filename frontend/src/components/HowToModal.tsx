import { useEffect } from "react";
import { Question, X } from "@phosphor-icons/react";

/**
 * Methodology overlay used in two places:
 *  - Learn page: opens via the ❓ icon in the meta bar AND auto-fires
 *    once on first visit (HowToButton owns that gate via localStorage).
 *  - Home page: opens via the "💡 怎么学" link, no auto-open.
 *
 * Pure presentational — caller owns the open state.  ESC/click-outside
 * close handlers are wired here so callers don't have to redo them.
 */
export function HowToModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-ink/35 backdrop-blur-[2px] z-50 grid place-items-center p-4 md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl shadow-[#00000014] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line/70">
          <Question size={15} className="text-ink-3" />
          <span className="text-sm font-semibold text-ink tracking-wide">怎么用 justSpeak 学英文</span>
          {/* contract-first: the method IS the constraint */}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:bg-[#eff2ef] hover:text-ink transition-colors duration-150 ease-spring"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4 max-h-[72vh] overflow-y-auto text-sm leading-[1.7] text-ink space-y-5">
          <section className="rounded-xl bg-[#f4f9f6] border border-[#c9dfd0] px-4 py-3">
            <div className="text-sm font-semibold text-[#285e48] mb-1">
              听一句，停，用嘴说回来
            </div>
            <div className="text-xs text-ink-2 leading-relaxed">
              不是跟读。跟读是边听边鹦鹉学舌，脑子可以不动。
              复述是：听完，<b className="text-ink">停掉</b>，凭记忆把<b className="text-ink">整句</b>重说一遍。说不全？再听，从头再说。
              这一个动作，同时逼你 <b className="text-ink">听 + 懂 + 记 + 说</b>。很累。但没有比它更快的路。
            </div>
          </section>

          <section>
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-[0.12em] mb-2">
              三条铁律
            </div>
            <ul className="space-y-1.5 list-none">
              <li><b className="text-brand mr-1.5">·</b><b>别看字幕。</b>大脑很懒，有字它就在"阅读"，不在"听"。</li>
              <li><b className="text-brand mr-1.5">·</b><b>别打碎成单词。</b>整句说不出来 = 材料太难，换简单的。至少以句号为单位。</li>
              <li><b className="text-brand mr-1.5">·</b><b>你听不懂，常常是因为你不会说。</b>自己说一遍，胜过听十遍。</li>
            </ul>
          </section>

          <section>
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-[0.12em] mb-2">
              在 justSpeak 里就这么练
            </div>
            <ol className="space-y-1.5 list-none">
              <li><b className="text-brand mr-1.5">1</b>切到 <b>Listen</b>，勾上 <b>Auto-pause</b> —— 字幕全关，每句自动停。</li>
              <li><b className="text-brand mr-1.5">2</b>听完这句，停。<b>开口说回来</b>，凭记忆，说整句。</li>
              <li><b className="text-brand mr-1.5">3</b>说不全 → 点 <b>🔁</b> 再听，从头再说。<b>别看字。</b></li>
              <li><b className="text-brand mr-1.5">4</b>真卡死 → 点字幕<b>揭晓</b>对一眼，只在说不出来时看。</li>
              <li><b className="text-brand mr-1.5">5</b>想更狠 → 点 <b>🎤</b> 录下自己，和原声叠着听，差在哪一耳朵就知道。</li>
            </ol>
            <div className="text-xs text-ink-3 mt-2">整句能一口气说顺，才进下一句。</div>
          </section>

          <section>
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-[0.12em] mb-2">
              材料：两周只啃一个话题，别换
            </div>
            <div className="text-xs text-ink-2 leading-relaxed">
              同一个话题反复啃，高频词、固定搭配会不断复现，你慢慢就能<b className="text-ink">预测下一句</b>。
              博主可以换，话题别换。
            </div>
          </section>

          <section>
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-[0.12em] mb-2">
              键盘快捷键（桌面）
            </div>
            <ul className="space-y-1 text-xs text-ink-2">
              <li><kbd className="font-mono text-ink">Space</kbd> 播放 / 暂停</li>
              <li><kbd className="font-mono text-ink">J</kbd> / <kbd className="font-mono text-ink">K</kbd> 上一句 / 下一句</li>
              <li><kbd className="font-mono text-ink">L</kbd> 循环本句</li>
              <li><kbd className="font-mono text-ink">R</kbd> 重播本句</li>
            </ul>
          </section>

          <div className="pt-1 text-xs text-ink-3 italic leading-relaxed">
            别再找新材料 —— 找材料是在逃避真正难的那步：开口说回来。一段啃透，胜过十段看过。
            越有效的方法越累；上山的路，越短的越陡。
          </div>
        </div>
      </div>
    </div>
  );
}
