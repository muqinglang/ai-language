# 话题分类 · 学习本 · 生词 · 推荐词 · Creators

**改 `services/topics.py`、`routers/vocabulary.py`、`routers/words.py`、`routers/creators.py`、`/library` 页面之前读这篇。**
生词查询那条路径涉及 BYOK 降级规则，见 [BYOK.md](BYOK.md)。

## 话题 & 格式双轴分类 (`backend/app/services/topics.py`)

- `CATEGORIES`（视频格式，10 项）：talk / interview / vlog / tutorial / **creator** / news / documentary / review / comedy / other
- `TOPICS`（话题，17+1）：ai / tech / business / investing / career / lifestyle / travel / food / health / psychology / science / education / entertainment / fashion / sports / outdoor / reading / other
- Episode 增 `topic` 列 + `category_id` FK；startup migration `ALTER TABLE IF NOT EXISTS`
- Pipeline stage 5 `llm.classify_episode(title, summary)` 自动归类；admin 手动 `category_id` 优先
- 前端：Home 页"专注一个话题" chip 栏 → narrow listening；Catalog 五维过滤；EpisodeCard 左上角 topic 徽章；Vocabulary 页按 topic 筛生词
- 历史 episode 的 topic 默认 "other"，重跑 pipeline 才会补齐；没做批量 backfill

## 学习本 (`/library`) — 生词 + Chunk 统一页

- 路由：`/library`（主）；`/vocabulary` 和 `/words` 是老路径，`App.tsx` 里 `<Navigate to="/library" replace />`
- 两 tab：`生词` (vocabulary) + `Chunks`（用户在 Learn 页点 `+ 学习本` 写入的 favorite chunk）
- 顶部"今日复习 N 个"卡从 `GET /api/vocabulary/due` 拉待复习
- Chunks tab 从 `GET /api/favorites/enriched` 拉 `target_type=chunk` 的 fav + 回链到 episode

### 生词底层

- `POST /words/lookup`：不落库的查询（弹窗用），返回 `{word, ipa, definition_en, definition_zh, example}`。查询链是 缓存 → 有道 → LLM（**仅学员自己的 key**）→ 免费词典 → 502。
- `POST/GET/PATCH/DELETE /vocabulary`：与用户绑定的生词表，mastery 0-3（0 待学 → 3 已掌握），含 `ipa`、`next_review_at`、`last_reviewed_at`、`review_count` 列
- **SM-2-lite**：`_REVIEW_INTERVALS_DAYS = {0:0, 1:1, 2:3, 3:null(mastered)}`；`POST /vocabulary/:id/review {remembered:bool}` 调度下一次；手动改 mastery 也重排
- `GET /vocabulary/due?limit=N`：返回 `next_review_at IS NULL OR <= now` 且 `mastery<3` 的待复习
- Learn 页面运行时把 mastery<3 的词喂给 `vocabSet`，字幕里自动蓝色高亮
- 闪卡 session 内嵌 Library 页（Review Session 组件）：翻面看释义 → 记得/忘了 → 自动前进 → PartyPopper 完成屏

## Featured Words（推荐词）

- `backend/app/models/word.py` 存每集的 candidate words 列表
- `GET /api/episodes/:id/words/featured` 返回 8-12 个；Learn 页 Words tab 展示
- 卡上可 `+ 学习本`（走 `/api/vocabulary` 加入生词本）或 ✕ 忽略
- 生成一次、所有人共读，所以**走平台 key**，不是学员的

## Creators（博主频道）

- `backend/app/models/episode.py` 里 `Speaker` 表既是说话人也是 Creator（单表复用）
- `GET /api/creators` 列表 + `GET /api/creators/:id` 单页（带该博主的全部 episode + top_topic）
- Pipeline stage 5 会 get-or-create Speaker：先按 `channel_id` 查，再 fallback name 匹配，都没有就新建。老数据 channel_id 为空的会在名字匹配时 backfill。
- 前端：`/creators` 列表页 + `/creators/:id` Hub 页；Catalog 页也有"博主"筛选 chip（客户端过滤，数据集小够用）
