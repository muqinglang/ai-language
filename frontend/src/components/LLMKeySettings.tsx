import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowSquareOut, BookOpen, Check, CircleNotch, Key, Plug, ShieldCheck, SpeakerHigh, Trash, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, errorDetail } from "@/lib/api";
import type { LLMSettings } from "@/lib/api";
import { KeyGuideModal } from "@/components/KeyGuideModal";

/**
 * 我的 API key — 让学员把 AI 对话指到自己的 provider（BYOK）。
 *
 * 后端 (`/api/me/llm`) 保存前会真的调一次 provider，失败就 400 + 中文原因；
 * 这里的规矩是**原样把那句话显示出来**，它是唯一说清"为什么被拒"的东西。
 *
 * key 只以密文落库，读回来的永远是掩码，所以改任何一项（换模型、换 base_url）
 * 都得重新粘贴 key —— 后端没有"沿用旧 key"这条路，表单里写明了这点。
 *
 * `available:false`（服务端没配 CREDENTIAL_ENC_KEY）时整段不渲染：给一个只会
 * 503 的表单比不给更糟。
 */
export function LLMKeySettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me-llm"],
    queryFn: () => api.getLLMSettings(),
    // 一次 401/网络抖动不值得反复打；用户可以刷新页面。
    retry: false,
  });

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);

  // 表单字段
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const providers = data?.providers ?? [];
  const meta = providers.find((p) => p.id === provider);

  // 打开表单时用已保存的值做初值；provider 换了就跟着换默认模型。
  const openForm = () => {
    const p = data?.configured ? data.provider : providers[0]?.id ?? "openai";
    setProvider(p);
    setModel(data?.configured ? data.model : providers.find((x) => x.id === p)?.default_model ?? "");
    setBaseUrl(data?.configured ? data.base_url : "");
    setApiKey("");
    setError("");
    setOkMsg("");
    setEditing(true);
  };

  const switchProvider = (id: string) => {
    setProvider(id);
    setModel(providers.find((p) => p.id === id)?.default_model ?? "");
    setBaseUrl("");
  };

  // 从首页横幅点「去设置」过来的是 /me#api-key。这张卡在「我的」页面很靠下，
  // 而且要等 /me/llm 回来才渲染 —— 浏览器原生的 hash 跳转那时早就跑完了，
  // 所以渲染出来之后自己滚一次。
  useEffect(() => {
    if (isLoading || !data?.available) return;
    if (window.location.hash !== "#api-key") return;
    document
      .getElementById("api-key")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [isLoading, data?.available]);

  // 成功提示 4 秒后自己消失，不用用户去关。
  useEffect(() => {
    if (!okMsg) return;
    const t = setTimeout(() => setOkMsg(""), 4000);
    return () => clearTimeout(t);
  }, [okMsg]);

  const apply = (next: LLMSettings) => qc.setQueryData(["me-llm"], next);

  const save = async () => {
    if (!apiKey.trim()) {
      setError("请粘贴 API key");
      return;
    }
    if (provider === "custom" && !baseUrl.trim()) {
      setError("自定义 provider 需要填 base URL");
      return;
    }
    setBusy("save");
    setError("");
    setOkMsg("");
    try {
      apply(
        await api.saveLLMSettings({
          provider,
          api_key: apiKey.trim(),
          model: model.trim(),
          base_url: baseUrl.trim(),
        }),
      );
      setApiKey("");
      setEditing(false);
      setOkMsg("已保存 · 连接验证通过");
    } catch (e) {
      setError(errorDetail(e, "保存失败，请重试"));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setError("");
    setOkMsg("");
    try {
      apply(await api.testLLMSettings());
      setOkMsg("连接正常");
    } catch (e) {
      setError(errorDetail(e, "测试失败"));
      // 后端在失败时把原因写进了 last_error，重新拉一次让卡片也显示出来。
      qc.invalidateQueries({ queryKey: ["me-llm"] });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    setError("");
    try {
      apply(await api.deleteLLMSettings());
      setConfirmDelete(false);
      setEditing(false);
      setOkMsg("已删除。AI 对话、查词、翻译在你重新填一个 key 之前会停用");
    } catch (e) {
      setError(errorDetail(e, "删除失败"));
    } finally {
      setBusy(null);
    }
  };

  // 加载中 / 服务端没开这个功能 → 整段不出现。
  if (isLoading || !data?.available) return null;

  return (
    // id + scroll-mt: /me#api-key is where the Home nudge sends the learner,
    // and this card sits well below the fold on the 我的 page.
    <div id="api-key" className="card p-4 md:p-5 mb-6 scroll-mt-6">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Key size={14} className="text-ink-2" />
        <h3 className="text-base font-semibold">我的 API key</h3>
        {/* 「不填不影响其他功能」这半句要留着：删掉 key 承诺卡里的长文后，
            这里是唯一还告诉学员「不交 key 也能用这个产品」的地方。 */}
        <span className="text-xs text-ink-2">
          AI 对话 / 查词 / 翻译用你自己的模型 · 不填不影响其他功能
        </span>
      </div>

      {okMsg && (
        <div className="flex items-center gap-1.5 mb-3 px-3 py-2 rounded-lg bg-[#f0fdf4] border border-[#bbf7d0] text-xs text-[#166534]">
          <Check size={13} weight="bold" /> {okMsg}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-1.5 mb-3 px-3 py-2 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-xs text-[#b91c1c]">
          <WarningCircle size={13} weight="bold" className="shrink-0 mt-px" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      {data.configured && !editing ? (
        <SavedView
          data={data}
          busy={busy}
          confirmDelete={confirmDelete}
          onEdit={openForm}
          onTest={test}
          onAskDelete={() => setConfirmDelete(true)}
          onCancelDelete={() => setConfirmDelete(false)}
          onDelete={remove}
        />
      ) : editing ? (
        <div className="space-y-3">
          <label className="block">
            <span className="text-2xs text-ink-3 font-medium">Provider</span>
            <select
              className="input mt-1"
              value={provider}
              onChange={(e) => switchProvider(e.target.value)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {meta?.hint && (
              <span className="block text-2xs text-ink-3 mt-1.5">
                {meta.hint}
                {meta.key_url && (
                  <>
                    {" "}
                    <a
                      className="text-brand underline underline-offset-2 inline-flex items-center gap-0.5"
                      href={meta.key_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      去申请 key <ArrowSquareOut size={10} weight="bold" />
                    </a>
                  </>
                )}
              </span>
            )}
          </label>

          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
          >
            <BookOpen size={13} /> 如何获取 key?（带截图分步）
          </button>

          {/* 挑模型是这个表单里最容易踩坑的一步 —— deepseek-v4-flash 会返回空
              内容，看起来跟"key 是坏的"一模一样。所以把每个模型的说明摆在选项
              旁边，而不是塞进一个没人会打开的文档。 */}
          <div>
            <span className="text-2xs text-ink-3 font-medium">模型</span>
            {meta?.models.length ? (
              <div className="mt-1.5 space-y-1.5">
                {meta.models.map((m) => {
                  const active = model.trim() === m;
                  const note = meta.notes?.[m];
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModel(m)}
                      className={`w-full text-left rounded-xl border px-3 py-2 transition-colors duration-150 ease-spring ${
                        active
                          ? "border-brand bg-[#f4f9f6]"
                          : "border-line bg-white hover:bg-[#f5f7f4]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono">{m}</span>
                        {m === meta.default_model && (
                          <span className="text-2xs px-1.5 py-px rounded-full bg-[#eaf3ec] text-brand">
                            推荐
                          </span>
                        )}
                        {active && (
                          <Check size={13} weight="bold" className="ml-auto text-brand" />
                        )}
                      </div>
                      {note && (
                        <div className="text-2xs text-ink-3 mt-0.5">{note}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {/* provider 上新模型比我们发版快，所以永远留一个自己填的口子。 */}
            <input
              className="input mt-1.5"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={meta?.default_model || "例如 gpt-4o-mini"}
              autoComplete="off"
            />
            <span className="block text-2xs text-ink-3 mt-1">
              {meta?.models.length
                ? "上面点一个，或在这里直接填别的模型名"
                : "填一个这个接口支持的模型名"}
            </span>
          </div>

          {provider === "custom" && (
            <label className="block">
              <span className="text-2xs text-ink-3 font-medium">
                Base URL（OpenAI 兼容接口）
              </span>
              <input
                className="input mt-1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://your-gateway.example.com/v1"
                autoComplete="off"
              />
            </label>
          )}

          <label className="block">
            <span className="text-2xs text-ink-3 font-medium">API key</span>
            <input
              className="input mt-1 font-mono"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
            />
            <span className="block text-2xs text-ink-3 mt-1.5">
              保存时会真的调一次接口验证，通不过不会存。
            </span>
          </label>

          <KeyPromise />

          <div className="flex flex-wrap gap-2 pt-0.5">
            <button
              className="btn-primary inline-flex items-center gap-1.5"
              onClick={save}
              disabled={busy !== null}
            >
              {busy === "save" ? (
                <>
                  <CircleNotch size={13} weight="bold" className="animate-spin" /> 验证中...
                </>
              ) : (
                "保存并验证"
              )}
            </button>
            {(data.configured || providers.length > 0) && (
              <button
                className="btn-ghost"
                onClick={() => {
                  setEditing(false);
                  setError("");
                }}
                disabled={busy !== null}
              >
                取消
              </button>
            )}
          </div>
        </div>
      ) : (
        // 承诺放在「还没填」这一屏也出现 —— 要打消的顾虑是在交出 key 之前
        // 产生的，等填完再解释就晚了。
        <div className="space-y-3">
          <button className="btn-ghost inline-flex items-center gap-1.5" onClick={openForm}>
            <Plug size={14} /> 使用我自己的 key
          </button>
          <KeyPromise />
        </div>
      )}

      <KeyGuideModal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        provider={provider}
        url={meta?.key_url}
      />
    </div>
  );
}

/**
 * 关于「别人会不会用到我的 key」的正面回答。
 *
 * 每一条都对应代码里一个可以去查的事实，不是公关话术：
 * - 取 key 的路径只有两条（`user_llm._to_out` / `load_override`），都写死
 *   按当前登录用户那一行查；后台没有任何接口能读到别人的 key
 * - 传给 LLM 的 override 只出现在对话侧调用，pipeline 永远走平台的 key
 * - 落库前 Fernet 加密，密钥在服务器环境变量里，既不在数据库也不在仓库里
 * - provider 报错先把 key 串抹掉再存进 last_error
 *
 * 文案只留承诺本身，实现细节（Fernet、环境变量、掩码规则）一概不写：学员要的
 * 是「会不会被别人花掉」的答案，读到加密算法名只会更没底。措辞可以改，但每一
 * 条都必须仍然对得上上面那几个事实——这段是写给学员看的保证，不是宣传语。
 */
function KeyPromise() {
  const lines = [
    "只有你自己能用，管理员也看不到。",
    "只花在你自己的对话上，平台的活不算你的账。",
    "存下来的是加密的，不是原文。",
    "存完就再也显示不出来，页面上只看得到后四位。",
    "报错信息里不会带上你的 key。",
    "随时可以删，删了立刻失效。",
  ];
  return (
    <div className="rounded-xl border border-[#bbf7d0] bg-[#f6fefa] p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <ShieldCheck size={14} className="text-[#16a34a]" />
        我们对你的 key 的承诺
      </div>
      <ul className="text-xs text-ink space-y-1">
        {lines.map((line) => (
          <li key={line} className="flex gap-1.5">
            <span className="text-[#16a34a] shrink-0">·</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "从未";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SavedView({
  data,
  busy,
  confirmDelete,
  onEdit,
  onTest,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  data: LLMSettings;
  busy: "save" | "test" | "delete" | null;
  confirmDelete: boolean;
  onEdit: () => void;
  onTest: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const label = data.providers.find((p) => p.id === data.provider)?.label ?? data.provider;
  return (
    <div>
      <div className="rounded-xl border border-line bg-[#f8faf8] p-3.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{label}</span>
          <span className="text-xs text-ink-2 font-mono">{data.model}</span>
          <span className="text-xs text-ink-3 font-mono">{data.key_mask}</span>
        </div>
        {data.base_url && (
          <div className="text-2xs text-ink-3 font-mono mt-1 break-all">{data.base_url}</div>
        )}
        <div className="text-2xs text-ink-3 mt-1.5">
          上次验证：{formatWhen(data.verified_at)}
        </div>
        {data.last_error && (
          <div className="flex items-start gap-1.5 text-2xs text-[#b91c1c] mt-1.5">
            <WarningCircle size={12} weight="bold" className="shrink-0 mt-px" />
            <span className="min-w-0">{data.last_error}</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        <button
          className="btn-ghost inline-flex items-center gap-1.5"
          onClick={onTest}
          disabled={busy !== null}
        >
          {busy === "test" ? (
            <>
              <CircleNotch size={13} weight="bold" className="animate-spin" /> 测试中...
            </>
          ) : (
            <>
              <Plug size={14} /> 测试连接
            </>
          )}
        </button>
        <button className="btn-ghost" onClick={onEdit} disabled={busy !== null}>
          修改
        </button>
        {confirmDelete ? (
          <>
            <button
              className="btn inline-flex items-center gap-1.5 bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] hover:bg-[#fee2e2]"
              onClick={onDelete}
              disabled={busy !== null}
            >
              {busy === "delete" ? (
                <CircleNotch size={13} weight="bold" className="animate-spin" />
              ) : (
                <Trash size={13} />
              )}
              确认删除
            </button>
            <button className="btn-ghost" onClick={onCancelDelete} disabled={busy !== null}>
              取消
            </button>
          </>
        ) : (
          <button
            className="btn-ghost inline-flex items-center gap-1.5 text-ink-3"
            onClick={onAskDelete}
            disabled={busy !== null}
          >
            <Trash size={13} /> 删除
          </button>
        )}
      </div>
    </div>
  );
}
