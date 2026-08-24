# 从 favicon 的 logo（深色对话气泡 + 橙色提示点）生成 PWA 安装所需的位图图标。
#
# 为什么要单独生成 PNG：favicon.svg 够浏览器标签页用，但
#   - iOS「添加到主屏幕」只认 <link rel="apple-touch-icon"> 的 PNG，且不吃透明背景（透明会变黑）；
#   - Chrome/Edge 桌面安装要求 manifest 里有 192 与 512 的图标。
# 所以这里一次性把它们画出来，产物提交进 git（前端在 CI 里构建，public/ 下的静态文件会被打进 dist）。
#
# 改了 logo 就重跑：  python frontend/scripts/gen-pwa-icons.py
#
# 依赖：Pillow（pip install Pillow）。仅本地/CI 生成用，不进运行时依赖。
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"
ORANGE = (255, 77, 31, 255)
DARK = (17, 17, 17, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # 超采样倍数，画大再缩小 = 抗锯齿


def render(size: int, content_frac: float = 0.86, bg=None) -> Image.Image:
    """在 size×size 画布上渲染 logo。content_frac 控制 logo 占比（留白/安全区），bg=None 为透明。"""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0) if bg is None else bg)
    d = ImageDraw.Draw(img)
    span = 220.0  # favicon viewBox 是 0 0 220 220
    scale = content_frac * n / span
    off = (n - content_frac * n) / 2.0

    def T(x, y):
        return (off + x * scale, off + y * scale)

    def box(x0, y0, x1, y1):
        return [off + x0 * scale, off + y0 * scale, off + x1 * scale, off + y1 * scale]

    # 对话气泡（圆角矩形 + 左下小尾巴）
    d.rounded_rectangle(box(48, 76, 196, 158), radius=16 * scale, fill=DARK)
    d.polygon([T(96, 158), T(72, 186), T(86, 158)], fill=DARK)
    # 橙色提示点
    cx, cy, r = 142, 38, 14
    d.ellipse(box(cx - r, cy - r, cx + r, cy + r), fill=ORANGE)

    return img.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, name: str):
    p = OUT / name
    img.save(p)
    print("wrote", p.relative_to(OUT.parent))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    # purpose "any"：透明背景，略留白
    save(render(192, content_frac=0.86), "pwa-192.png")
    save(render(512, content_frac=0.86), "pwa-512.png")
    # purpose "maskable"：白底铺满，logo 收进中心安全区（≈内 68%）以防被系统裁掉
    save(render(512, content_frac=0.66, bg=WHITE), "pwa-maskable-512.png")
    # iOS 主屏图标：白底不透明，圆角由系统自动加
    save(render(180, content_frac=0.72, bg=WHITE), "apple-touch-icon.png")
