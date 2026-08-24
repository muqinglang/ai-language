# justSpeak · 只需要开口

[English](README.md) · **中文**

> 看真实 YouTube 片段学英语口语,再和 AI 场景对话练开口。
> 用真实语料 + Chunk 表达 + AI 对话,帮中文母语者把英语说出口。

一个可自托管的语言学习平台:学员看 2–3 分钟的精选片段(带双语字幕),收集地道表达
("chunks"),然后和一个会复用这些表达的 AI 进行场景对话。

<!-- 有了公开实例后,在这里放截图 / GIF。 -->

---

## 功能

**学员端**
- 真实 YouTube 片段导入并转写(yt-dlp + faster-whisper),5 种字幕模式(双语 / 英 / 中 /
  听写 / 挖空 / 纯听)
- 点词查词(LLM 释义 + 音标 + 发音 + "在原片里听" + 加入生词本)
- **AI 场景对话** —— 流式(SSE)、气泡翻译、慢读、语法反馈、看参考答案、费曼式复述
- 生词 / Chunk 的 SM-2-lite 间隔重复闪卡
- 跟读录音 + 实时语音识别、收藏、笔记、学习热力图
- 响应式:桌面侧边栏、手机底部 tab、iPad 布局;可作为 PWA 安装(加到主屏 / 装成桌面应用)

**管理端**
- 粘一个 YouTube 链接 → AI 选出最佳片段 → 下载、转字幕、翻译、抽 chunks、生成对话脚本、
  自动按话题归类
- 导入任务面板(重试 / 报错);单集的重抽 chunks / 重生成对话工具

**自带 Key(BYOK)** —— 学员可以填自己的 LLM / TTS key,让每个人的模型调用记在自己账上,
而不是运营方买单。见 [docs/BYOK.md](docs/BYOK.md)。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | FastAPI · SQLAlchemy 2(async)· PostgreSQL 16 · JWT · Pydantic |
| 前端 | React 18 · TypeScript · Vite · TailwindCSS · TanStack Query |
| 导入流水线 | yt-dlp + faster-whisper + 多家 LLM(DeepSeek / OpenAI / Claude) |
| TTS | ElevenLabs / MiniMax / CosyVoice → 浏览器 Web Speech 兜底 |
| STT | 浏览器 Web Speech API |
| 部署 | Docker Compose(db + api + web) |

---

## 快速开始(Docker)

```bash
git clone <你的-fork-地址> justspeak && cd justspeak
cp .env.example .env          # 改密钥 —— 至少设 POSTGRES_PASSWORD + JWT_SECRET
docker compose up -d --build
```

| 服务 | 地址 |
|---|---|
| Web | http://localhost:8080 |
| API 文档(Swagger) | http://localhost:8000/docs |
| Postgres | `psql -h localhost -U admin -d justspeak` |

首次启动 `seed.py` 会建表、建分类、建一个 **admin** 账号。如果你没在 `.env` 里设
`ADMIN_PASSWORD`,系统会随机生成一个并打到 api 日志里:

```bash
docker compose logs api | grep "generated"
```

**不填任何 API key 也能跑** —— LLM 和 TTS 会优雅降级(走 BYOK 或浏览器 Web Speech)。在
`.env` 里填 key 即可开启服务端 AI。各子系统怎么工作见 [docs/](docs/)。

---

## 部署

完整分步指南见 **[DEPLOY.md](DEPLOY.md)**。三选一:

| 方案 | 各部分跑在哪 | 适合 |
|---|---|---|
| **VPS + Docker Compose**(推荐) | 全部在一台服务器;`git clone` + `docker compose up -d`;用 Caddy 上 HTTPS | 最简单,视频完全可用(nginx 支持 Range 拖动) |
| **Railway + Vercel** | 后端 + Postgres + 存视频的 Volume 放 Railway;静态前端放 Vercel | 托管,不用自己管服务器 |
| **交给 AI 代理** | 让 Claude Code / Codex 读 DEPLOY.md 帮你部署 | 零手动步骤 —— 粘 DEPLOY.md 第 4 节的提示词即可 |

> **视频存在磁盘上**(Docker 的 `media` 卷,或 Railway 挂在 `/app/media` 的 Volume)。
> 光靠 Vercel 存不了视频、也跑不了后端 —— 详见 DEPLOY.md。

---

## 目录结构

```
justspeak/
├── docker-compose.yml          # db + api + web
├── docker-compose.prod.yml     # 生产覆盖(精简镜像、宿主机 nginx/Caddy)
├── .env.example                # 全部配置
├── backend/                    # FastAPI 应用(app/routers, app/services, app/models)
├── frontend/                   # React + Vite 单页应用
└── docs/                       # 各子系统的开发文档 —— 改哪块先读哪份
```

`docs/` 是真正的设计文档:每份对应代码的一部分(pipeline、学习页 UI、AI 对话、BYOK、
账号、学习数据),改那块之前值得先读。

---

## ⚠️ YouTube / 内容免责声明

导入流水线用 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 下载 YouTube 内容做转写。
**本项目仅供个人、教育与研究用途。** 下载、存储或再分发第三方视频内容,可能违反 YouTube
服务条款和/或你所在司法辖区的版权法。**你需自行为如何使用本软件、以及为所处理内容取得
必要授权负全部责任。** 作者不提供任何担保、不承担任何滥用责任。请勿用它再分发受版权保护
的内容。

另外,数据中心 IP 常被 YouTube 的反机器人机制挑战 —— 导入通常需要住宅 IP 和/或 cookies
才能跑通。

---

## 许可证

[AGPL-3.0](LICENSE)。简单说:你可以自由使用、修改、自托管;但如果你把修改后的版本作为
网络服务运行,必须向其用户公开你修改后的源码。本许可证不允许闭源商业托管。

欢迎贡献 —— 见 [CONTRIBUTING.md](CONTRIBUTING.md)。
