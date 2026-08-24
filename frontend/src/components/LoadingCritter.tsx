/**
 * 等待态里的那只小动物。
 *
 * 用在"要等十几秒、屏幕上什么都没有"的地方 —— 推荐词第一次生成、Rephrase
 * 生成、听力故事生成。这些都是真的要等模型跑完，快不了；能改的只有"这段
 * 时间里页面看上去是活的还是死的"。一行灰字加一个转圈，等到第 15 秒的时候
 * 和卡死长得一模一样。
 *
 * 画法上只有一条规矩：**靠形状可爱，不靠细节**。小到 112px 的时候，胡须、
 * 爪垫、毛流这些全都糊成噪点；真正起作用的是大脑袋、圆轮廓、闭着的眼睛。
 * 第一版画了只鸟，塞了呆毛、尾羽、种子，结果就是一坨看不清的东西。
 *
 * 全部是内联 SVG + CSS keyframes，没有依赖、没有 GIF、没有 Lottie。
 * 关键帧在 index.css 里（多关键帧 + transform-origin，Tailwind 表达不了）。
 * `prefers-reduced-motion` 下全部停住，静止的那一帧本身就是完整插画。
 *
 * 按钮里的小转圈不要换成这个 —— 那些是几百毫秒的操作反馈，塞只动物进去
 * 只会显得吵。这个组件是给整块空屏用的。
 */

type Critter = "cat" | "shiba";

const FUR = {
  cat: { coat: "#efe0c8", shade: "#ddc9a8", light: "#f9f1e3" },
  shiba: { coat: "#e2a15c", shade: "#c98844", light: "#faf1e4" },
};
const INK = "#4a3c2c";
const BLUSH = "#f0b0a8";

