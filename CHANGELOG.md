# Changelog

本文档记录对用户或开发者有显著影响的改动。按倒序排列。

## 2026-04 迭代 (F 轮)：K8s 生产部署 + 远程 YouTube 导入

把项目从"本地 docker compose"推到"Vultr VKE Tokyo 集群 + GitHub Actions push-main 自动部署"，顺带让 pipeline 在境外 DC IP 下真能导 YouTube。踩坑密度很高。

### 🚀 部署基础设施

- **K8s manifests (`k8s/`)**：Vultr VKE Tokyo + ingress-nginx + cert-manager。API + web 单 pod 双容器（共享 RWO PVC 存视频），postgres 独立 StatefulSet
- **GitHub Actions 部署流水线 (`.github/workflows/deploy.yml`)**：push main → self-hosted Tokyo runner build → 推 Vultr CR → `kubectl apply` → `rollout status`
- **自托管 Tokyo runner**：和集群同机房网络，build+deploy 从 ~8min 降到 ~5min；Mac 这端绕 6443 GFW 也能 ssh 上去 `kubectl` 调试

### 🛡️ 远程 YouTube 导入稳定性

- **CANNED_SUBS 假 fallback 修掉**：之前 yt-dlp 元数据 + 下载都挂时 pipeline 会静默用演示字幕 + 空 `video_url` 建 episode，前端显示"视频文件未提供"+假内容。现在硬 fail：没视频 raise `"片段下载失败（...）"`，没字幕 raise `"无法获取字幕（...）"`
- **YouTube cookies 支持 (`pipeline.py` + `k8s/app.yaml`)**：DC IP 会被 YouTube 挑 "Sign in to confirm you're not a bot"。`_yt_cookiefile()` 读 `YT_COOKIES_PATH`（默认 `/app/secrets/yt-cookies.txt`，k8s secret 挂载），先拷到 `/tmp`（yt-dlp 要写回刷新的 session token，secret mount 是只读 tmpfs）
- **`scripts/refresh-yt-cookies.sh`**：一键轮换 cookies。关 Chrome → 跑脚本 → 从本地 Chrome export + self-test + scp + k8s create secret + rollout restart + pod-side verify，6 步全自动。YouTube cookies 20-30 天过期一次，跑一次即可
- **Dockerfile 装 deno** + pipeline `remote_components: {"ejs:github"}`：YouTube 视频 URL 有 JS `n` 签名挑战，没 JS runtime 只能拿到 storyboard 图片。两件齐了 yt-dlp 才能拿到真媒体 URL

### 🐛 修复

- **Postgres env-order**：`DATABASE_URL` 用 `$(POSTGRES_PASSWORD)` 替换，k8s 只对前向声明的变量做替换，所以必须 POSTGRES_PASSWORD 排在前面
- **Nginx sidecar upstream**：docker-compose 里 nginx 反代 `api` 服务名，k8s pod 里 DNS 不存在。ConfigMap 覆盖 `default.conf`，upstream 改 `127.0.0.1`（同 pod sidecar 共享 netns）
- **SEED_DEMO 开关**：生产部署默认不塞假 RGB-bars 示例视频

## 2026-04 迭代 (E 轮)：学习中心化 + 响应式/移动端

这一批把产品从"桌面 Web 站"推成"随便拿什么设备都能用的真正学习工具"。核心两件事：一是把学习材料（生词 / Chunk / 视频收藏 / 金句收藏）按"参考回看"和"主动练"两类重新组织到 `/favorites` + `/library`；二是把全站从桌面 grid 改成响应式，手机和 iPad 原生可用。

### ✨ 新功能

- **学习本 `/library`**
  - 生词 + Chunk 合一页，两个 tab；顶部"今日复习 N 个"CTA 直接进 SM-2 闪卡 session
  - Chunk 入口来自 Learn 页面每条 chunk 的 `+ 学习本` 按钮（写进 `/api/favorites` target_type=chunk）
  - 老路径 `/vocabulary` 和 `/words` 自动 `<Navigate>` 过来
  - 完成复习后落 PartyPopper 完成屏，鼓励点回学习本继续下一轮

