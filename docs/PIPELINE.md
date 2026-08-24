# 导入流水线 · 字幕 · 选段

**改 `backend/app/services/pipeline.py`、`llm.py` 里的选段/章节/广告部分、或任何跟字幕解析有关的东西之前，先读这篇。**
这里的每一条几乎都是从一个具体的线上 bug 反推出来的，不是设计文档。

## 五个 stage

YouTube URL → Episode + Subtitles + Chunks

| Stage | label | 做什么 |
|---|---|---|
| 1 | 字幕拉取 | yt-dlp 拉元数据 + YouTube 英文字幕（**json3 优先，VTT 兜底**，不下视频） |
| 2 | AI 选段 | LLM 先给全片 chapters，再**在单个 chapter 内**挑 2-3 分钟窗口 |
| 3 | 下载 & 字幕 | yt-dlp 下载选中片段 1080p + 字幕 rebase 到 0 + 翻译 |
| 4 | Chunk 提取 | LLM 从字幕提取 8-12 个地道表达 |
| 5 | 对话 & 入库 | LLM 设计对话场景 + 翻译摘要 + 写入 DB |

两种模式：
- **单段**（默认）：一键跑完 stage 1→5
- **多段**（segments_count > 1）：stage 1→2 后暂停 `pending_review`，admin 预览/±15s 微调后确认，再跑 N 次 stage 3→5 生成 N 个独立 Episode

## 字幕解析

- **字幕源用 json3，不用 VTT**（`_parse_json3` / `_caption_word_timings`）：同一条 YouTube 自动字幕轨有多种格式，VTT 是滚动窗口格式 —— 每条 cue 重复上一条的尾巴、词级时间藏在内联 `<ts>` 标签里、而"窗口只前进一个词"的那种 cue **根本没有标签**，`>>` 换人则是硬塞进正文的字符串。实测 62 分钟播客（`QXMkkAcWask`）：VTT 解析丢 92 个词，**全是句尾词**（`outbound?` `business.`），于是句子看着总断在半截，连带 `_sentence_boundaries_ms` 的边界表也是残缺的 —— 选段 snap 因此永远对不准。json3 一行一条 event，每个词带 `tOffsetMs`，滚动重复单独放在只含 `"\n"` 的 `aAppend` event 里，换人是 `isSpeakerChange` 标志位。VTT 解析器保留给没有 json3 的轨（手工上传字幕）和切换前缓存的老任务，也顺手补了无标签 cue 的捞回（找回那 87 个词）。
- **说话人换轮是一等公民**：`>>` / `isSpeakerChange` 不只是要删掉的噪音 —— 它同时是①分行点（ASR 常把问句和答句连成一行，中间没句号：`Was that more of an inbound or was it >> Every single one of my work opportunities is now inbound.` 是两个人说的）②句子边界（喂给 snap）③**选段器的输入**（喂 LLM 的转录保留 `>>`，显示层剥掉 —— 看不见谁在问谁在答，模型就会从答案中间起头）。
- **混合字幕切分**：`_hybrid_subtitle_split` 先跑 `_split_into_sentences`（word_timings 高质量段），若覆盖率 <85% 再用 `_merge_yt_cues_into_sentences` 用 yt_subs 裸 cue 补尾巴。解决 VTT `<c>` 标签只覆盖 clip 前段时字幕骤停的 bug（ep 39/47 历史问题）。
- **句子级字幕切分**：YouTube 给的 cue 常在半句切断 → `_split_into_sentences` 按 `word_timings` 在 `.!?` 处切行；超长 run 优先在逗号 > 连接词（because/which/but/…）断，保留 `_MIN_SPLIT_PRE_WORDS=10`。对录音跟读友好（一行=一句自然语义）。
- **VTT 新词行**（仅 VTT 兜底路径）：YouTube 自动字幕每个 cue 有两行文本（上一句上下文 + 新词），只取带 `<c>` 标记的新词行，避免把前一句当成当前字幕。
- **VTT 清洗**：strip HTML entities → strip `>>` 说话人标记 → 滚动窗口 dedup（前缀扩展/子集/尾片段）。
- **先整体翻译后切分**：LLM 批量翻译（`_translate_to_zh`）带跨句上下文 + 明确 ASR 纠错示例（`GPD→GPT`、`entropic→Anthropic`、`open claw→OpenClaude`、`cloud codes→Claude Code`），保证专有名词一致。

## 选段

