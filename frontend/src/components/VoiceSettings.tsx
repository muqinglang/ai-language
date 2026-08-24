import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, CircleNotch, SpeakerHigh, Square, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, errorDetail } from "@/lib/api";
import type { LLMSettings } from "@/lib/api";
import {
  VOICES,
  PREVIEW_TEXT,
  getPreferredVoiceId,
  setPreferredVoiceId,
} from "@/lib/voices";
import { setOwnVoiceConfigured } from "@/lib/speak";
import { KeyGuideModal } from "@/components/KeyGuideModal";

/**
 * AI 朗读声音 —— key 和音色在同一张卡里。
 *
 * 之前这两半是分开的两张卡（一张叫「AI 朗读的声音」管 key，一张叫「AI 朗读
 * 声音」管音色），名字几乎一样、上下紧挨着，读起来像同一个东西出现了两次。
 * 它们本来就是一件事：先决定谁来念（哪把 key），再决定用哪个嗓子。
 *
 * 没配 CosyVoice key 时，音色列表是平台 ElevenLabs 的那六个（存 localStorage）；
 * 配了之后自动换成 CosyVoice 音色（存服务端，因为那是这个学员自己的凭据）。
 */
export function VoiceSettings({ data }: { data: LLMSettings }) {
  return (
    <div className="card p-4 md:p-5 mb-6">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SpeakerHigh size={14} className="text-ink-2" />
        <h3 className="text-base font-semibold">AI 朗读声音</h3>
        <span className="text-xs text-ink-2">
          可选 · 不填就用浏览器自带的朗读
        </span>
      </div>
      <TTSKeyRow data={data} />
      <div className="mt-4 pt-4 border-t border-line/60">
        <VoiceList />
      </div>
    </div>
  );
}

