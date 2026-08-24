import { useEffect } from "react";
import { ArrowSquareOut, BookOpen, X } from "@phosphor-icons/react";

/**
 * 「如何获取 key」图文引导弹窗。
 *
 * 在「我的 API key」(DeepSeek 等)和「AI 朗读声音」(MiniMax 等)配置处点开,
 * 给出平台地址 + 分步截图,照着做就能拿到 key(MiniMax 还要拿 GroupId)。
 *
 * 截图放在 frontend/public/guides/ 下,文件名见每步的 img 字段;图还没放进去时
 * onError 会把它隐藏,纯文字步骤照样读得通。补图后无需改代码,刷新即显示。
 */
type Step = { text: string; img?: string; caption?: string };
type Guide = { title: string; url: string; note?: string; steps: Step[] };

const GUIDES: Record<string, Guide> = {
  deepseek: {
    title: "获取 DeepSeek key",
    url: "https://platform.deepseek.com/api_keys",
    note: "国内直连、最便宜,中文解释也好 —— 推荐大多数人用它。聊很久也就几毛钱。",
    steps: [
      {
        text: "打开 platform.deepseek.com,用手机号或邮箱注册 / 登录。",
      },
      {
        text: "左侧菜单点「Usage」,再点「Top up」充个小额(如 ¥10)就能用很久。新账号可能自带一点赠送额度,余额已 > 0 可先跳过。",
        img: "/guides/deepseek-topup.png",
        caption: "Usage 页 → Top up 充值",
      },
      {
        text: "左侧「API keys」→ 右上角「Create new API key」→ 起个名(如 justspeak)→ 复制那串以 sk- 开头的 key。⚠️ 只显示这一次,先存好。",
        img: "/guides/deepseek-apikey.png",
        caption: "API keys → Create new API key,创建后复制",
      },
      {
        text: "回到这里,把 sk- 开头的 key 粘进「API key」框,模型选 deepseek-v4-pro(推荐),点「保存并验证」。",
      },
    ],
  },
  minimax: {
    title: "获取 MiniMax 朗读 key",
    url: "https://platform.minimaxi.com/",
    note: "MiniMax 朗读要两样:「订阅 Key(sk-cp 开头)」+「团队 ID(即 GroupId)」。下面各拿一个。",
    steps: [
      {
        text: "打开 platform.minimaxi.com 用手机号登录,点右上角头像 →「API & Token Plan」进入控制台。",
        img: "/guides/minimax-console.png",
        caption: "右上角头像下拉 → API & Token Plan",
      },
      {
        text: "左侧「账户 → 基本信息」,复制「团队 ID」—— 这就是 justSpeak 里要填的 GroupId。",
        img: "/guides/minimax-groupid.png",
        caption: "基本信息 · 复制团队 ID(= GroupId)",
      },
      {
        text: "左侧「订阅付费 → 套餐详情」,在「订阅 Key (sk-cp)」处点「复制」—— 这就是 API key。(需先订阅 Token Plan / 有积分才能用)",
        img: "/guides/minimax-subkey.png",
        caption: "套餐详情 · 复制订阅 Key(sk-cp 开头)",
      },
      {
        text: "回到这里,把「订阅 Key」填进 API key、把「团队 ID」填进 GroupId,保存。",
      },
    ],
  },
  cosyvoice: {
    title: "获取 CosyVoice(阿里云百炼)key",
    url: "https://bailian.console.aliyun.com/?apiKey=1",
    note: "阿里云百炼的语音合成,国内直连。",
    steps: [
      {
        text: "打开阿里云百炼控制台并登录(需阿里云账号)。",
        img: "/guides/cosyvoice-1.png",
        caption: "百炼控制台",
      },
      {
        text: "进入「API-KEY」页面,创建 / 复制一个 API key(sk- 开头)。",
        img: "/guides/cosyvoice-2.png",
        caption: "创建并复制 API key",
      },
      {
        text: "回到这里,把 key 粘进去,选好音色,保存。",
      },
    ],
  },
};

// 没有详细图文的 provider 用这个兜底:给平台地址 + 一句通用说明。
function fallbackGuide(url: string): Guide {
  return {
    title: "获取 API key",
    url,
    note: "到该平台创建一个 API key,复制后回到这里粘贴、保存即可。",
    steps: [],
  };
}

export function KeyGuideModal({
  open,
  onClose,
  provider,
  url,
}: {
  open: boolean;
  onClose: () => void;
  /** provider id,如 "deepseek" / "minimax" / "cosyvoice" */
  provider: string;
  /** provider 没有内置图文时的申请地址(来自后端 meta.key_url),做兜底 */
  url?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const guide = GUIDES[provider] ?? fallbackGuide(url ?? "");

  return (
    <div
      className="fixed inset-0 bg-ink/35 backdrop-blur-[2px] z-50 grid place-items-center p-4 md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl shadow-[#00000014] overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line/70 shrink-0">
          <BookOpen size={15} className="text-ink-3" />
          <span className="text-sm font-semibold text-ink tracking-wide">{guide.title}</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:bg-[#eff2ef] hover:text-ink transition-colors duration-150 ease-spring"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto text-sm leading-[1.7] text-ink space-y-4">
          {guide.url && (
            <a
              href={guide.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#eaf3ec] text-brand font-medium px-3 py-2 text-xs hover:bg-[#dcebe0] transition-colors duration-150 ease-spring"
            >
              打开平台 {guide.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}
              <ArrowSquareOut size={12} weight="bold" />
            </a>
          )}

          {guide.note && (
            <div className="rounded-xl bg-[#f4f9f6] border border-[#c9dfd0] px-3.5 py-2.5 text-xs text-[#285e48]">
              {guide.note}
            </div>
          )}

          {guide.steps.length > 0 && (
            <ol className="space-y-4 list-none">
              {guide.steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 grid place-items-center rounded-full bg-brand text-white text-2xs font-semibold mt-0.5">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{s.text}</div>
                    {s.img && (
                      <figure className="mt-2">
                        <img
                          src={s.img}
                          alt={s.caption ?? `步骤 ${i + 1}`}
                          loading="lazy"
                          className="w-full rounded-lg border border-line"
                          onError={(e) => {
                            // 图还没放进 public/guides/ 时,隐藏整个 figure。
                            (e.currentTarget.closest("figure") as HTMLElement).style.display = "none";
                          }}
                        />
                        {s.caption && (
                          <figcaption className="text-2xs text-ink-3 mt-1">{s.caption}</figcaption>
                        )}
                      </figure>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