- **整篇转录类 LLM 任务一律关思考**（`_WHOLE_TRANSCRIPT_NO_THINK`）：选段 / 全片 chapters / 广告检测的输入是整篇转录，DeepSeek v4 的思考 token 和答案共用 `max_tokens`，思考量随视频长度涨、答案却只有一个小 JSON。实测 62 分钟播客：预算 1624 → 1624 全进 reasoning、content 空；提到 4000 → 4000 全进 reasoning、还是空、44 秒；**关思考 → 2 秒出合法 JSON**。加预算只会买到更多思考。空 content 看起来跟"没结果"一模一样，于是所有调用方静默降级 —— ep 42-48 全都发的是 `fallback window`（视频前 150 秒），这才是"片段从半路开始"的真正原因。翻译早前踩过同一个坑（`_translate_window`）。
- **选段的单位是话题，不是句子**（`llm.outline_topic_units` + `_clamp_to_chapter`）：片段开头符合语法不等于听得懂 —— 它可能是 30 秒前那个问题的答案。所以先让模型把全片切成 chapters（覆盖规则抄自 `youtube-digest/prompts/analysis.md`：最后一章必须晚于 75%，否则模型切到 10 分钟就不切了），再要求窗口落在**单个 chapter 内部**，并由代码 clamp。跨话题的窗口从"不鼓励"变成"表达不出来"。chapter 拿不到就退回旧的全时间轴选法。
- **snap 之后还要再 snap 一次**：`_enforce_segment_bounds` 为了凑够 120s 会往前扩 1/3，把刚对齐好的开头又拽回句中（广告过滤早就因为同样的理由跑两遍）。`_pull_segment_start_to_boundary` 在 enforce 之后**只往前推**，宁可少几秒也不要开头是半句。
- **片段边界是整秒，字幕窗口不是**（`_record_boundary`）：clip 起止一路到 yt-dlp 都是整秒，把 3680ms 的边界 floor 到 3s 会把上一个人的最后一个词（`that.`）带进音频，这在秒级粒度下无解 —— 但**字幕行可以从真边界开始**，所以宁可让那 0.7 秒没有字幕，也不要出现一行只写着 "that."。片尾同理：字幕覆盖到 clip 真正的结束（含 padding），而被 clip 切断的半句尾巴直接丢弃（判据是"这句话一直说到 clip 结束"，不是长度）。
- **字幕先行**：先拉 YouTube 字幕（不下视频），LLM 看完整字幕再选段，然后只下那 2-3 分钟。解决长视频导入问题。
- **Clip 末尾留 padding**：`SEGMENT_START_PADDING_SEC=0` / `SEGMENT_END_PADDING_SEC`，开头严格对齐（0s 延迟），结尾多留几秒避免话音被截断。
- **广告过滤靠代码兜底，不靠提示词**：两个选段提示词从一开始就写着 "AVOID sponsor reads"，模型照样把 WorkOS 的 35 秒口播选进片头 —— 口播是流利、地道、发音清晰的英语，在选段器优化的**每一条**标准上都得分很高。所以拆成两步：`llm.detect_ad_spans()` 单独标出广告时段（宁漏勿误，>300s 的跨度视为模型误判丢弃），再由 `pipeline._relocate_out_of_ads()` **用代码**把选段挪出广告区间。选段提示词里额外给出 `FORBIDDEN RANGES` 数字区间 + 行内 `[AD]` 前缀（具体时间戳比抽象规则管用得多）。ad-repair 跑两遍：选完一次（可搬移），句子对齐 ±15s 和 `_enforce_segment_bounds` 扩窗之后再一次（只裁不搬）。full 模式只裁边/丢弃、绝不搬移 —— 切片是首尾相接铺满全片的，搬移会让相邻片段重叠。检测失败 → 空列表 → 退回旧行为，不阻断导入。

## 下载 & 容错

