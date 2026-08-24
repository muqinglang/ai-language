import { useEffect, useState } from "react";

/** Widest viewport we still treat as handheld when the pointer is coarse.
 *  An iPad Pro in landscape is 1366px — deliberately included, because it
 *  is still a tablet held in your hands, not a workstation. */
const COARSE_MAX_PX = 1440;
/** With a mouse, only genuinely small windows count as handheld. */
const FINE_MAX_PX = 1024;

/** True on phones and tablets.
 *
 *  Width alone can't tell an iPad Pro from a laptop, and pointer type alone
 *  can't tell a touchscreen laptop from a tablet, so this uses both: a
 *  coarse (finger) primary pointer up to tablet width, or any window narrow
 *  enough that the desktop layout wouldn't fit anyway.
 */
export function isHandheld(): boolean {
  if (typeof window === "undefined") return false;
  const w = window.innerWidth;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse ? w <= COARSE_MAX_PX : w <= FINE_MAX_PX;
}

/** isHandheld() as state, re-evaluated when the window or orientation
 *  changes — rotating an iPad must not strand you in a layout meant for
 *  the other orientation. */
export function useIsHandheld(): boolean {
  const [handheld, setHandheld] = useState(isHandheld);
  useEffect(() => {
    const update = () => setHandheld(isHandheld());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return handheld;
}
