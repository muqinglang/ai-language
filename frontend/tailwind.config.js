/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // D4：全站换成白绿。中性色带绿偏 —— 纯灰读起来像"没挑过"，
        // 微微偏向品牌色读起来才像"选过的"。
        ink: {
          DEFAULT: "#16211f",
          2: "#596861",
          // #819087 是参考色板给的三级色，但它在页面底上只有 3.11:1，
          // 达不到正文 4.5:1 —— 而三级文字恰恰常常是 10px 的时间戳和
          // 提示语，最需要对比度的地方。压深到 4.58:1。
          // （改前的 #a1a5ad 更糟，只有 2.37:1。）
          3: "#657469",
        },
        line: "#dce4dc",
        brand: "#2f755f",
        "brand-strong": "#285e48",

        // 白绿色板。D4 已经把 brand/ink/line 换成绿系，这一组是完整的
        // 命名 token，新代码优先用它，而不是再写 hex。
        leaf: {
          canvas: "#f5f7f4",   // 页面底
          surface: "#ffffff",  // 卡片 / 输入框
          mint: "#eaf3ec",     // 柔和绿底
          line: "#dce4dc",     // 描边 / 分隔
          DEFAULT: "#2f755f",  // 品牌绿 / 主按钮
          strong: "#285e48",   // 按下 / 强调
          ink: "#16211f",      // 主文字
          muted: "#596861",    // 次要文字
          faint: "#657469",    // 三级 / 提示
          danger: "#b4462f",   // 破坏性操作
        },

        // Chunk 四色是**功能色**不是装饰 —— 它区分 idiomatic /
        // collocation / discourse / functional 四类表达。全站转白绿后
        // 保留原样：能一眼分清四类，比配色统一更值钱。
        chunk: {
          1: "#ffe28a",
          2: "#b8d1ff",
          3: "#b3ecc7",
          4: "#d9c1ff",
        },
      },
      // 字号档位（D2）。Tailwind 自带的 xs/sm/base/lg 正好是 12/14/16/18，
      // 只补一个 10px 档 —— 学习界面信息密集，10px 的微标签（Item 序号、
      // 场景标签、徽章）是有存在价值的，硬提到 12px 会让一屏装不下东西。
      //
      // 收敛的价值在**档位少**，不在字变大：原来 10/10.5/11/11.5/12/12.5/
      // 13/13.5/14/15/16/17 十二种，0.5px 的差别肉眼分不出，只是说明每处
      // 都是当时随手定的。现在五档，每一档说得出用在哪。
      fontSize: {
        "2xs": ["10px", "14px"],   // 微标签：序号、场景、徽章、逾期、作者名
        // xs   12/16  次要说明、日期、hint、列表副行
        // sm   14/20  按钮、tab、列表主行、正文
        // base 16/24  题面、答案、例句、字幕
        // lg   18/28  区块标题、单词
        // xl   20/28  页面标题
        // 2xl  24/32  统计数字、大标题
      },
      fontFamily: {
        sans: ['Inter', '"Noto Sans SC"', "system-ui", "sans-serif"],
      },
      // 圆角三档 + 嵌套公式：内圆角 = 外圆角 − 间距（结果 ≤2px 用直角）。
      // 现在全站 7 种圆角随机混用，卡片里嵌卡片会"鼓"。
      borderRadius: { xl: "14px", card: "16px", ctl: "12px", in: "8px" },

      // 全站统一缓动。**但不是所有动效都用 700ms**：
      //   导航 / 弹层 / 展开收起 → duration-700（有质量感）
      //   按钮按下 / 字幕高亮 / 打分 → duration-150（要即时反馈）
      // 学习产品里播放类交互慢一拍就像卡住了。
      transitionTimingFunction: { spring: "cubic-bezier(.32,.72,0,1)" },
    },
  },
  plugins: [],
};
