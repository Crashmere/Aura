import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

type Point = { x: number; y: number };
type Transform = { scale: number; x: number; y: number };
const fit: Transform = { scale: 1, x: 0, y: 0 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function useImageGestures(id: string, enabled: boolean, previous: () => void, next: () => void) {
  const [transform, setTransform] = useState(fit);
  const current = useRef(fit);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; initial: Transform; moved: boolean; pinch?: { distance: number; center: Point; initial: Transform } } | undefined>(undefined);
  const suppressClick = useRef(false);

  function apply(value: Transform) {
    current.current = value;
    setTransform(value);
  }
  function reset() { apply(fit); }
  useEffect(() => { reset(); pointers.current.clear(); gesture.current = undefined; suppressClick.current = false; }, [id, enabled]);

  function bounded(element: HTMLElement, value: Transform): Transform {
    if (value.scale <= 1) return fit;
    const image = element.querySelector("img");
    if (!image) return value;
    const rect = image.getBoundingClientRect();
    const x = Math.max(0, (rect.width / current.current.scale * value.scale - element.clientWidth) / 2);
    const y = Math.max(0, (rect.height / current.current.scale * value.scale - element.clientHeight) / 2);
    return { scale: value.scale, x: Math.max(-x, Math.min(x, value.x)), y: Math.max(-y, Math.min(y, value.y)) };
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || (event.target as HTMLElement).closest("button,a,video,input") || event.pointerType === "mouse" && current.current.scale === 1) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 1) {
      suppressClick.current = false;
      gesture.current = { start: point, initial: current.current, moved: false };
    } else if (pointers.current.size === 2) {
      const [left, right] = [...pointers.current.values()];
      if (gesture.current) {
        gesture.current.moved = true;
        gesture.current.pinch = { distance: distance(left, right), center: middle(left, right), initial: current.current };
      }
      suppressClick.current = true;
    }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = gesture.current;
    const dx = event.clientX - active.start.x;
    const dy = event.clientY - active.start.y;
    if (Math.hypot(dx, dy) > 8) { active.moved = true; suppressClick.current = true; }
    if (pointers.current.size === 2 && active.pinch) {
      const [left, right] = [...pointers.current.values()];
      const center = middle(left, right);
      const scale = Math.max(1, Math.min(5, active.pinch.initial.scale * distance(left, right) / Math.max(1, active.pinch.distance)));
      const ratio = scale / active.pinch.initial.scale;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = center.x - rect.left - rect.width / 2 - ratio * (active.pinch.center.x - rect.left - rect.width / 2 - active.pinch.initial.x);
      const y = center.y - rect.top - rect.height / 2 - ratio * (active.pinch.center.y - rect.top - rect.height / 2 - active.pinch.initial.y);
      apply(bounded(event.currentTarget, { scale, x, y }));
    } else if (current.current.scale > 1) {
      apply(bounded(event.currentTarget, { scale: current.current.scale, x: active.initial.x + dx, y: active.initial.y + dy }));
    }
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const active = gesture.current;
    if (!pointers.current.size) {
      if (enabled && active && !active.pinch && active.initial.scale === 1 && current.current.scale === 1) {
        const dx = event.clientX - active.start.x;
        const dy = event.clientY - active.start.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          suppressClick.current = true;
          if (dx < 0) next(); else previous();
        }
      }
      gesture.current = undefined;
    } else if (pointers.current.size === 1 && active) {
      active.start = [...pointers.current.values()][0];
      active.initial = current.current;
    }
  }
  function cancel() { pointers.current.clear(); gesture.current = undefined; suppressClick.current = true; }
  function toggle() {
    if (suppressClick.current) { suppressClick.current = false; return; }
    apply(current.current.scale === 1 ? { scale: 2, x: 0, y: 0 } : fit);
  }
  function click(event: MouseEvent<HTMLDivElement>) {
    if (!enabled || (event.target as HTMLElement).closest("button,a,video,input")) return;
    const image = event.currentTarget.querySelector("img");
    if (image && (event.target === image || event.target === event.currentTarget)) toggle();
  }
  return {
    transform,
    reset,
    toggle,
    handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: cancel, onClick: click },
  };
}
