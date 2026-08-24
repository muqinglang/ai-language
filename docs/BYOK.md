# 学员自带 API key / BYOK (`/api/me/llm`)

**改 `routers/user_llm.py`、`services/llm_byok.py`、`LLMKeySettings.tsx`，或给任何学员侧接口加 LLM 调用之前，读这篇。**
前端有一段给学员的**书面承诺**，它是照着这里的代码事实写的 —— 改代码就是在改承诺。

## 存储

- `user_llm_configs`（user_id unique），`api_key_enc` 是 Fernet 密文。密钥来自 env `CREDENTIAL_ENC_KEY`（`services/secrets.py`；任意字符串都行，非标准 Fernet key 会走 SHA-256 拉伸）。**没配这个 env 整个功能自动隐藏**：`available:false` → 设置卡和首页引导横幅一起不渲染（不报错，所以很难查——ECS 2026-08-14 才补上）。
- 存之前**真的调一次 provider**（`llm_byok.verify`），不通过不落库；HTTP 200 但内容为空也算失败（推理模型把 token 花光的经典症状）。
- **明文只在两处出现**：`user_llm._to_out`（算掩码）和 `load_override`（发请求前解密）。两处都写死按当前登录用户那一行查，**没有任何 admin 接口能读别人的 key**。
- provider 报错先过 `llm_byok.redact(text, api_key)` 再存/再显示：`last_error` 是会被读的列，别让 key 漏进去。

## 平台的 key 完全不服务学员侧调用

不是"先试学员的再回落平台"，也不是"没配就用平台的顶上"——**没配就 428，配错就 502**。

- 路由统一走 `user_llm.require_override(db, user)`（没有 → 428 `{code:"byok_required"}`），调用失败抛 `llm.BYOKCallFailed` → 502 + 中文原因 + 写 `last_error`。
- 前端 `api.ts` 把 428 变成 `ByokRequiredError`，渲染 `NeedApiKey` 卡片（去 `/me#api-key`），不是红色报错框。
- 理由：兜底是在替用户决定用哪个模型，而且看不见——一把早就失效的 key 可以一直安静地花平台的钱。
- 读取已存在的会话不调模型，所以**没 key 也能翻历史对话**，只是发不出新消息。

**规则一句话，零例外：学员点出来的每一次模型调用，都花学员自己的 key。**

覆盖：开场白/场景、回复（含流式）、逐条反馈、参考答案、teach-back 提问+评估、整篇跟读评分、气泡翻译、「在视频里详细解释」(`/words/explain-in-context`)、**Rephrase 换着花样说** (`episodes.sentence-pattern`)、**Words tab 推荐词** (`words.featured_words` 的懒生成路径)。

**唯一的免 key 通路是查词** (`/words/lookup`)：没 key 就跳过 LLM 那一步，走有道和免费词典，答案照出、谁都不花钱。这条**不适用于** explain-in-context —— 那里没有任何免费兜底能回答"这句话在这个视频里什么意思"。

**读缓存不需要 key**：Rephrase 和推荐词生成一次就入库（`ai_metadata` / `featured_words` 表），后来者读缓存不调模型，因此不 428。只有"这一集还没生成过"的人才会撞上 428，而 TA 付的那一次生成，自己立刻就用上了。

### 为什么 Rephrase / 推荐词从平台 key 改成了学员 key

它们原本走平台 key，理由是"生成一次、所有人共读，不该让第一个点开的人替所有人付钱"。这个理由**站不住，而且塌过一次**：

2026-08-16 平台 DeepSeek key 失效，Rephrase 当场报"生成失败，请重试"，而设置页的「测试连接」是绿的 —— 因为那测的是学员自己那把 key（好的），测不到平台那把（死的）。用户完全无从判断问题在哪。

- 它在学员侧留了一个**看不见的依赖**：一把平台 key 死了，学员功能就挂。
- 它跟"平台不替任何人垫模型"的承诺直接矛盾。
- 省下的钱很少：一集一次、几百 token。
- 代价很大：要长期维护一把有效、有余额的平台 key，还是单点故障。

### 平台 key 已经彻底退场

第二步走到底：**导入 pipeline 也用 admin 自己的 key**。理由是同一条——导入是 admin 的活，而 admin 也是一个配了 key 的用户，没有理由再维护第二套凭据。

于是全站只剩**一个 key 入口**：`我的 → 设置 → 我的 API key`。本地和线上都一样。

- `POST /admin/import`、`/import/{id}/retry`、`/import/{id}/approve` 都先 `require_override(db, admin)`，没配就 428。
- admin 后台的重新提取 chunks / 重新生成 lesson brief / 重新翻译字幕 / 重新生成推荐词，同理。
- 定时导入没有登录用户，用 `_schedule_override()` 取**最小 id 的、配了 key 的 admin**，一个都没有就整轮跳过并把原因写进 `last_run_summary`——不会静默不跑。
- `.env` 里的 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 现在是**可选**的兜底，留空是受支持的配置，线上就是留空跑的。