export function LoadingCritter({
  label,
  hint,
  critter = "cat",
  className = "",
}: {
  label: string;
  /** 第二行，通常是"大概要多久"。等待里最值钱的信息就是这个。 */
  hint?: string;
  critter?: Critter;
  className?: string;
}) {
  return (
    <div
      className={`grid place-items-center gap-3 text-center ${className}`}
      role="status"
      aria-live="polite"
    >
      {/* aria-hidden：下面的文字已经把状态说清楚了，读屏再念一遍
          "加载中的插画"是噪音。 */}
      <svg
        width="120"
        height="84"
        viewBox="0 0 120 84"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        {/* 地面。一条淡淡的虚线，给"趴着/坐着"一个参照物 —— 没有它，
            整只动物只是浮在白底上。 */}
        <line
          x1="18" y1="70" x2="102" y2="70"
          stroke="#dce4dc" strokeWidth="1.5" strokeLinecap="round"
          strokeDasharray="3 5"
        />
        <ellipse cx="58" cy="70" rx="26" ry="3.5" fill="#2f755f" opacity=".12" />

        {critter === "cat" ? <CatLoaf /> : <ShibaSit />}
      </svg>

      <div className="text-sm text-ink-2">{label}</div>
      {hint && <div className="text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}

/** 趴成一个面包的猫。轮廓就一个圆顶 + 两只耳朵 —— 猫趴着的时候本来就
 *  看不见腿和脖子，所以这个姿势最省笔画，也最像。 */
function CatLoaf() {
  const c = FUR.cat;
  return (
    <>
      {/* 尾巴先画，绕到身体后面。它是这张图里唯一持续在动的东西。 */}
      <path
        d="M86 64 C100 66 108 56 102 46"
        stroke={c.coat} strokeWidth="7" strokeLinecap="round" fill="none"
        className="critter-tail"
      />
      <g className="critter-breathe">
        {/* 耳朵。左耳偶尔抖一下。 */}
        <g className="critter-ear">
          <path d="M40 41 L36 24 L53 33 Z" fill={c.coat} />
          <path d="M42 38 L40 29 L48 34 Z" fill={BLUSH} opacity=".7" />
        </g>
        <path d="M76 41 L80 24 L63 33 Z" fill={c.coat} />
        <path d="M74 38 L76 29 L68 34 Z" fill={BLUSH} opacity=".7" />

        {/* 身体：一个平底圆顶 */}
        <path d="M28 68 C28 42 42 33 58 33 C74 33 88 42 88 68 Z" fill={c.coat} />

        {/* 头顶三道虎斑。深一档就够了，画多了小尺寸下全糊在一起。 */}
        <g stroke={c.shade} strokeWidth="2.6" strokeLinecap="round" fill="none">
          <path d="M47 40 Q50 35 53 40" />
          <path d="M56 37 Q59 32 62 37" />
          <path d="M65 40 Q68 35 71 40" />
        </g>

        {/* 前爪：两小坨，压在身体下沿 */}
        <ellipse cx="47" cy="66" rx="7.5" ry="4" fill={c.light} />
        <ellipse cx="65" cy="66" rx="7.5" ry="4" fill={c.light} />

        {/* 脸。闭着的眼睛比睁着的好画太多，也更像"我很满足，你慢慢等"。 */}
        <g stroke={INK} strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path d="M45 52 Q50 47 55 52" />
          <path d="M61 52 Q66 47 71 52" />
        </g>
        <ellipse cx="40" cy="56" rx="4.5" ry="2.8" fill={BLUSH} opacity=".55" />
        <ellipse cx="76" cy="56" rx="4.5" ry="2.8" fill={BLUSH} opacity=".55" />
        <path d="M55 56 L61 56 L58 59.5 Z" fill="#e0938c" />
        <g stroke={INK} strokeWidth="1.8" strokeLinecap="round" fill="none">
          <path d="M58 59.5 Q55 63 52 60" />
          <path d="M58 59.5 Q61 63 64 60" />
        </g>
      </g>
    </>
  );
}

/** 坐着的柴犬。招牌是卷尾巴和白脸颊 —— 这两样在的话，哪怕只有 112px
 *  也一眼认得出是柴犬；少一样就变成"某种橙色的狗"。 */
function ShibaSit() {
  const c = FUR.shiba;
  return (
    <>
      {/* 尾巴要卷得紧、而且要压在背上方。上一版是个松松的问号，那是猫尾
          不是柴犬尾。 */}
      <path
        d="M76 58 C92 60 99 47 90 43 C84.5 40.5 82 47 87.5 48"
        stroke={c.coat} strokeWidth="7" strokeLinecap="round" fill="none"
        className="critter-tail"
      />
      <g className="critter-breathe">
        {/* 身体：坐姿，下宽上窄 */}
        <path d="M36 68 C36 50 46 42 58 42 C70 42 80 50 80 68 Z" fill={c.coat} />
        {/* 胸口和前腿的奶白 */}
        <path d="M58 46 C64 52 65 60 63 68 L53 68 C51 60 52 52 58 46 Z" fill={c.light} />
        <ellipse cx="50" cy="66.5" rx="6" ry="3.5" fill={c.light} />
        <ellipse cx="66" cy="66.5" rx="6" ry="3.5" fill={c.light} />

        {/* 耳朵：又宽又短的三角。上一版又细又高，配上尖脸就成了狐狸 ——
            柴犬的耳朵是厚实的小三角，底边几乎和高一样宽。 */}
        <g className="critter-ear">
          <path d="M44 28 L43 14 L58 21 Z" fill={c.coat} />
          <path d="M46 25 L45.5 18 L52.5 21.5 Z" fill={BLUSH} opacity=".65" />
        </g>
        <path d="M72 28 L73 14 L58 21 Z" fill={c.coat} />
        <path d="M70 25 L70.5 18 L63.5 21.5 Z" fill={BLUSH} opacity=".65" />

        {/* 头：宽大于高。狐狸是尖脸，柴犬是圆脸盘。 */}
        <ellipse cx="58" cy="34" rx="17" ry="14.5" fill={c.coat} />
        {/* 白脸颊 + 白吻部：柴犬脸上的浅色分布，去掉就不像了 */}
        <ellipse cx="45.5" cy="37" rx="7" ry="7.5" fill={c.light} />
        <ellipse cx="70.5" cy="37" rx="7" ry="7.5" fill={c.light} />
        <ellipse cx="58" cy="40" rx="10.5" ry="7.5" fill={c.light} />

        {/* 脸 */}
        <circle cx="51" cy="32" r="2.4" fill={INK} />
        <circle cx="65" cy="32" r="2.4" fill={INK} />
        <ellipse cx="58" cy="37" rx="3" ry="2.3" fill={INK} />
        <g stroke={INK} strokeWidth="1.8" strokeLinecap="round" fill="none">
          <path d="M58 39.3 Q54.5 43.5 51.5 40.3" />
          <path d="M58 39.3 Q61.5 43.5 64.5 40.3" />
        </g>
      </g>
    </>
  );
}