- **下载失败硬 fail**：无论 metadata 是否拿到，只要片段下载失败就 raise `"片段下载失败（...）"`。早期版本在 meta 也为 None 时会悄悄回退到 `CANNED_SUBS` + 空 `video_url`，前端就显示"视频文件未提供 + 假字幕"。同理，字幕如果 YouTube caps 空 + whisper 也空，不再回退到 CANNED_SUBS 而是 raise `"无法获取字幕（...）"`。CANNED_SUBS 保留为模块常量但不再可达（seed.py 里的 demo seed 用独立一份）。
- **LLM 超时保护**：`_chat()` 每个 provider 120s 超时 + pipeline 外层 `asyncio.wait_for` 180s，防止 zombie task。DeepSeek 偶尔超时或不响应，另有截断 JSON 抢救。
- **多段导入 per-segment 隔离**（`_run_highlight_segments`）：1.5h 视频导 5 段 = 5 次独立的 ranged download，YouTube 掐断的概率高到"通常至少挂一段"。老的裸循环让异常直接冒泡出 `run_pipeline`：前面已成功的 episode 白做（任务标 failed），后面的段根本不跑。现在每段独立 try + **失败重试一次**（掐断是瞬时的，同一 URL 几分钟后就能下），失败只记账不中断；只有**全部**段都失败才 raise。部分成功时 `task.error` 写 "4/5 段成功，失败的：…" 但状态仍是 reviewing。故意保持串行：并行下载会共用同一个 `_DL_PROGRESS` 槽位（按 task 而非 segment 索引）把字节数搅乱，"[3/5] downloading" 前缀也只有单段在飞时才读得通。失败后必须走 `_recover_session()`（rollback 会让 `task` 的属性全部 expire，下一次 `mark()` 读 `task.log` 触发 lazy load，在 async SQLAlchemy 里是 MissingGreenlet 而不是静默重载）。
- **下载进度实测，不靠推算**（`_start_download_watcher`）：`download_ranges` 把实际传输交给 ffmpeg（FFmpegFD），它退出前不向 yt-dlp 回报任何东西，所以 `progress_hooks` 在片段下载这条路上是死的。改为起一个看门狗线程每 2s 采样磁盘上正在写的文件（按 video id 前缀过滤，避免并发导入互相计数），把 `{bytes, rate_bps, elapsed_sec, stalled_sec, remaining_sec}` 写进进程内 `_DL_PROGRESS` dict —— 不落库，因为 80 KiB/s 的下载会变成每 2 秒一次 DB 写，而 pipeline 与 API 本来就同进程。`/api/admin/import/{id}` 把它挂在 `download` 字段带出去。**故意不给百分比**：ffmpeg 从不上报总大小，任何完成度都是编的；前端进度条画的是本次尝试的超时倒计时，旁边写明。有实测字节在动时，前端不再显示"已 N 分钟未更新 · 大概率卡住"（那是靠 `updated_at` 猜的，而 `mark()` 只在 stage 切换时才写）。
- **ffmpeg 拉流必须开重连**：长视频取片段时 YouTube 会先限速到 0 再掐断 socket，ffmpeg 报 `Error opening input files: End of file` + exit 187（不像网络错误，所以早期落进"未识别错误"）。`external_downloader_args.ffmpeg_i` 加 `-reconnect / -reconnect_streamed / -reconnect_on_network_error / -reconnect_delay_max 30`（必须在 `-i` 之前，故用 `ffmpeg_i` 键）。
- YouTube 下载速度受 GFW/代理影响，`docker-compose.yml` 里可配 `HTTP_PROXY`。

### YouTube 反机器人 + n 签名挑战（远程部署）

YouTube 会把 DC IP（Vultr / AWS / 阿里云等机房网段）标为可疑，返回 `"Sign in to confirm you're not a bot"`。即使过了 bot check，视频媒体 URL 还有 JS `n` 参数需要算，yt-dlp 没装 JS runtime 时只能拿到 storyboard 图片。因此远程部署需要三件齐活：

1. `YT_COOKIES_PATH`（默认 `/app/secrets/yt-cookies.txt`，k8s secret 挂进来）——`_yt_cookiefile()` 会先把只读 mount 拷到 `/tmp/yt-cookies.txt`（yt-dlp 要写回刷新的 session token）。本地 dev 文件不存在则跳过，不影响。
2. `deno`（`backend/Dockerfile` 装的 JS runtime）+ `remote_components: {"ejs:github"}`（让 yt-dlp 从 GitHub 下载 EJS solver 脚本，默认 opt-in）。两者缺一都只能看到 storyboard 图片。
3. cookies 每 20-30 天失活一次，用 `scripts/refresh-yt-cookies.sh` 从本机 Chrome 一键 export → upload → rotate secret → restart pod。

> 现实里 justSpeak 的 pipeline 只在本地 Mac 跑（住宅 IP，免 cookies），**绝不在 ECS 导入**。见 [DEPLOY.md](../DEPLOY.md)。

## 数据约定

- **独立 Episode 做分组**：多段切分产生 N 个独立 Episode（共享 youtube_url），不改 Episode 数据模型。
- **`ai_metadata.segment` 里 `source_start`/`source_end` 是原片绝对位置**（仅展示用），视频和字幕都 rebase 到 0。前端不能用这些值做 seek 或过滤。
- **chunk_refs 回填**：pipeline 在入库时把 chunk ID 写入 `Subtitle.chunk_refs`，前端同时做运行时文本匹配（双保险）。