function VoiceList() {
  const qc = useQueryClient();
  // Same cache entry LLMKeySettings fills, so this re-renders the moment a
  // learner saves or clears their voice key one card above.
  const { data: llm } = useQuery({
    queryKey: ["me-llm"],
    queryFn: () => api.getLLMSettings(),
    retry: false,
  });
  const onCosy = Boolean(llm?.tts_configured);

  // 配了自己的声音 → 告诉出声逻辑别再拿浏览器系统音兜底（跨会话记在
  // localStorage）。删除声音后这里会变 false，系统音兜底自动恢复。
  useEffect(() => {
    if (llm !== undefined) setOwnVoiceConfigured(Boolean(llm?.tts_configured));
  }, [llm]);

  const [selected, setSelected] = useState<string>(() => getPreferredVoiceId());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        try { audioRef.current.pause(); audioRef.current.src = ""; } catch { /* ignore */ }
        audioRef.current = null;
      }
    };
  }, []);

  // ElevenLabs voice ids are a browser preference (the platform key is the
  // same for everyone). A CosyVoice voice is part of the learner's own
  // credentials, so it has to go to the server — and the server re-verifies
  // it against the provider, which is what makes a wrong voice id surface
  // as a message instead of as silence at playback time.
  const choose = async (id: string) => {
    setVoiceError("");
    if (!onCosy) {
      setSelected(id);
      setPreferredVoiceId(id);
      return;
    }
    setSaving(id);
    try {
      qc.setQueryData(["me-llm"], await api.saveTTSSettings({ voice: id }));
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const stopPreview = () => {
    if (audioRef.current) {
      try { audioRef.current.pause(); audioRef.current.src = ""; } catch { /* ignore */ }
      audioRef.current = null;
    }
    setPreviewing(null);
  };

  const preview = async (id: string) => {
    if (previewing === id) {
      stopPreview();
      return;
    }
    stopPreview();
    setPreviewing(id);
    try {
      const token = localStorage.getItem("justspeak_token") ?? "";
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // onCosy 时用 preview_voice 试听（voice_id 是 ElevenLabs 的 id，
        // 发给百炼会 418）。两个字段各管一个 provider，别再混用。
        body: JSON.stringify(
          onCosy
            ? { text: PREVIEW_TEXT, preview_voice: id }
            : { text: PREVIEW_TEXT, voice_id: id },
        ),
      });
      if (!r.ok) {
        // On the CosyVoice path the body carries the provider's own
        // sentence ("参数被拒绝：…最常见的是音色名写错了"), which is the
        // only thing that can tell a learner a voice id doesn't exist.
        let why = `tts ${r.status}`;
        try {
          const j = await r.json();
          if (typeof j?.detail === "string") why = j.detail;
        } catch { /* not JSON */ }
        setVoiceError(why);
        throw new Error(why);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) audioRef.current = null;
        setPreviewing((cur) => (cur === id ? null : cur));
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setPreviewing((cur) => (cur === id ? null : cur));
      };
      await audio.play();
    } catch {
      setPreviewing(null);
    }
  };

  // Two catalogues, because the voice you can pick depends on whose key
  // pays for it. The CosyVoice entries carry no hand-written blurbs: the
  // official voice list is not machine-readable and inventing "知性女声 ·
  // 适合教学" for a voice nobody here has heard would be a made-up detail
  // that reads as verified. 试听 is the description.
  // 音色清单跟着已配置的 provider + 模型版本走。CosyVoice 的 v2 音色名
  // 放到 v3 上必然 418，MiniMax 的名字放到 CosyVoice 上同理。
  const activeMeta = llm?.tts_providers?.[llm?.tts_provider ?? ""];
  const cosyVoices =
    activeMeta?.voices_by_model?.[llm?.tts_model ?? ""]
    ?? activeMeta?.voices
    ?? llm?.tts_suggested_voices
    ?? [];
  const items: { id: string; title: string; sub: string; meta?: string }[] = onCosy
    ? cosyVoices.map((id) => ({ id, title: id, sub: "点右边试听" }))
    : VOICES.map((v) => ({
        id: v.id,
        title: v.name,
        sub: v.blurb,
        meta: `${v.accent} · ${v.gender}`,
      }));
  // 没配自己的 key、平台声音也没开 → 这些音色点了什么都不会变（BYOK 路径
  // 忽略 voice_id，平台路径又没 key）。列出来只会让人以为"试听坏了"，
  // 实际是选项本身是死的。
  const pickerUsable = onCosy || Boolean(llm?.tts_platform_available);
  const currentId = onCosy ? (llm?.tts_voice ?? "") : selected;

  return (
    <>
      <div className="text-2xs text-ink-3 mb-3">
        {onCosy ? (
          <>
            点 🔊 试听 · 选择会立即生效 · 音色名以{" "}
            <a
              className="text-brand hover:underline"
              href={activeMeta?.voice_list_url ?? llm?.tts_voice_list_url}
              target="_blank"
              rel="noreferrer"
            >
              {activeMeta?.label ?? "官方"}音色列表
            </a>{" "}
            为准，想用别的到上面「换音色」里填
          </>
        ) : (
          "点 🔊 试听 · 选择会立即生效 · 现在用的是平台声音。上面配好自己的 key 后，这里会换成对应服务的音色。"
        )}
      </div>
      {!pickerUsable && (
        <div className="text-xs text-ink-3 px-3 py-2 rounded-lg bg-[#f8faf8] border border-line">
          先在上面配一个朗读服务，这里才会列出可选音色。
        </div>
      )}
      {pickerUsable && voiceError && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-xs text-[#b91c1c]">
          {voiceError}
        </div>
      )}
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-2 ${pickerUsable ? "" : "hidden"}`}>
        {items.map((v) => {
          const isSelected = currentId === v.id;
          const isPreviewing = previewing === v.id;
          return (
            <label
              key={v.id}
              className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors duration-150 ease-spring ${
                isSelected
                  ? "border-brand bg-[#f4f9f6]"
                  : "border-line hover:border-[#c9dfd0] hover:bg-[#fffaf6]"
              }`}
            >
              <input
                type="radio"
                name="voice"
                checked={isSelected}
                disabled={saving !== null}
                onChange={() => void choose(v.id)}
                className="accent-brand"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <span className={onCosy ? "font-mono text-xs" : ""}>{v.title}</span>
                  {v.meta && (
                    <span className="text-2xs uppercase tracking-widest text-ink-3 font-medium">
                      {v.meta}
                    </span>
                  )}
                </div>
                <div className="text-2xs text-ink-3 mt-0.5">
                  {saving === v.id ? "保存中…" : v.sub}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  preview(v.id);
                }}
                className={`shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg transition-colors duration-150 ease-spring ${
                  isPreviewing
                    ? "bg-brand text-white"
                    : "text-ink-3 hover:text-brand hover:bg-[#eaf3ec]"
                }`}
                title={isPreviewing ? "停止试听" : "试听这个声音"}
                aria-label={isPreviewing ? "停止试听" : "试听"}
              >
                {isPreviewing ? (
                  <Square size={14} weight="fill" />
                ) : (
                  <SpeakerHigh size={15} />
                )}
              </button>
            </label>
          );
        })}
      </div>
    </>
  );
}