- **Creators 博主频道**
  - `GET /api/creators` 列表 + `GET /api/creators/:id` 单页（带该博主全部 episode + top topic）
  - Pipeline stage 5 `get-or-create` Speaker：先按 `channel_id`，fallback 名字匹配，都没有就新建。老数据在名字匹配时 backfill `channel_id`。
  - 前端：`/creators` 列表卡 + `/creators/:id` Hub + Catalog 页"博主"筛选 chip（客户端过滤，小数据集够用）

- **Featured Words tab（Learn 页右栏第三 tab）**
  - `backend/app/models/word.py` 存每集 candidate words；`GET /api/episodes/:id/words/featured` 返 8-12 条
  - 卡片展示 def + example + 原片上下文 + `+ 学习本` / ✕ 忽略；本地 Set 跟踪 savedIds / dismissedIds 避免重复

- **响应式适配 — 手机 + iPad**
  - Shell 80px 侧边栏在 `< md (768px)` 切成底部 fixed 5-tab bar + 紧凑顶栏；iPhone notch / home indicator 用 `env(safe-area-inset-*)` 避让
  - `index.html` 加 `viewport-fit=cover` + `apple-mobile-web-app-capable` + `theme-color` meta
  - 内容网格自适应：Home / Catalog 的 episode 卡从 `grid-cols-5` → 2→3→4→5 随断点递增
  - iPad（768-1024）继续走桌面布局 + 左右分栏；修掉 Introduction 与 AI 卡之间的大段空白（显式 `md:grid-rows-[auto_1fr]`）

- **Learn 手机 5 tab + 视口锁死**
  - 手机上扁平 5 tab：字幕 / Chunks / Words / AI / 笔记；顶部 shrink-0 视频块，下方 flex-1 的 active tab 独占
  - 外层 `h-[calc(100dvh-160px)]`，页面本身不滚动，只有 tab 内部 overflow-auto。视频不靠 sticky 也能一直在顶（因为页面不动）
  - iOS Safari 地址栏弹出弹入用 `dvh` 稳住

- **Catalog 手机 bottom sheet 筛选**
  - 进页面只看见 `[筛选·N] [排序·最新 ▾]` 两个入口，不再被 50+ 个 chip 淹没
  - 点"筛选"从底部滑出 sheet，含全部 5 维（话题/格式/博主/难度/口音），底部有"清除全部 / 查看 N 个结果"双按钮
  - 桌面保留原来展开卡不变

- **per-page 搜索作用域**
  - Shell 加 `hideSearch` prop；只有"发现"保留全局搜索（搜字幕/chunk/episode），"收藏"改成页内 local search（只过滤用户自己的收藏数据）
  - 首页/学习本/我的/Learn/Creators 都不再顶一个空搜索条

- **首页学习驱动化**
  - "今日任务"卡：连续打卡徽章 + 待复习词数 + "继续「X 视频」"CTA + 进度 bar
  - "专注一个话题"chip 栏（narrow listening 引导）
  - 多轨 feed：继续学习 / AI 精选 / 编辑私藏，按 id 去重避免冷启动时三轨同内容
  - 早/中/晚/深夜动态问候

- **Me 页学习热图 + KPI**
  - GitHub 式 12 周贡献日历（`GET /api/me/heatmap`），颜色梯度 5 级
  - 5 个核心 KPI 卡：学过视频 / 已完成 / 生词本 / 掌握 Chunks / AI 对话
  - 成就徽章行：连续 X 天 / 学过 Y 视频 / 掌握 Z 词

- **收藏 `/favorites` 本地搜索**
  - 页内搜索框只过滤当前用户的收藏（title / text_en / text_zh / episode_title），不再跳转全站搜索
  - Tab 切换时 placeholder 跟着变（搜收藏的视频 / 搜收藏的句子）

### 🎨 视觉重做

- **全站切 Lucide 图标库**：emoji 从导航、操作按钮、列表全部清掉，统一 `strokeWidth={1.75}`，视觉密度立刻降一档
- **EpisodeCard**：左上角 topic 徽章 + 右上角时长标、Play 悬浮态、summary_zh 三行 line-clamp
- **字幕行 hover-only 行内工具**：🔁 循环 / 🎤 跟读 / 📝 笔记 / ⭐ 收藏 默认隐藏，hover 才出现，减少视觉噪音
- **subtitle mode 重排 + 加"纯听"**：英文 / 双语 / 中文 / 挖空 / 听写 / 纯听
- **End-of-episode recap**：最后一条字幕下方出现本集总结 + chunks 使用率 + "下一集"推荐

