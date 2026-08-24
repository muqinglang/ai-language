import { useEffect, useState } from "react";

/**
 * Tracks the visual viewport (the area NOT covered by the on-screen
 * keyboard) via the `window.visualViewport` API. Returns the height of
 * the visible region and the offset of its top edge relative to the
 * layout viewport.
 *
 * Why: a `position: fixed` overlay is sized against the *layout*
 * viewport, which on iOS Safari does NOT shrink when the keyboard opens
 * (`100vh`/`100dvh` both ignore the keyboard). Safari instead scrolls
 * the whole fixed layer up to reveal the focused input, pushing the top
 * of a centered modal off-screen and the action button under the
 * keyboard. Feeding these values into the overlay's inline style makes
 * it cover exactly the visible region above the keyboard, so an input +
 * its submit button always stay reachable.
 *
 * On desktop (no visualViewport quirks) this returns the full window
 * height with offset 0 — i.e. equivalent to `inset-0`, no behaviour
 * change.
 */
export function useVisualViewport(): { height: number; offsetTop: number } {
  const [vp, setVp] = useState(() => ({
    height: typeof window !== "undefined" ? window.innerHeight : 0,
    offsetTop: 0,
  }));

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVp({ height: vv.height, offsetTop: vv.offsetTop });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return vp;
}
