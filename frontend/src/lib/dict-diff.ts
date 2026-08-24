/**
 * Dictation comparison: line-level word diff with close-match grading.
 *
 * Tokens are matched via LCS (longest common subsequence) on a
 * case-folded, punctuation-stripped form so a missing comma or a stray
 * capital doesn't count as wrong. Each ORIGINAL token gets a status:
 *
 *   "ok"    — exact match (case + punctuation ignored)
 *   "close" — within Levenshtein distance ≤ 2 of what the user typed
 *             at the same LCS slot ("teh" ~ "the")
 *   "miss"  — the user didn't type a matching word in that slot
 *
 * Each USER token that isn't part of the LCS alignment is "extra".
 *
 * Strict on contractions: "it's" ≠ "it is". Learners should hear
 * the contraction.
 */
export type WordStatus = "ok" | "close" | "miss" | "extra";

export type DiffWord = {
  text: string;       // the original token (with punctuation preserved)
  status: WordStatus; // "ok" | "close" | "miss" — never "extra" on original side
  user?: string;      // when status==="close", what the user actually typed
};

export type ExtraWord = {
  text: string;
};

export type DictDiff = {
  original: DiffWord[]; // every token from the canonical line, in order
  extras: ExtraWord[];  // user-typed tokens that have no slot in original
  total: number;        // original token count
  correct: number;      // count of "ok" + "close"
  accuracy: number;     // correct / total, 0..1; 1 when total == 0
};

/** Strip surrounding punctuation, fold case. Inner punctuation kept so
 * "don't" stays "don't" — that's intentional. */
function normalise(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

/** Tokenise on whitespace, drop empties, preserve original casing+punct
 * in the returned tokens (the normalised form is computed on demand). */
function tokenise(text: string): string[] {
  return text.split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

/** Standard iterative Levenshtein. Capped at a small max for speed
 * since we only use it to detect "close" misses on word pairs. */
function levenshtein(a: string, b: string, cap: number = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Compute LCS alignment between two token arrays using normalised
 * forms. Returns paired indices [origIdx, userIdx] for matches. */
function lcsAlign(orig: string[], user: string[]): Array<[number, number]> {
  const a = orig.map(normalise);
  const b = user.map(normalise);
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[0..i) and b[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] && a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack to recover the alignment.
  const pairs: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] && a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

export function dictDiff(originalText: string, userText: string): DictDiff {
  const orig = tokenise(originalText);
  const user = tokenise(userText);
  const total = orig.length;

  if (total === 0) {
    return { original: [], extras: [], total: 0, correct: 0, accuracy: 1 };
  }

  const aligned = lcsAlign(orig, user);
  const okMap = new Map<number, number>(); // origIdx -> userIdx (exact)
  const usedUser = new Set<number>();
  for (const [oi, ui] of aligned) {
    okMap.set(oi, ui);
    usedUser.add(ui);
  }

  // Walk original tokens; for slots not in LCS, try a "close" match
  // against an unused user token near the expected position (within ±2
  // slots — beyond that it's probably a different word, not a typo).
  const originalOut: DiffWord[] = orig.map((t, oi) => {
    if (okMap.has(oi)) {
      return { text: t, status: "ok" };
    }
    const want = normalise(t);
    // Find nearest unused user token in a small window.
    const lastBefore = aligned.filter(([o]) => o < oi).map(([, u]) => u).pop() ?? -1;
    const firstAfter = aligned.filter(([o]) => o > oi).map(([, u]) => u)[0] ?? user.length;
    let best: { ui: number; dist: number } | null = null;
    for (let ui = lastBefore + 1; ui < firstAfter; ui++) {
      if (usedUser.has(ui)) continue;
      const got = normalise(user[ui]);
      if (!got) continue;
      const d = levenshtein(want, got, 2);
      if (d <= 2 && (best === null || d < best.dist)) {
        best = { ui, dist: d };
      }
    }
    if (best) {
      usedUser.add(best.ui);
      return { text: t, status: "close", user: user[best.ui] };
    }
    return { text: t, status: "miss" };
  });

  const extras: ExtraWord[] = [];
  for (let ui = 0; ui < user.length; ui++) {
    if (!usedUser.has(ui)) extras.push({ text: user[ui] });
  }

  const correct = originalOut.filter((w) => w.status === "ok" || w.status === "close").length;
  return {
    original: originalOut,
    extras,
    total,
    correct,
    accuracy: correct / total,
  };
}

/** Render a partially-revealed version of the line for the 💡 hint
 * button. levels: 1 = first letter of each word, 2 = first two letters,
 * 3 = full reveal. */
export function buildHint(text: string, level: number): string {
  const toks = tokenise(text);
  if (level >= 3) return text;
  const keep = level >= 2 ? 2 : 1;
  return toks
    .map((t) => {
      // Keep leading punctuation (e.g. "(") attached to the prefix.
      const m = t.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}]+)([^\p{L}\p{N}]*)$/u);
      if (!m) return t;
      const [, pre, body, post] = m;
      const visible = body.slice(0, Math.min(keep, body.length));
      const hidden = "_".repeat(Math.max(0, body.length - keep));
      return `${pre}${visible}${hidden}${post}`;
    })
    .join(" ");
}