### 🐛 修复

- **iPad Introduction ↔ AI 卡之间大段空白**：左列 2 行在右列 subtitle 卡 spanning 时不会自动拉伸。改用显式 `md:grid-rows-[auto_minmax(440px,1fr)] md:h-[calc(100vh-96px)]`，row 2 是 1fr 吃掉剩余空间。
- **手机 Learn 视频被字幕挤走**：sticky 元素会在 containing block 离开视口时跟着走（CSS spec）。改用视口锁死 + 内部 overflow 后视频不需要 sticky 也稳。
- **Creator 老数据全部匿名**：pipeline 从来没有创建 Speaker 行。stage 5 加了 get-or-create by channel_id，新导入的视频会自动绑博主。

### 相关文件

| 功能 | 主要文件 |
|---|---|
| 学习本统一页 | `frontend/src/pages/Library.tsx`, `App.tsx` (redirects) |
| Creators | `backend/app/routers/creators.py`, `frontend/src/pages/Creators.tsx`, `CreatorHub.tsx` |
| Featured Words | `backend/app/models/word.py`, `backend/app/routers/words.py`, `frontend/src/pages/Learn.tsx` (FeaturedWordsPanel) |
| 响应式 Shell | `frontend/src/components/Shell.tsx`, `frontend/index.html` |
| Learn 手机布局 | `frontend/src/pages/Learn.tsx` (mobileView state, h-calc dvh) |
| Catalog bottom sheet | `frontend/src/pages/Catalog.tsx` |
| Me 热图 | `backend/app/routers/user_data.py`, `frontend/src/pages/Me.tsx` (Heatmap) |
| Speaker auto-bind | `backend/app/services/pipeline.py` (stage 5) |


## 2026-04 迭代 (D 轮)：真实课堂化 + 话题学习路径 + ElevenLabs + 反馈闭环

这一批把产品从"能用"推到"真·适合每天用"。围绕**学习原则**（narrow listening · 先听后看 · 即时反馈 · 间隔重复 · 费曼回述）重做了 AI 对话面板、生词本、跟读训练和视频目录四大块。

### ✨ 新功能

- **话题系统（narrow listening）**
  - Episode 新增 `topic` 字段，独立于 `category`（视频格式），两轴正交。17 个 topic（AI / 商业 / 投资 / 职场 / 日常 / 旅行 / 美食 / 健康 / 心理 / 科学 / 教育 / 影视 / 时尚 / 体育 / 户外 / 阅读 / 其他），10 个 category（演讲 / 访谈 / vlog / 教程 / **知识博主** / 新闻 / 纪录片 / 评测 / 喜剧 / 其他）
  - Pipeline stage 5 自动调 `llm.classify_episode` 按视频标题+摘要归类
  - Home 页顶部 "专注一个话题" chip 栏；Catalog 页五维过滤；episode 卡左上角 topic 徽章
  - 生词本可按话题过滤（narrow 学习的闭环：同话题词汇反复出现 → 记得更牢）

- **AI 对话面板：从"能聊"到"像课堂"**
  - **会话缓存 + 🔄 新场景**：`start_conversation` 改 get-or-create，重进不烧 token。chunks 全用完自动归档 + 重起；用户可手动点 🔄 重开新场景
  - **AI 原文默认隐藏**（鼓励先听）+ 🔊 点击揭晓 + 🙈 收起（双向切换）。开场白例外永远可见。全局 "显示 AI 原文" toggle（localStorage 持久化）
  - **✏️ 逐条反馈**：用户消息下方可触发 `POST /api/ai/conversations/:id/messages/:idx/feedback`，LLM 返回 `{praise, errors[original,suggestion,why], alternatives, score 0-5}` 并渲染成带 ●●●○○ 打分的反馈卡
  - **💡 看参考答案**：最新 AI 消息下可获取"如果一个地道学习者会怎么答"的 1-3 句范例，强制使用未用过的 target chunks
  - **🎓 Teach-back (费曼)**：`chunks_used ≥ 80%` 触发，AI 让学习者"用自己的话讲给朋友听"，提交答案后 LLM 评估 verdict / strengths / missed_points / suggestion
  - **↩ 重说**：`DELETE /api/ai/conversations/:id/messages/last-turn` 剪掉最后一轮 + 重算 chunks_used
  - **用户输入从 `<input>` 换成 auto-grow `<textarea>`**：长 transcript 不再被截断；Enter 发送、Shift+Enter 换行、IME 组字时不误触
  - **麦克风手动停止**：`continuous=true` + `onend` 不再自动发送；点 ⏹ 结束才留 transcript 给用户审查
  - **发送时自动停止录音**：`sendStreaming` 开头先 `recognition.stop()`，避免 STT 在 draft 清空后再往回填
  - **用户气泡柔和化**：从 `bg-brand text-white` 改为 `bg-[#fff2ec] text-ink + 桃色细边`，不再抢 chunk 命中绿色的视觉

