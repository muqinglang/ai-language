# justSpeak · 产品需求文档 (PRD v0.2)

> 一句话：**通过你感兴趣的知识学英语，只需要开口**。
>
> 参考竞品：TEco Lab（真实语料）、ListenLeap（目录形态）、PowerSpeak v1（AI 流水线）

---

## 1. 产品定位

**justSpeak** 是一个用"真实语料 + Chunk 表达 + AI 对话"帮中国用户开口说英语的学习平台。

与背单词类 App 不同，justSpeak 的核心假设是：
> 英语不是背出来的，是**用**出来的。
> 只要你能在感兴趣的话题里**张嘴就说**，你就在真正学英语。

因此产品围绕三件事：
1. **选你感兴趣的知识**——AI 科普、商业、旅行、心理、健身、科技…… 视频来自 YouTube 真实语料。
2. **学 Chunk 而不是单词**——记住"为什么母语者会这样说"，而不是死记语法和生词。
3. **跟 AI 开口说**——每期视频配套 AI 对话场景，AI 主动引导你用新学的表达，你只需要开口。

### 1.1 目标用户
- 大学级以上词汇量、卡在"听懂但说不出"的中国英语学习者
- 对某些领域（AI / 产品 / 创业 / 旅行 / 健身…）有持续兴趣，想"顺便"把英语学好

### 1.2 与竞品差异
| 维度 | TEco Lab | ListenLeap | **justSpeak** |
|---|---|---|---|
| 内容生产 | 人工选片 + 标注 | 人工整理播客 | **AI 流水线：粘一个 YouTube 链接 → 全自动** |
| 学习单位 | 单词 / 词卡 | 听力全句 | **Chunk 表达**（短语、搭配、口语套话） |
| 练口语 | 跟读录音 | 跟读 | **AI 场景对话**，强制使用目标 Chunk |
| 内容分类 | 按主题 tag | 按系列/难度 | **按"知识领域"**（AI、创业、科学、旅行…），贴近兴趣 |

---

## 2. 核心概念

### 2.1 Chunk（表达块）
Chunk 是 2–6 个词的地道搭配，带有明确的语用功能。例如：
- `ended up doing sth` —— 表达"最后结果变成了……"
- `if I were you, I'd...` —— 委婉给建议
- `I was like, ...` —— 口语引述

每个 Chunk 附带：**为什么这样说 / 使用场景 / 相似表达 / 发音提示 / 视频内出现位置**。

### 2.2 开口即学（Speak-to-Learn）
学一期视频 = 三步：
1. **听懂**：精听视频 + Chunk 高亮
2. **看懂**：点 Chunk 读"为什么这样说"
3. **说出来**：进 AI 对话，AI 用问题把你推到必须用目标 Chunk 才能回答的地方

没有第 3 步，这期就算没学。

### 2.3 知识分类（Category）
不再用"生活/旅行/美食"这类杂 tag，改用**知识领域**作为一级分类：
AI · 商业创业 · 科技数码 · 科学科普 · 心理 · 健身健康 · 旅行文化 · 播客访谈 · 时事新闻 · 生活 Vlog …

用户在"我感兴趣的领域"内积累 Chunk，学习动机更稳定。

---

## 3. 用户端 (C 端) 功能

### 3.1 首页 / 目录（参考 ListenLeap）
左侧窄图标导航 + 顶部搜索 + 正文按"内容轨（rail）"横向滚动：

- **顶部搜索栏**：搜索字幕 / Chunk / 场景
- **左侧窄导航**：首页 · 分类 · 学习中 · 收藏 · Chunk 库 · 学习记录 · 账号
- **正文内容轨**：
  - 继续学习（未学完的视频）
  - 为你推荐（基于兴趣分类）
  - AI 领域精选
  - 最近更新
  - 口音专题（美 / 英 / 澳 / 加 / 苏格兰）
  - Editor's Pick

**卡片字段**（精简版）：封面、标题、Speaker、时长、难度（★）、Chunk 数、状态角标（已学 / 学习中）。

### 3.2 分类筛选页
点击"分类"或卡片"查看更多"进入。顶部是**4 个筛选条件**（**去掉了日历、主题标签、期数**）：
1. **分类**：AI / 商业 / 科技 / 科学 / 心理 / 健身 / 旅行 / 播客 / 生活 …
2. **难度**：★1 入门 / ★2 进阶 / ★3 中级 / ★4 高级 / ★5 母语
3. **口音**：美 / 英 / 澳 / 加 / 苏格兰 / 印度
4. **排序**：最新 / 最热 / 时长升序 / 难度升序

筛选区下方是网格卡片，无限滚动。

### 3.3 视频学习页
**新布局：左字幕 / 右视频**（和 v0.1 的上下布局不同）。

#### 左半屏（60%）— 字幕区
- 顶部 tab：**双语 / 英文 / 中文 / 听写 / 挖空 / 阅读 / 中译英 / Chunk 卡**
- 字幕列表按句滚动，当前句高亮
- 每句行内：
  - 英文原文（**Chunk 用底色高亮**，不同颜色代表不同类型）
  - 中文翻译
  - 时间戳
  - 行尾操作：▶ 播放 / 📋 复制 / ⭐ 收藏 / 📝 笔记 / 🎙 录音