实现方式是 `llm.use_override()` + 一个 ContextVar，而不是给 16 个 `llm.*` 函数逐个加 `override` 参数：一次导入会穿过 pipeline 里十几个函数，而这个值在一次运行里从不变化。`asyncio.create_task` 和 `asyncio.to_thread` 都会复制 context，所以 pipeline 里那些跑在线程里的 LLM 调用能自动继承。

判断"现在能不能调模型"要用 `llm.has_credentials()`，**不要再直接看 `_has_provider()`**——后者只看 env，会让本来能用学员 key 干的活被跳过。

## 加接口时的检查清单

加一个新的 LLM 调用时，只问两个问题：

1. **是学员点出来的吗？**（不管产出是给 TA 一个人看还是所有人共读）→ `require_override`，428/502。"所有人共读"**不是**走平台 key 的理由，见上一节。
2. **没 key 时有没有免费的答案可给？** → 有就像查词那样静默降级；没有就 428。

**没有第三种答案了**：导入 pipeline 和 admin 后台按钮走的是**触发它的那个 admin 自己的 key**，不是平台 key——平台 key 已经退场。

漏掉这一步的后果发生过两次：`/words/explain-in-context` 从上线起就没接 `require_override`，线上 admin 一个 key 都没配却能一直用平台的钱；Rephrase 和推荐词按"公共内容"归到平台 key，结果平台 key 一失效就整个挂掉，而设置页还显示连接正常。

## 踩过的坑

- `_override_call` 里同样要过 `_reasoning_budget`。BYOK 路径原本没放宽，学员用 deepseek-v4-pro 时开场白 400 token 全花在思考上返回空——因为当时还会静默回落，所以没人发现。流式那条 `_stream_content(oc, model, _reasoning_budget(300))` 同理。
- 前端 `PROVIDERS` 带 `key_url` / `hint` / `notes`（每个模型一句话）。**挑模型是学员最容易踩的坑**——`deepseek-v4-flash` 返回空内容，看起来跟"key 是坏的"一模一样，所以说明必须摆在选项旁边。

## 第二把 key：朗读声音（CosyVoice · 阿里云百炼）

同一行 `user_llm_configs` 上还有一组独立的 TTS 字段（`tts_api_key_enc` / `tts_voice` / `tts_model` / `tts_verified_at` / `tts_last_error`）。加密、保存前验证、报错脱敏这三条跟上面完全一样，`services/tts_cosyvoice.py` 是客户端。

**为什么是 CosyVoice**：fish.audio 在国内被 DNS 污染 —— 从杭州 ECS 上问任何一个解析器（阿里/腾讯/Google），拿回来的 A 记录都不一样，而且都是 Twitter/Meta 的网段，TCP 根本建不起来。同一台机器上 `dashscope.aliyuncs.com` 0.15 秒可达。ElevenLabs 其实也通（实测 200/1.2s），但它是平台在花钱。

**为什么单独一把 key**：模型和声音是两家买的，学员完全可能只配其中一个。两半互不影响，删掉任意一半不会带走另一半（`DELETE /api/me/llm` 会特意保留 TTS 那半）。

**和对话 key 最大的不同：没有 428。** 没配声音 key 不会挡住任何功能 —— 浏览器自带的 Web Speech 照样念，只是没那么好听。所以 `/api/tts` 的顺序是「学员的 CosyVoice → 平台 ElevenLabs（若开启）→ 503」，503 由前端接住降级，是**降级不是故障**。

推论：`TTS_DISABLED=true` 这个 prod 开关**只关平台那条路**。它存在的目的是别让平台花钱，而学员用自己的 key 不属于平台花钱，所以那条分支跑在开关判断之前。

**音色列表故意不写死**：阿里加音色比我们维护清单快，一份过时的清单会把合法音色挡在外面。设置页的音色是可输入的（带几个建议值），保存时真的合成两个词，写错了由 provider 自己报错 —— 它才是唯一权威。

**磁盘缓存是跨学员共享的**，键是文本+音色+模型，不含用户。这不违反"只花在你自己的请求上"：命中缓存的那次请求谁都没花钱，只有 miss 才调 provider，而 miss 记在触发它的人头上。

## 给学员的承诺文案（`LLMKeySettings.KeyPromise`）

只写承诺本身，不写实现（Fernet、环境变量、掩码规则一概不提 —— 学员要的是"会不会被别人花掉"的答案，读到加密算法名只会更没底）。措辞随便改，但每一条都必须仍然对得上上面的代码事实。**别加"管理员查看用户 key"这类功能**，那会让这段文案直接变成谎话。