- **ElevenLabs HD TTS**
  - 新端点 `POST /api/tts`，后端代理 ElevenLabs `eleven_turbo_v2_5`，默认声音 **Alice — Clear, Engaging Educator**（免费档可用的 premade voice）
  - 磁盘缓存 `/app/media/tts/{sha256}.mp3`，同文本重播零花费。首次 ~1.2s，命中缓存 ~13ms
  - 前端 `speakText()`：先打 `/api/tts` → 浏览器 `<audio>` 播放，任何错误（503 / 网络 / 解码）自动降级 Web Speech。AI 气泡 🔊 朗读 / 🐢 慢读 / AI 自动朗读 全走这条路径
  - **WordPopup 单词朗读保留 Web Speech**（高频低价值场景，省钱）——新的 `webSpeechOnly` flag 控制
  - 环境变量：`ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` + `ELEVENLABS_MODEL`（docker-compose 已加透传）

- **生词本 SM-2-lite 间隔重复**
  - `Vocabulary` 表新增 `next_review_at` / `last_reviewed_at` / `review_count` / **`ipa`** 四列
  - 新端点 `GET /api/vocabulary/due?limit=` 拿今日待复习，`POST /api/vocabulary/:id/review {remembered:bool}` 记得/忘了调度下次
  - 间隔（天）：mastery 0→0d, 1→1d, 2→3d, 3→永久掌握出队
  - `/vocabulary` 页加"📚 今日复习 N 个"卡片 + 闪卡 UI（翻面看释义 + 记得/忘了），完成后回统计屏

- **单词查询加 US IPA 音标**
  - `lookup_word` LLM prompt 要求返回 `ipa`（US General American，斜杠包裹）
  - WordPopup / VocabCard / 闪卡正面三处都渲染音标
  - 懒补齐：老词 `ipa=""` 不显示，重查时自动补全

- **跟读练习升级**
  - **实时 STT 识别字幕**：`SpeechRecognition` 与 `MediaRecorder` 共用同一 mic 流，录音过程中"识别结果"卡片实时更新，学习者能看见自己把 `light` 读成 `night`
  - **默认隐藏原文**（shadow-first 教学）：顶部占位 "🔊 专注听原音再跟读 · 录完可对照识别结果"，点 👁 才揭晓
  - localStorage `shadow-reveal-text` 持久化

- **视频卡片加中文简介**
  - `Episode.summary_zh` 通过 `@property` 从 `ai_metadata` 读出；`EpisodeCard` Pydantic 暴露该字段
  - Home / Catalog 的 episode 卡标题下方多一段 3 行 line-clamp 的中文简介
  - Learn 页 **移除"介绍"tab**（内容已移到卡片），只保留 AI 对话 + 笔记

### 🐛 修复

- **字幕覆盖不全（ep 47 / ep 39）**：VTT `<c>` 标签只覆盖 clip 前段 → 后半段无字幕。新 `_hybrid_subtitle_split`：word-timing 句子切分作头部 + yt_subs cue 句子合并作尾部，覆盖率 <85% 自动启用。覆盖率 <70% 打 warning log
- **翻译把问题当问题答**：`_TRANSLATE_SYS` 加 "Your ONLY job is to translate" + 三引号包输入 + 路由 OpenAI 优先，修复 "What is a Harness Engineer?" 被答题的 bug
- **`ASSISTANT:` 前缀泄漏**：`_reply_prompt` 用中性 A/B 标签 + 返回值正则剥壳 `^(AI|ASSISTANT|A|BOT):`；流式版本用缓冲前 ~20 字符再剥，避免 token 边界问题

