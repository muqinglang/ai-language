# Learn 页面 · Shell 导航 · 卡片

**改 `frontend/src/pages/Learn.tsx`（AI 对话 tab 除外）、`Shell.tsx`、`EpisodeCard` 之前读这篇。**
AI 对话 tab 单独在 [AI_CHAT.md](AI_CHAT.md)。

## Learn 页面 (`Learn.tsx`)

响应式双布局，同一份 state 驱动两种呈现：

**桌面 (md ≥ 768px)** — 显式 CSS grid `grid-cols-[1fr_1.1fr] grid-rows-[auto_minmax(440px,1fr)]`，三个区块：
- 左上 (col 1, row 1)：视频 + AI 选段/单句循环 meta 条 + Introduction 折叠卡
- 左下 (col 1, row 2)：AI 对话 / 笔记 两 tab
- 右侧 (col 2, row 1-2, span 2)：字幕 / Chunks / Words 三 tab，全高

**手机 (< md)** — 视口锁死 `h-[calc(100dvh-160px)]`，不让页面整体滚动：
- 顶部 shrink-0 块：视频 + AI 选段条 + **5 个扁平 tab (字幕 | Chunks | Words | AI | 笔记)**
- 下方 flex-1 块：当前激活 tab 独占，内部自己 overflow-auto
- 视频因此不需要 sticky — 页面不滚，视频自然在顶
- mobileView state 同步驱动 rightTab（subs/chunks/words）或 tab（ai/notes）
- `md:hidden` / `hidden md:flex` 控制两种层级 tab bar 的可见性

**其他通用逻辑**：
- 字幕行 inline rendering（`renderRichSubtitle`）：chunk 按类型着色（amber/sky/mint/lavender）+ 已收藏生词蓝色高亮 + 每个词可点击查询
- 字幕 tab 6 种模式：英文 / 双语 / 中文 / 挖空 / 听写 / 纯听
- Chunks tab：可展开列表，显示解释/场景/相似表达/发音提示/文中例句；每个 chunk 有 `+ 学习本` 按钮写进 `/api/favorites` target_type=chunk
- Words tab：从 `/api/episodes/:id/words/featured` 取 8-12 个推荐词，信息卡展示 def + example + 原片上下文；有 savedIds/dismissedIds 两个 Set 管单卡状态
- 单句循环：点击 🔁 锁定当前句 loopTargetRef，监听 currentMs 到 end_ms 时 rewind；切行会顺带更新 target
- 跟读录音 🎤：MediaRecorder + AudioContext 切原音切片，Canvas 画原音 + 用户声音波形对比（`SentenceRecorder.tsx`）；同一 mic stream 同时跑 SpeechRecognition，实时显示"识别结果"；默认隐藏原文，点 👁 才揭晓（`localStorage.shadow-reveal-text`）
- 生词查询弹窗 `WordPopup`：LLM 定义（CEFR-B1） + US IPA 音标 + 🔊 Web Speech TTS（`webSpeechOnly=true`，省钱）+ 🎬 在原片中定位播放（按 `word_timings` 取离 currentMs 最近的一次）+ 加入生词本
- 键盘快捷键：Space 播放暂停、J/K 上下句、L 循环、R 重播
- **Chunk 配色**：`tailwind.config.js` 里 `chunk-1..4` 四色（amber/sky/mint/lavender），对应 idiomatic/collocation/discourse/functional；cultural 复用 chunk-1。生词本高亮独占 blue-50/700 不与 chunk 冲突。

## 视频卡片展示

- `EpisodeCard` Pydantic 暴露 `summary_zh`，源自 `Episode.summary_zh` @property → `ai_metadata.summary_zh`
- Home / Catalog 的 `EpisodeCardView` 标题下方渲染 3 行 line-clamp 中文简介；左上角 topic 徽章（`TOPIC_META` inline 映射，避免额外请求）

## 响应式 Shell + 导航

- `Shell.tsx` 是所有页面（除 `/admin`）的外框。桌面 80px 侧边栏；手机 `md:hidden` 切底部 fixed 5-tab bar（首页/发现/学习本/收藏/我的）+ 紧凑顶栏
- `hideSearch` prop 控制搜索条可见性。仅 `/catalog`（全局搜索）和 `/favorites`（页内本地搜索）保留；其他页面都传 `hideSearch` 收掉空间
- `/favorites` 页自己有一个 input 只过滤当前用户的收藏（title / text_en / text_zh / episode_title）
- iPhone 安全区用 `pb-[env(safe-area-inset-bottom)]` + `index.html` 里的 `viewport-fit=cover`
- 手机 Catalog 的 5 维筛选收到 bottom sheet：顶部只显示 `[筛选·N] [排序·最新 ▾]` + 视频网格；点 `筛选` 从底部弹出 sheet，里面 chip 行 + "清除全部 / 查看 N 个结果" 双按钮
- **手机/平板上 admin 也走前台**（`lib/device.ts`）：admin 账号在手机上登录会直接进 `/admin`，而后台是给桌面用的（密集表格、导入流程要驱动本机 yt-dlp），结果是前台功能完全够不着。`isHandheld()` 同时看指针类型和宽度 —— 单看宽度分不出 iPad Pro 和笔记本，单看指针分不出触屏笔记本和平板：粗指针（手指）≤1440px，或任意 ≤1024px 的窗口。判定放在 `RequireAuth` 路由守卫上而不只是登录跳转（书签、恢复的标签页、分享链接都能绕过跳转），Shell 里两个 Admin 入口同步隐藏。`useIsHandheld()` 在 Shell 里必须**无条件调用**（挂在 `role === "admin" &&` 后面会让学员用户跳过这个 hook，同一 mount 换角色时 React 报 "rendered fewer hooks than expected"）。

## Home 的话题主线

- Home 有两种形态：**话题主线**（按 anchor topic 一集集啃）和**自由模式**（按最近看过的）。切换写在 `User.onboarding_dismissed`，走 `PATCH /me/preferences`。
- 这个字段**必须出现在 `UserOut` 里**：前端把登录返回的 user 存 localStorage，Home 靠它决定走哪种形态。漏掉它的后果是每次重新登录都被弹回话题主线；如果该话题底下没有已发布的视频，看到的就是一张空白页。
- 主线话题没有内容时有专门的空状态（去 Discover / 换个话题），不是让页面空着。