/**
 * 朗读用的 key，跟上面的对话 key 各管各的。
 *
 * 为什么单独一份 key 而不是复用上面那个：模型和声音是两家买的东西，学员完全
 * 可能只配其中一个。
 *
 * 支持哪几家由后端的 services/tts_providers.py 说了算，这里只按它返回的
 * 元信息渲染 —— 加第三家不用改这个文件。
 *
 * 为什么不是 fish.audio：它在国内被 DNS 污染，阿里云机器上 TCP 都建不起来。
 * MiniMax 国内节点 0.18s、百炼 0.15s，都实测过。
 *
 * 不填**不会**挡住任何功能 —— 浏览器自带的 Web Speech 照样念，只是没那么好听。
 * 所以这一段的语气是"可选升级"，跟上面那段"不配就用不了"是两回事。
 */
function TTSKeyRow({ data }: { data: LLMSettings }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState(data.tts_provider || "minimax");
  const meta = data.tts_providers?.[provider];
  const [model, setModel] = useState(data.tts_model || data.tts_default_model);
  const [voice, setVoice] = useState(data.tts_voice || data.tts_default_voice);
  const [groupId, setGroupId] = useState(data.tts_group_id || "");
  // 换 provider = 换一家的凭据，旧 key/音色一概不能沿用。
  const switching = data.tts_configured && provider !== data.tts_provider;
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);

  const apply = (next: LLMSettings) => qc.setQueryData(["me-llm"], next);
  const run = async (
    kind: "save" | "test" | "delete",
    fn: () => Promise<LLMSettings>,
    done: string,
  ) => {
    setBusy(kind);
    setError("");
    setOkMsg("");
    try {
      apply(await fn());
      setOkMsg(done);
      setEditing(false);
      setApiKey("");
    } catch (e) {
      setError(errorDetail(e, "操作失败，请重试"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>

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

      {data.tts_configured && !editing ? (
        <div className="space-y-2">
          <div className="text-xs text-ink-2">
            {data.tts_providers?.[data.tts_provider]?.label ?? data.tts_provider}
            {" · "}{data.tts_model} · 音色 <b className="text-ink">{data.tts_voice}</b> · key{" "}
            <span className="font-mono">{data.tts_key_mask}</span>
          </div>
          {data.tts_last_error && (
            <div className="text-xs text-[#b91c1c]">
              上次朗读失败：{data.tts_last_error}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-ghost"
              onClick={() => run("test", api.testTTSSettings, "声音可用")}
              disabled={busy !== null}
            >
              {busy === "test" ? "测试中..." : "测一下"}
            </button>
            <button className="btn-ghost" onClick={() => setEditing(true)} disabled={busy !== null}>
              换 key / 换音色
            </button>
            <button
              className="btn-ghost text-[#b91c1c]"
              onClick={() => run("delete", api.deleteTTSSettings, "已删除，恢复浏览器朗读")}
              disabled={busy !== null}
            >
              删除
            </button>
          </div>
        </div>
      ) : editing ? (
        <div className="space-y-3">
          {/* 选服务放第一位：它决定了下面每个字段的含义（key 去哪申请、
              有哪些音色、要不要 GroupId）。放在 key 输入框后面的话，用户
              先看到"百炼 API key"，会以为只能配百炼。 */}
          <label className="block">
            <span className="text-2xs text-ink-3 font-medium">朗读服务</span>
            <select
              className="input mt-1"
              value={provider}
              onChange={(e) => {
                const p = e.target.value;
                const m = data.tts_providers?.[p];
                setProvider(p);
                setModel(m?.default_model ?? "");
                setVoice(m?.default_voice ?? "");
                setGroupId("");
              }}
            >
              {Object.entries(data.tts_providers ?? {}).map(([id, m]) => (
                <option key={id} value={id}>{m.label}</option>
              ))}
            </select>
            {meta?.hint && (
              <span className="block text-2xs text-ink-3 mt-1.5">{meta.hint}</span>
            )}
          </label>
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
          >
            <BookOpen size={13} /> 如何获取 key?（带截图分步）
          </button>
          <label className="block">
            <span className="text-2xs text-ink-3 font-medium">
              {meta?.label ?? ""} API key
            </span>
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
              在{" "}
              <a
                className="text-brand hover:underline"
                href={meta?.key_url ?? data.tts_key_url}
                target="_blank"
                rel="noreferrer"
              >
                {meta?.label ?? "控制台"}
              </a>{" "}
              开通后拿一个。保存时会真的合成两个词来验证。
              {switching && "换服务必须填新 key —— 那是另一家的凭据。"}
            </span>
          </label>
          <label className="block">
            <span className="text-2xs text-ink-3 font-medium">模型版本</span>
            <select
              className="input mt-1"
              value={model}
              onChange={(e) => {
                const m = e.target.value;
                setModel(m);
                // 换模型必须换音色：v2 的名字放到 v3 上必然 418。
                setVoice((meta?.voices_by_model?.[m] ?? meta?.voices ?? [])[0] ?? "");
              }}
            >
              {(meta?.models ?? data.tts_models).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-2xs text-ink-3 font-medium">音色</span>
            <input
              className="input mt-1 font-mono"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              placeholder={meta?.default_voice ?? data.tts_default_voice}
              autoComplete="off"
              spellCheck={false}
              list="cosyvoice-voices"
            />
            <datalist id="cosyvoice-voices">
              {(meta?.voices_by_model?.[model] ?? meta?.voices ?? data.tts_suggested_voices).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            {/* 故意是可输入的：阿里加音色的速度比我们写死一份清单快，
                写错了保存时 provider 会自己报错，比我们猜哪些存在准。 */}
            <span className="block text-2xs text-ink-3 mt-1.5">
              不确定就用默认的。全部音色见{" "}
              <a
                className="text-brand hover:underline"
                href={meta?.voice_list_url ?? data.tts_voice_list_url}
                target="_blank"
                rel="noreferrer"
              >
                {meta?.label ?? "官方"}音色列表
              </a>
              。
            </span>
          </label>
          {meta?.needs_group_id && (
            <label className="block">
              <span className="text-2xs text-ink-3 font-medium">GroupId（可选）</span>
              <input
                className="input mt-1 font-mono"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                placeholder="在 MiniMax 账户信息页能查到"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="block text-2xs text-ink-3 mt-1.5">
                留空先试。如果报"用量上限"但你账户里有积分，多半就是缺它 ——
                积分挂在某个 Group 下，不带 GroupId 会算到别处。
              </span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary inline-flex items-center gap-1.5"
              onClick={() =>
                run(
                  "save",
                  () => api.saveTTSSettings({
                    provider, api_key: apiKey, voice, model, group_id: groupId,
                  }),
                  "声音已启用",
                )
              }
              disabled={busy !== null || !apiKey.trim()}
            >
              {busy === "save" ? (
                <>
                  <CircleNotch size={13} weight="bold" className="animate-spin" /> 验证中...
                </>
              ) : (
                "保存并验证"
              )}
            </button>
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
          </div>
        </div>
      ) : (
        <button
          className="btn-ghost inline-flex items-center gap-1.5"
          onClick={() => setEditing(true)}
        >
          <SpeakerHigh size={14} /> 配一个更自然的朗读声音
        </button>
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
