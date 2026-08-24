import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // PWA：让站点可安装（桌面 Chrome/Edge「安装应用」、iPad/iPhone「添加到主屏幕」）。
    //
    // 缓存安全是这里的第一原则 —— 这是个有 SSE 流式对话、TTS、BYOK 动态数据的站，
    // 任何被 Service Worker 缓存的 API 响应都会让用户看到旧数据或让流式中断。规则：
    //   • 只预缓存构建产物（带内容 hash 的 js/css + 图标字体），这些改一次名就换一份，天然安全。
    //   • /api/ 和 /media/ 一律不配 runtimeCaching —— Workbox 的 generateSW 只接管
    //     「预缓存过的」和「runtimeCaching 命中的」请求，其余一律直连网络。不给它们规则，
    //     就等于 NetworkOnly，SW 完全不碰。这是保证功能正常的关键，别手滑给 /api 加缓存。
    //   • HTML 走 navigateFallback 用预缓存的 index.html；每次发版 index.html 内容变、
    //     其预缓存 revision 变，autoUpdate 会拉新 SW 并在下次导航接管，不会卡在旧壳。
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      // 这些放 public/ 的静态资源要被预缓存 / 被 manifest 引用
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "justSpeak · 只需要开口",
        short_name: "justSpeak",
        description: "看真实 YouTube 视频学英语口语，跟着双语字幕练地道表达。",
        lang: "zh",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // 预缓存：只收构建产物；media 不在 dist 里，天然不会被收
        globPatterns: ["**/*.{js,css,html,svg,woff,woff2,ico,png}"],
        // video.js 主 chunk 偏大，放宽单文件预缓存上限（默认 2 MiB）
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // SPA 导航兜底用预缓存的 index.html —— 但下面这些前缀是真实后端/媒体/文档，
        // 绝不能被替换成前端壳，否则 API 请求会拿到 HTML。
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/media\//,
          /^\/docs$/,
          /^\/openapi\.json$/,
        ],
        // 只给跨域的 Google 字体加运行时缓存（纯静态、可长期缓存）。
        // 注意：这里刻意没有 /api、/media 的任何条目 —— 见上方说明。
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
});
