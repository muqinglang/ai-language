# AI 对话 tab · TTS

**改 `AITab`（在 `Learn.tsx` 里）、`backend/app/routers/ai.py`、`services/tts.py` 之前读这篇。**
这些接口花的是**学员自己的** API key，动之前先看 [BYOK.md](BYOK.md)。

## AI 对话 tab (`AITab` in `Learn.tsx`)

- **会话缓存**：`POST /api/ai/conversations` 是 get-or-create，同 episode 同用户的 active convo 直接返回；chunks 全用完自动归档 + 重建；手动 🔄 新场景 调 `POST /:id/reset`
- **AI 原文默认隐藏**（鼓励先听）：开场白（idx=0）例外永远可见；`revealedBubbles: Set<idx>` / `hiddenBubbles: Set<idx>` / 全局 `revealAllAI` 三路状态决定显示；点占位揭晓 / 点 🙈 收起 双向切换
- 🎤 语音输入：Web Speech `SpeechRecognition` (en-US, interim, **continuous=true**)，**不再自动发送**——`onend` 只保留 transcript，用户点 发送 触发；`sendStreaming` 开头 `recognition.stop()` 防 STT 在 draft 清空后再填回
- 输入框用 auto-grow `<textarea>`（2.5rem → 10rem），Enter 发送 / Shift+Enter 换行 / IME 组字期间不触发发送
- 🔊 每条 AI 气泡朗读（`ElevenLabs` 优先） + 🐢 慢读 (rate 0.7) + 场景卡 "AI 自动朗读" 开关（localStorage `ai-autospeak`）；用 ts 指纹避免重复朗读
- `speakText()` 路由：先 `fetch('/api/tts')` → `<audio>` 播放 → 任何失败（503/网络/解码）降级 Web Speech；`webSpeechOnly` opt-out 给 WordPopup 用
- 用户气泡内 target chunk 命中立刻绿色高亮；气泡色 `bg-[#fff2ec] text-ink + 桃色边`
- AI 气泡内每个词可点查词 → 复用 `WordPopup`（`sub` 改可选 + `context` 字符串；无 sub 时隐藏 🎬）
- 🇨🇳 气泡翻译按钮 → `POST /api/translate` (util_router, 复用 `translate_to_zh`)；结果 cache 在 AITab 本地 `translations` state
- **✏️ 逐条反馈**：`POST /ai/conversations/:id/messages/:idx/feedback` → `{praise, errors[], alternatives[], score 0-5}`；渲染成绿/黄/蓝三色 hint 的 `FeedbackCard`
- **💡 看参考答案**：最新 AI 消息底部按钮 → `POST /ai/conversations/:id/hint`；返回 1-3 句范例（强制用未用过的 chunks）
- **🎓 Teach-back**：`chunks_used / target_chunks ≥ 0.8` 时场景卡下方冒出；`GET /teachback/question` 拿提问，`POST /teachback/review` 评估答案（verdict / strengths / missed_points / suggestion）
- "↩ 重说" 按钮 → `DELETE /api/ai/conversations/:id/messages/last-turn`（剪掉最后一轮 + 重算 chunks_used）
- SSE 流式：`POST /api/ai/conversations/:id/messages/stream` 返回 `text/event-stream`，前端 `fetch + ReadableStream` 逐 token 渲染，终帧 `event: done` 带完整 convo；错误回退到同步 `sendMessage`
- **`ASSISTANT:` 前缀剥壳**：`_strip_role_prefix` 应用到 reply + 流式前 ~20 字符缓冲区，避免某些模型把 role label 写进 body
- **Session-per-stream**：SSE 端点的 LLM 生成器内部开新 `SessionLocal()` 做最后的 DB commit，不把外层 `Depends(get_db)` 的 session 卡在长连接里（避免连接池耗尽）。
- **428 不是报错**：没配 key 时接口返回 428，前端渲染 `NeedApiKey` 卡片（一个去 `/me#api-key` 的入口），不是红色报错框。「在视频里详细解释」弹窗同理（`AskError`）。

## TTS (`services/tts.py` + `/api/tts`)

`/api/tts` 依次尝试三种声音，前一种拿不到就往下走：

1. **学员自己的 CosyVoice**（阿里云百炼，`services/tts_cosyvoice.py`）—— 记在学员账上，国内可达，**不受 `TTS_DISABLED` 影响**（那个开关是拦平台花钱的）。失败 → 502 + 写 `tts_last_error`。
2. **平台的 ElevenLabs**（下面这段），受 `TTS_DISABLED` 和多 key 轮换控制。
3. **都没有 → 503**，浏览器用免费的 Web Speech 念。这是降级不是故障，所以这个接口**永远不 428**。

配置入口和取舍见 [BYOK.md](BYOK.md)。

### 平台侧 ElevenLabs

- ElevenLabs 代理；`synthesize(text, voice_id, model)` 走 `httpx.post` → mp3 bytes
- 磁盘缓存 `/app/media/tts/{sha256(text+voice+model)}.mp3`；hit ~13ms，miss ~1.2s
- Env: `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`（默认 Alice = Xb7hH8MSUJpSbSDYk0k2，免费档可用）/ `ELEVENLABS_MODEL`（默认 `eleven_turbo_v2_5`）
- 未配 key 时 `/api/tts` 返回 503，前端 `speakText` 透明降级 Web Speech
- **TTS 分层路由**：AI 气泡走 ElevenLabs HD（学习核心，值回票价）；WordPopup 单词点击走 Web Speech（高频低价值，省钱）。实现方式是 `speakText(..., { webSpeechOnly: true })` opt-out flag。
- ElevenLabs 免费档只能用 21 个 premade 声音（Rachel 等 library voice 需付费）；voice library 变化可能使老 voice_id 失效 → 观察到 402/422 时去 `/v1/voices` 列当前账号可用列表。

### iOS Safari 首次 AI 朗读可能要点两下

生产环境 `TTS_DISABLED=true` → `/api/tts` 始终 503 → 前端 fallback 到 Web Speech。iOS 要求 `speechSynthesis.speak()` 在 live user-gesture 上下文里，但 fetch 回到 `.catch` 时 gesture 已失活。`Learn.tsx` 里有粘性 `_ttsServerDisabled` flag：第一次 503 后记下来，后续 `speakText` 同步走 Web Speech（保住点击 gesture），从第二次起朗读稳定。`interact()` 里也 prime 了一次零音量 utterance 解锁 iOS 的 speechSynthesis。自动朗读（AI 回复后自动念）在 iOS 上做不了——浏览器硬性限制。如果将来加后端 `/api/config` 暴露 `tts_disabled`，前端加载时就短路掉首次 fetch，可以把"第一次要点两下"这点也消掉。