- 点击高亮的 Chunk → 弹出 Chunk 卡片（为什么这样说 / 使用场景 / 相似表达 / 发音）

#### 右半屏（40%）— 视频 + 工具
- 顶部：视频播放器（支持显示/隐藏视频）
- 播放控件：倍速、音标、上/下一句、单句循环、A-B 复读
- 下方工具区 tabs：
  - **本期 Chunk**：本期提取的 8–15 个 Chunk 列表，点击跳转到出现位置
  - **AI 对话**：进入 AI 场景对话（见 3.5）
  - **笔记**：本期所有笔记
  - **进度**：已学句数、已使用 Chunk 数

### 3.4 Chunk 学习系统（核心）
- **Chunk 卡片**详情字段见 §2.1
- **Chunk 挖空**：挖空的是整个 Chunk 而非单词
- **Chunk 库**（全站）：按类型 / 难度 / 已掌握筛选
- **Chunk 复习**：间隔重复推送（SRS，v0.2）

### 3.5 AI 场景对话（核心）
**每期视频都配一个对话场景。** 目标是强迫用户在真实语境里用到本期的 Chunk。

流程：
```
进入 AI 对话 → 展示场景 + 目标 Chunk 列表
       ↓
AI 开场（用一个贴近视频话题的问题）
       ↓
用户文字 / 语音回复
       ↓
AI 根据回复判断是否用到目标 Chunk
   ├── 用到了 → 正面反馈，深化对话
   └── 没用到 → 用 Push 问题巧妙引导
       ↓
5–10 轮后结束 → 对话小结
   （使用了哪些 Chunk ✅ / 哪些没用到 ⬜ / 改进建议）
```

交互要点：
- 侧栏实时显示目标 Chunk 使用状态（✅ / ⬜）
- AI 不纠语法错误，只在影响理解时修正
- AI 会主动推荐更地道的说法
- v0.2 支持语音对话

### 3.6 其他
- **搜索**：按关键词 / Chunk / 场景搜全站字幕
- **收藏**：视频 / 句子 / Chunk 三级收藏
- **学习记录**：打卡日历、学习时长、Chunk 掌握曲线
- **账号**：用户信息、登出、意见反馈

---

## 4. 后台管理 (B 端)

### 4.1 Dashboard
- 内容：总视频数、本周新增、AI Pipeline 队列长度、待审核数
- 用户：日活、学习时长、打卡数、AI 对话次数
- 系统：Pipeline 成功率、平均处理时长
- 快捷入口：新建导入任务、查看待审核、失败任务

### 4.2 YouTube 导入 + AI Pipeline
这是后台的核心。管理员**只需粘贴 YouTube 链接**。

#### 4.2.1 导入表单字段
| 字段 | 来源 | 说明 |
|---|---|---|
| YouTube URL | 粘贴 | 支持单个视频、播放列表、频道 |
| 视频元信息 | 自动抓 | 标题、时长、频道、缩略图、描述 |
| AI 推荐片段 | AI | 1–3 个 2–3 分钟片段 + 推荐理由 |
| 起止时间微调 | 滑杆 | 可手动改 AI 推荐的起止 |
| 知识分类 | AI 自动 + 人工改 | AI / 商业 / 科技 … |
| 难度 | AI 自动 + 人工改 | ★1–★5 |
| 说话者 | AI 自动 + 人工改 | 姓名、性别、口音 |
| 优先级 | 人工 | 高 / 中 / 低 |
| 提交 | 按钮 | 进入 AI 流水线 |

#### 4.2.2 AI Pipeline 阶段
```
Stage 1 下载 & 转码   yt-dlp + FFmpeg → mp4
Stage 2 字幕生成      Whisper → 英文 SRT → AI 翻译中文
Stage 3 Chunk 提取    AI 抽 8–15 个 Chunk + 语用解释
Stage 4 对话脚本      AI 根据内容生成场景、System Prompt、Push 问题
Stage 5 质检         字幕对齐 / 翻译质量 / Chunk 完整性
```

每个 Stage 的**进度、日志、耗时、失败原因**都在 Pipeline 管理页可见，支持单 Stage 重试。

### 4.3 内容审核
AI 处理完毕后进入审核队列，逐项审核：
- 视频片段预览 → 通过 / 调整起止 / 拒绝
- 英文字幕 → 行内编辑
- 中文翻译 → 行内编辑
- Chunk 标注 → 增删改，调整语用解释
- AI 对话脚本 → 编辑 System Prompt、Push 问题
- 分类 / 难度 / 口音 → 修改
- 整体评分 1–5 → 通过后进入发布队列

### 4.4 内容管理
- **视频管理**：列表（筛选：状态 / 分类 / 难度 / 口音 / 日期）、编辑、上下架、排序、定时发布
- **Chunk 库管理**：总库、跨视频关联、统一编辑语用解释、难度调整、导出
- **AI 对话模板管理**：每期视频的 System Prompt、Push 问题池、对话日志（脱敏）、效果分析
- **Speaker 库**：博主信息
- **分类 / 难度 字典**

