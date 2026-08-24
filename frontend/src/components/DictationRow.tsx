import { Eye, EyeSlash, Rewind } from "@phosphor-icons/react";

/**
 * Per-subtitle listen widget. Listed inside the SubRow when the Subtitle
 * tab's listen-mode (纯听) is on. Deliberately input-free: the learner
 * just listens and says the line aloud — no typing, no scoring. Two
 * actions only: 🔁 replay this line, 👁 reveal/collapse the原句.
 *
 * Pure controlled component — the Learn page owns the per-line reveal
 * flag so it survives a scroll-out (rows are virtualised / unmounted).
 */
export function DictationRow({
  truth,
  revealed,
  isCurrent,
  onReplay,
  onToggleReveal,
}: {
  truth: string;
  revealed: boolean;       // show the English line, or just the gray prompt
  isCurrent: boolean;      // the row currently being played (highlight)
  onReplay: () => void;    // rewind to this line and play it through
  onToggleReveal: () => void;
}) {
  return (
    <div
      className="mt-1.5 flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}  // don't trigger row's seek
    >
      {/* Inline replay + reveal — no boxy input look. */}
      <button
        onClick={(e) => { e.stopPropagation(); onReplay(); }}
        className={`p-1 rounded-md inline-flex items-center shrink-0 ${isCurrent ? "text-brand hover:bg-[#eaf3ec]" : "text-ink-3 hover:text-ink hover:bg-[#f0f3f0]"}`}
        title="Replay this line (R)"
        aria-label="Replay"
        type="button"
      >
        <Rewind size={14} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onToggleReveal(); }}
        className="p-1 rounded-md text-ink-3 hover:text-ink hover:bg-[#f0f3f0] inline-flex items-center shrink-0"
        type="button"
        title={revealed ? "收起原句" : "查看原句"}
        aria-label={revealed ? "Hide original" : "Reveal original"}
      >
        {revealed ? <EyeSlash size={14} /> : <Eye size={14} />}
      </button>
      {revealed ? (
        <span className="text-base leading-[1.6] break-words text-ink min-w-0">
          {truth}
        </span>
      ) : (
        <span className="text-sm leading-[1.5] text-ink-3 italic min-w-0">
          复述一遍你听到的声音
        </span>
      )}
    </div>
  );
}
