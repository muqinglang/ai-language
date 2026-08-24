# 账号 · 试用有效期 · Admin 后台

**改 `routers/auth.py`、`routers/admin_users.py`、`schemas.UserOut`、登录/试用相关前端之前读这篇。**

## 用户有效期 / 试用 (`User.expires_at`)

- 列：`User.expires_at: TIMESTAMPTZ NULL`。`NULL = 永久`（向后兼容，老用户不变）。startup migration `ALTER TABLE ADD COLUMN IF NOT EXISTS`。
- 校验：`auth.current_user` 与 `auth.login` 都检查 `expires_at <= now AND role != 'admin'` → 抛 `403 {detail: {code: "trial_expired", expired_at, message}}`。**admin 角色永远豁免**（防止管理员把自己锁出来），创建/修改 admin 时后端强制 `expires_at = NULL`。
- Admin API:
  - `POST /admin/users` 接 `expires_at`（可选，默认 null）
  - `PATCH /admin/users/{id}` 接 `expires_at` + `clear_expiry: bool`（哨兵值，true 时清空，绕过 PATCH "None = 不改" 的语义歧义）
  - `POST /admin/users/{id}/extend` body `{days: int}`，**锚点是 `max(now, current_expires_at)`**：过期了从今天起加，没过期从原日期延后；`+N` 续期可叠加，`-N` 也合法（缩短）
- 前端：
  - `api.ts request()` 全局拦截 403 trial_expired：清 session + `window.location.replace('/login?expired=1&at=<iso>')`，避免每个调用方各自处理；只对 `/auth/login` 放行（让登录页自己读 expired_at 显示日期）
  - 抛出 `TrialExpiredError`（自定义）类型供需要区分的调用方用
  - `Login.tsx` 同时处理两条路径：mid-session 被踢回来（`?expired=1&at=...`）+ 直接登录被拒（解析 403 body 里的 expired_at）。文案统一："您的试用已于 5 月 8 日到期。请联系管理员延期。"
  - `Shell.tsx` 顶栏挂"试用还剩 N 天"温和提醒条：`expires_at` 存在且 `≤ 7` 天，桃色 (`#fff7f1`) + Clock icon。0 天展示"试用今天到期"。
  - `/admin/users` 列表新增"有效期"列。`ExpiryCell` 组件：状态徽章（`永久 / 剩 N 天 · X 月 X 日 / 已过期 (red)`）+ 6 个快捷按钮：`+1天 / +3天 / +7天 / +30天 / 自定义 / 设为永久`。"自定义"内嵌 `<input type=date>`，提交时设到当日 23:59:59 让用户多用一天。admin 角色行只显示"永久（管理员）"无控件。
  - 创建用户表单加"有效期"片段：`永久 / 1天 / 3天 / 7天 / 30天` 五选，默认永久。admin 角色时整段隐藏。
- 数据保留：过期只锁登录，**不删数据**。延期后用户重登能继续看到生词本/对话历史等。
- TZ：后端 UTC 存储，前端用 `new Date(iso).getMonth/Date()` 渲染本地时区（中国用户多在 +08）。
- 不做：邮件/短信提醒、自动续费、多套餐、审计字段（谁改的何时改），简单优先。

## `UserOut` 是前端的 session 快照

登录/注册/Google 登录都返回 `TokenOut{access_token, user: UserOut}`，前端把 `user` 整个存进 `localStorage.justspeak_user`，之后 `currentUser()` 只读这份缓存 —— **不会再去问后端**。

所以：**任何影响前端行为的用户级开关，都必须出现在 `UserOut` 里**，否则表现为"每次重新登录就重置"。`onboarding_dismissed`（自由模式）就这么栽过一次。加字段时同步想一下 `patchCurrentUser()` 那条本地更新路径。

## Admin 功能

- 导入查重（409 + 强制重新导入按钮）
- 历史导入表（状态/错误/重试/删除）—— `task.error` 会以红字显示在这张表里，pipeline 用它报"AI 选段没生效，已退回默认窗口"这类**成功但降级**的情况
- Episode Edit 页：🔄 重新提取 Chunks / 重新生成对话 / 翻译中文介绍
- 多段切分下拉 (1-5) + 选段预览 ±15s 微调
- 后台是**给桌面用的**：手机/平板上 admin 走前台，见 [LEARN_UI.md](LEARN_UI.md) 的 `isHandheld()` 那条
