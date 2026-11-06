import { useLayoutEffect } from "react";

let scrollLocks = 0;
let restoreScroll: (() => void) | undefined;

export function usePageScrollLock() {
  useLayoutEffect(() => {
    if (scrollLocks++ === 0) {
      const root = document.documentElement;
      const body = document.body;
      const rootOverflow = root.style.overflow;
      const bodyOverflow = body.style.overflow;
      const { scrollX, scrollY } = window;
      root.style.overflow = "hidden";
      body.style.overflow = "hidden";
      restoreScroll = () => {
        root.style.overflow = rootOverflow;
        body.style.overflow = bodyOverflow;
        window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      };
    }
    return () => {
      // Comparisons can cover a viewer; only the last photo dialog unlocks the page.
      if (--scrollLocks === 0) {
        restoreScroll?.();
        restoreScroll = undefined;
      }
    };
  }, []);
}

export function zoomPhotoWithWheel(scale: number, event: WheelEvent, viewportHeight: number) {
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1);
  return Math.max(1, Math.min(5, scale * Math.exp(-delta * 0.002)));
}
