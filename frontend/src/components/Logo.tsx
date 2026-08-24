export function LogoMark({ size = 32, fill = "#111" }: { size?: number; fill?: string }) {
  return (
    <svg viewBox="0 0 220 220" width={size} height={size} aria-label="justSpeak">
      <circle cx="142" cy="38" r="14" fill="#2f755f" />
      <path
        d="M 48 76 L 180 76 Q 196 76 196 92 L 196 142 Q 196 158 180 158 L 96 158 L 72 186 L 82 158 Q 60 158 60 142 L 60 92 Q 60 76 76 76 Z"
        fill={fill}
      />
    </svg>
  );
}

export function Wordmark({
  size = 18,
  tone = "light",
}: {
  size?: number;
  tone?: "light" | "dark";
}) {
  return (
    <span
      className="wm"
      style={{ fontSize: size, color: tone === "dark" ? "#fff" : "#111" }}
    >
      <span className="just" style={tone === "dark" ? { opacity: 0.75 } : undefined}>
        just
      </span>
      <span className="speak">Speak</span>
    </span>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <LogoMark size={size} />
      <Wordmark size={size * 0.65} />
    </div>
  );
}