### 相关文件

| 新/核心文件 | 作用 |
|---|---|
| `backend/app/services/topics.py` | 17 topics + 10 categories 单一真相源 |
| `backend/app/services/tts.py` | ElevenLabs 代理 + 磁盘缓存 |
| `backend/app/services/llm.py` | `_chat_conversation` 路由 + feedback / hint / teachback / classify + `_strip_role_prefix` |
| `backend/app/routers/ai.py` | 流式 + 重说 + 反馈 + 提示 + teach-back + 重置端点 |
| `backend/app/routers/vocabulary.py` | SM-2 调度 + IPA |
| `frontend/src/pages/Learn.tsx` | AITab 整套升级（~800 行新逻辑） |
| `frontend/src/components/SentenceRecorder.tsx` | STT + 默认隐藏 |
| `frontend/src/pages/Vocabulary.tsx` | 闪卡 review session |
| `frontend/src/pages/Home.tsx`, `Catalog.tsx`, `components/EpisodeCard.tsx` | topic UI + 卡片简介 |


## 2026-04 迭代 (C 轮)：AI 对话质量升级

用户反馈 DeepSeek 回复生硬 + TTS 嗓音机械；这一轮做了两件核心事：换对话模型、挑更好的 TTS 嗓音，再加三项学习者诉求。

### ✨ 新功能 / 变更

- **对话 LLM 按任务路由（OpenAI gpt-4o-mini 优先）**
  - `reply` / `reply_stream` 新增 `_chat_conversation` 路径：先 OpenAI 后 DeepSeek 后 Claude
  - 其余调用（chunk / translate / scenario / word lookup）保留 DeepSeek-first，保住 pipeline 成本
  - 单轮回复 ~$0.0002，生硬感 & 格式泄漏问题明显消失
  - 需配置 `OPENAI_API_KEY`（`.env` 里，docker-compose `environment:` 已经带了透传）

- **TTS 嗓音自动挑最好的（A1 免费方案）**
  - `pickBestVoice()` 走 `speechSynthesis.getVoices()` 按优先级挑：Google US/UK English (Chrome) → Microsoft Jenny/Aria/Guy Online (Natural) (Edge) → Samantha/Karen (macOS) → 第一个 en-US
  - 在 `voiceschanged` 事件触发时重算；`speakText` 和 `WordPopup.speakTTS` 共用
  - 依赖浏览器/系统装的嗓音，macOS 用户可去 设置 › 辅助功能 › 朗读 下载 Ava Premium / Allison / Samantha (Enhanced) 得到明显提升

- **🇨🇳 气泡翻译按钮**
  - 新 `POST /api/translate` 端点复用 `llm.translate_to_zh`
  - 每条 AI 气泡下 "🇨🇳 翻译"，结果缓存在 `translations: Record<idx, zh>`，再点展开/折叠而非重复调用
  - 译文在原气泡下以灰底小卡展示，不挤占主气泡

- **AI 气泡内单词可点**
  - `clickableWordsInText` 把 AI 回复 tokenize 成可点 span，复用 `WordPopup`
  - `WordPopup` 签名增加 `context?: string`、`sub` 改为可选；没 sub 时自动隐藏 🎬 "在原片中听"
  - "加入生词本" 在 AI 气泡场景下 `context_subtitle_id = null`、`context_text = 整条 AI 消息`

- **🐢 慢读按钮**
  - `speakText` 签名变为 `(text, { rate?, onEnd? })`；慢读直接 `speakText(text, { rate: 0.7 })`
  - 每条 AI 气泡并排 🔊 朗读 / 🐢 慢读

### 相关文件

| 功能 | 文件 |
|---|---|
| OpenAI 路由 + 流式 | `backend/app/services/llm.py` (`_chat_conversation`, `_stream_openai_compat`) |
| 翻译端点 | `backend/app/routers/ai.py` (`util_router`), `backend/app/main.py` |
| 前端气泡交互 | `frontend/src/pages/Learn.tsx` (`pickBestVoice`, `clickableWordsInText`, AITab 内 `translations` / `wordPopup`) |
| 客户端 | `frontend/src/lib/api.ts` (`translate`) |

