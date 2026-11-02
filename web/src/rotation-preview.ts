import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export const normalizeRotation = (rotation = 0) => (rotation % 360 + 360) % 360;

export function displayDimensions(media: { width: number; height: number; rotation?: number }) {
  return normalizeRotation(media.rotation) % 180
    ? { width: media.height, height: media.width }
    : { width: media.width, height: media.height };
}

export function useRotationPreview(frame: RefObject<HTMLElement | null>, rotation: number): CSSProperties | undefined {
  const quarterTurn = normalizeRotation(rotation) % 180 !== 0;
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || !quarterTurn) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame, quarterTurn]);
  if (!rotation) return undefined;
  // Swapping the fitting rectangle keeps a quarter-turn preview inside its viewport.
  return {
    position: "absolute",
    inset: "auto",
    left: "50%",
    top: "50%",
    width: quarterTurn && size.height ? size.height : "100%",
    height: quarterTurn && size.width ? size.width : "100%",
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
  };
}