### 4.5 用户管理 & 反馈
- 用户列表、详情（学习数据、对话记录）、封禁
- 反馈中心：问题报告 / 功能需求 / 建议，流转状态

### 4.6 系统设置
- AI 模型配置（Whisper、GPT-4/Claude 版本）
- API Key 管理（YouTube Data、OpenAI / Anthropic、OSS）
- 存储配置、通知设置、操作审计日志

---

## 5. 数据模型

```ts
User {
  id, username, email, password_hash, avatar
  interests: Category[]   // 选定的兴趣分类，用于推荐
  study_stats: { days, chunks_mastered, ai_chats }
  created_at, last_active_at
}

Episode {                 // 一期视频 = YouTube 的一个 2–3 分钟片段
  id, title, summary
  youtube_url, video_url, thumbnail_url
  duration
  category_id              // 知识分类
  speaker_id
  accent                   // 美/英/澳/加/苏格兰/印度
  difficulty               // 1–5
  chunks_count, subtitles_count
  status                   // draft/reviewing/published/archived
  published_at
  ai_metadata              // 保留 pipeline 产出的原始数据
}

Category { id, name, slug, icon, sort }    // AI / 商业 / 科技 …

Subtitle {
  id, episode_id, seq
  start_ms, end_ms
  text_en, text_zh
  chunks: ChunkId[]        // 该句包含哪些 Chunk
}

Chunk {
  id, text
  chunk_type               // idiomatic/collocation/discourse/functional/cultural
  why_explanation          // 为什么这样说
  usage_scenario
  similar_expressions[]
  common_collocations[]
  pronunciation_tip
  difficulty
  occurrences: { episode_id, subtitle_id, position }[]
}

Speaker { id, handle, name, avatar, youtube_url, default_accent, default_gender }

AIConversation {
  id, user_id, episode_id
  scenario_description
  target_chunks: ChunkId[]
  messages: { role, content, ts }[]
  chunks_used: ChunkId[]
  summary
  created_at
}

Progress { user_id, episode_id, status, last_seq, finished_at }
Favorite { user_id, target_type(episode/subtitle/chunk), target_id, note }
Note     { user_id, subtitle_id, content, recording_url }
Feedback { user_id, type, content, status, created_at }

ImportTask {
  id, youtube_url
  status             // queued/downloading/transcribing/chunking/dialoging/reviewing/published/failed
  ai_segments: { start,end, reason, score }[]
  selected_segment
  processing_log: { stage, status, duration, error? }[]
  created_by, created_at
}
```

---

## 6. 核心 API 草案

```
# 前台
POST  /api/auth/register | /login
GET   /api/feed                          # 首页所有轨
GET   /api/episodes?category=&difficulty=&accent=&sort=&page=
GET   /api/episodes/:id                  # 视频 + 字幕 + chunks + ai scenario
POST  /api/episodes/:id/progress
POST  /api/ai/conversations              # 开启对话 (返回 conversation_id)
POST  /api/ai/conversations/:id/messages # 发一条消息，返回 AI 回复 + chunk 使用检测
GET   /api/chunks?filter=                # Chunk 库
POST  /api/favorites | /api/notes
GET   /api/search?q=&type=text|chunk|scenario

# 后台
POST  /api/admin/import                  # 粘贴 YouTube URL → 创建 ImportTask
GET   /api/admin/import/:id              # 查看 pipeline 进度
POST  /api/admin/import/:id/retry?stage=
GET   /api/admin/review/queue
PUT   /api/admin/episodes/:id            # 审核编辑
POST  /api/admin/episodes/:id/publish
GET   /api/admin/chunks | /speakers | /users | /feedback
GET   /api/admin/stats
```

---

## 7. 实施计划

| Phase | 范围 | 预估 |
|---|---|---|
| **M1 骨架** | 用户系统 + 目录 + 视频播放 + 双语/英/中模式 + 后台 YouTube 导入 + Whisper 字幕 | 2 周 |
| **M2 Chunk** | AI Chunk 提取 + Chunk 高亮字幕 + Chunk 卡片 + Chunk 库 + 挖空/听写 | 1.5 周 |
| **M3 AI 对话** | 场景设计 Pipeline + 对话页 + Push 引导 + 对话小结 | 1.5 周 |
| **M4 后台完善** | 审核流程 + Chunk 库管理 + Dashboard + 反馈 | 1 周 |
| **M5 打磨** | 搜索 / 收藏 / 学习记录 / 间隔重复 / 语音对话 | 1 周 |

---

## 8. 技术栈建议
- 前端：Next.js 14 + TypeScript + Tailwind + shadcn/ui
- 后台：Next.js 同仓 route group 或独立 React + Ant Design
- 后端：FastAPI（Python 对 AI 生态友好）
- DB：PostgreSQL + Redis + 对象存储（阿里云 OSS）
- AI：Whisper（字幕）+ Claude/GPT-4（翻译 / Chunk / 对话）
- 队列：Celery / RQ 跑 AI Pipeline
- 部署：Docker + K8s

---
*版本 v0.2 · 2026-04-13*