### 回退策略

- OpenAI 断流 / 限流 → llm 层自动落到 DeepSeek；都挂了再用 stub
- 想完全关 OpenAI：只要 `.env` 里清空 `OPENAI_API_KEY` 即可，不用改代码


## 2026-04 迭代 (B 轮)：AI 对话语音化

学习者之前只能在 AI 对话里打字，本轮加入"能开口"相关的五项升级（方案 B），零新依赖。

### ✨ 新功能

- **① 🎤 语音输入（浏览器原生 `SpeechRecognition`）**
  - 输入框左侧 🎤 按钮，按下即可英文识别；实时 interim 结果在 draft 里滚动展示
  - 停止后自动发送 final transcript；用户在按 ⏹ 之前可以打断、编辑草稿
  - 不支持 Web Speech 的浏览器给明确提示（Chrome/Edge 可用）

- **② 🔊 气泡朗读 + 自动朗读开关**
  - 每条 AI 气泡下方 "🔊 朗读" 按钮，走 `SpeechSynthesisUtterance` (en-US, rate 0.95)
  - 场景卡右上角 "AI 自动朗读" 勾选框，localStorage 持久化；开启时新到的 AI 消息自动朗读
  - 用 `ts` 指纹去重，切 tab 回来不会重朗读历史

- **③ Chunk 命中即时高亮（用户气泡内）**
  - 用户发言里出现的 target chunk 文本立刻绿色高亮（`bg-[#16a070] text-white`），longest-first 匹配
  - 不等 AI 回复的 "echo back"，学习者第一眼就能看到"我用上了这个短语"

- **④ ↩ 重说最近一轮**
  - 最后一条用户气泡下出现 "↩ 重说" 按钮
  - 后端新增 `DELETE /api/ai/conversations/:id/messages/last-turn`：剪掉最后的 user+assistant 对，按剩余历史重算 `chunks_used`

- **⑤ SSE 流式回复**
  - 后端 `llm.reply_stream()`：DeepSeek `stream=True` 逐 token 产出，失败回退到非流式 `reply()` 当作一整块 yield
  - 新端点 `POST /api/ai/conversations/:id/messages/stream` 用 `StreamingResponse` 发送 `text/event-stream`；终帧 `event: done` 带上完整 convo JSON
  - 前端用 `fetch + ReadableStream`（`EventSource` 不支持 POST+Bearer），实时渲染打字光标气泡；错误自动降级到同步 `sendMessage`
  - DB commit 在 generator 内开新 session 完成，不把外层 session 卡在长连接上

### 相关文件

| 功能 | 文件 |
|---|---|
| 流式 LLM | `backend/app/services/llm.py` (`reply_stream`, `_reply_prompt`) |
| 流式 & 撤回端点 | `backend/app/routers/ai.py` |
| 前端对话 UI | `frontend/src/pages/Learn.tsx` (`AITab`, `highlightChunksInText`, `speakText`, `getSpeechRecognition`) |
| 流式客户端 | `frontend/src/lib/api.ts` (`sendMessageStream`, `redoLastTurn`) |

### 待 real-user 验证

- Chrome/Edge 真机麦克风对短英文句子的识别准确度
- DeepSeek `stream=True` 在网络抖动下的稳定性（已带回退）
- Safari 的 SSE 长连接行为（nginx 已带 `X-Accel-Buffering: no`）


## 2026-04 迭代：字幕质量 + 生词本 + 跟读录音 + 发音

### ✨ 新功能

- **生词本 (`/vocabulary`)**
  - 字幕里点击任一英文词 → `WordPopup` 弹窗：LLM 给出 CEFR-B1 英文定义 + 中文释义 + 例句
  - 一键加入生词本，按 mastery 0-3 分类管理（0 待学 → 3 已掌握）
  - Learn 字幕行内：已收藏且 mastery<3 的词会自动变成蓝色高亮，让用户看到"这词我标过"
  - 路由：`GET/POST/PATCH/DELETE /api/vocabulary`，`POST /api/words/lookup` 仅查询不落库

