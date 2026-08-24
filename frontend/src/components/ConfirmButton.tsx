import { useEffect, useRef, useState } from "react";

/**
 * 需要二次确认的按钮：第一次点变成「确认 / 取消」，再点才真执行。
 *
 * 替代 `window.confirm()`。原生对话框有三个实打实的问题：它阻塞整个页面
 * （连滚动都停）、样式完全不可控、而且在手机上是从屏幕顶部弹下来的系统条，
 * 跟你正在点的那一行完全脱节 —— 用户经常不知道自己在确认哪一条。
 *
 * 内联确认没有这些问题，而且危险操作留在原地：你看着那条笔记按下确认。
 *
 * 5 秒无操作自动收回。危险操作不该长期挂着一个"确认"按钮等人误触。
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "确认删除",
  className = "",
  title,
  disabled,
}: {
  onConfirm: () => void;
  children: React.ReactNode;
  confirmLabel?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), 5000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setArmed(true);
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="text-2xs px-2 py-1 rounded-md bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] hover:bg-[#fee2e2] active:scale-[.98] transition-[background-color,transform] duration-150 ease-spring"
        onClick={(e) => {
          e.stopPropagation();
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="text-2xs px-2 py-1 rounded-md text-ink-3 hover:text-ink active:scale-[.98] transition-[color,transform] duration-150 ease-spring"
        onClick={(e) => {
          e.stopPropagation();
          setArmed(false);
        }}
      >
        取消
      </button>
    </span>
  );
}