- **词级发音**
  - `WordPopup` 加了两个按钮：🔊 Web Speech API TTS（en-US，rate 0.9）+ 🎬 在原片中定位播放（700ms 自动暂停）
  - 🎬 使用 `word_timings` 选离当前播放位置最近的一次出现，解决一行里同一词多次出现的歧义
  - 🔊 给干净的教科书式发音；🎬 给口语/连读的真实发音

- **句子级跟读录音 (`SentenceRecorder.tsx`)**
  - 字幕行 🎤 按钮唤起：MediaRecorder 录麦克风 + AudioContext 解码原视频音频并切片
  - 双 Canvas 波形对比（原音 #64748b 灰 vs 用户 #f97316 橙），便于自查节奏/重音
  - 原音 buffer 以 videoUrl 为 key 做模块级缓存，同一集换句练习不重复解码

- **字幕行高亮渲染升级**
  - 新 `renderRichSubtitle()`：chunk 按类型着色 + 收藏生词蓝色 + 每词可点，三层叠加
  - chunk 优先级高于生词（chunk 内的词用 chunk 颜色）；外围包层 `<b>` 后内部 span 仍可点击查询
  - 四色 chunk 配色：`chunk-1 #ffe28a` (amber, idiomatic/cultural) · `chunk-2 #b8d1ff` (sky, collocation) · `chunk-3 #b3ecc7` (mint, discourse) · `chunk-4 #d9c1ff` (lavender, functional)

### 🐛 修复

- **字幕/音频对齐**
  - YouTube VTT 每个 cue 有两行（上下文 + 新词），之前合并导致字幕"超前"一句；改为只取带 `<c>` 时间标记的新词行
  - Pipeline 过滤字幕用 `s[0] >= seg_start_ms`（起点法），避免跨边界字幕漏进来
  - 开头 padding 从旧值改为 0s，结尾保留 2s，解决 clip 开头字幕滞后

- **字幕切分**（`pipeline.py`）
  - 从"按 VTT cue 原样保留"改为"按 word_timings 在 `.!?` 处切句"，使一行 = 一句自然语义
  - 超长 run 的断点优先级：逗号 > 连接词（because/where/which/that/but/and/so）> 硬切，且要求 `_MIN_SPLIT_PRE_WORDS=10` 避免切得太碎
  - 配合跟读录音：一行=一句，录音内容不再是 "next action. Open claw... And this autonomous" 的碎片

- **双语翻译对齐**
  - 先整体翻译再按句切分（之前是先切再逐行翻，导致专有名词上下文丢失）
  - `_translate_to_zh` prompt 里加了明确 ASR 纠错：`GPD→GPT`、`entropic→Anthropic`、`open claw→OpenClaude`、`cloud codes→Claude Code`
  - 修复过去 `GPD 5.2 → GPT-4` 这类误翻

- **单句循环**
  - 之前每次 activeSub 变化都重置循环锚点，表现为"抖动 + 吞掉用户点击"
  - 改为开启循环时 `loopTargetRef` 锁定一次，监听 `currentMs ≥ target.end_ms` 触发 rewind
  - `seekToSubtitle` 里更新 loop target，让 J/K 切行与循环兼容

### 🎨 视觉

- Chunk 配色全面提亮（#fff1d6 等薄雾灰 → #ffe28a 等明亮色），在保持黑字可读性同时更醒目
- 播放中的 active 行不再叠加橙色 phrase-highlight（原本和行底色 `#fff6f2` 打架），改为只靠行底色 + chunk/vocab inline 色块传达信息

### 📚 相关文件

| 功能 | 主要文件 |
|---|---|
| 字幕切分/翻译 | `backend/app/services/pipeline.py` |
| 词典查询 | `backend/app/services/llm.py` (`lookup_word`) |
| 生词本路由 | `backend/app/routers/vocabulary.py`、`backend/app/models/progress.py` |
| 字幕渲染 + popup | `frontend/src/pages/Learn.tsx` (`renderRichSubtitle`, `WordPopup`) |
| 跟读录音 | `frontend/src/components/SentenceRecorder.tsx` |
| 生词本 UI | `frontend/src/pages/Vocabulary.tsx` |
| Chunk 配色 | `frontend/tailwind.config.js` |

### ⚠️ 前端发布流程提醒

所有前端改动需要：

```bash
docker compose build web && docker compose up -d web
```

后端代码 bind-mount，`docker restart justspeak-api` 即可生效。
