import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";

type Point = { x: number; y: number };
type Transform = Point & { scale: number };
const fit: Transform = { scale: 1, x: 0, y: 0 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function useWheelNavigation(root: RefObject<HTMLDivElement | null>, enabled: boolean, previous: () => void, next: () => void) {
  const callbacks = useRef({ enabled, previous, next });
  callbacks.current = { enabled, previous, next };
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    // Keep the gesture on the viewer so momentum survives photo remounts.
    let last = 0, distance = 0, committed = false;
    const wheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!callbacks.current.enabled || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        !target?.closest(".image-gesture-stage") || target.closest("button,a,input")) return;
      const now = performance.now();
      if (now - last > 180) { distance = 0; committed = false; }
      last = now;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1;
      const dx = event.deltaX * unit, dy = event.deltaY * unit;
      if (Math.abs(dx) <= Math.abs(dy) * 1.3) return;
      event.preventDefault();
      if (committed) return;
      distance += dx;
      if (Math.abs(distance) < 60) return;
      committed = true;
      if (distance > 0) callbacks.current.next(); else callbacks.current.previous();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [root]);
}

export function useImageGestures(id: string, enabled: boolean, previous: () => void, next: () => void, close: () => void, tap: () => void, hasPrevious = true, hasNext = true) {
  const stage = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState(fit);
  const [dragging, setDragging] = useState(false);
  const current = useRef(fit);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; initial: Transform; moved: boolean; time: number; axis?: "x" | "y"; pinch?: { distance: number; center: Point; initial: Transform } } | undefined>(undefined);
  const suppressClick = useRef(false);
  const frame = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTouch = useRef(0);
  const lastTap = useRef<{ point: Point; time: number } | undefined>(undefined);
  const callbacks = useRef({ previous, next, close, tap });
  callbacks.current = { previous, next, close, tap };

  function apply(value: Transform) {
    current.current = value;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setTransform(value));
  }
  function reset() { apply(fit); }
  useEffect(() => {
    reset(); setDragging(false); pointers.current.clear(); gesture.current = undefined; suppressClick.current = false; lastTap.current = undefined;
    return () => { cancelAnimationFrame(frame.current); clearTimeout(tapTimer.current); };
  }, [id, enabled]);

  function bounded(element: HTMLElement, value: Transform): Transform {
    if (value.scale <= 1) return fit;
    const frame = element.querySelector<HTMLElement>(".viewer-image-frame");
    const image = element.querySelector("img");
    const width = Number(frame?.dataset.imageWidth) || image?.naturalWidth || element.clientWidth;
    const height = Number(frame?.dataset.imageHeight) || image?.naturalHeight || element.clientHeight;
    const ratio = Math.min(element.clientWidth / width, element.clientHeight / height);
    const x = Math.max(0, (width * ratio * value.scale - element.clientWidth) / 2);
    const y = Math.max(0, (height * ratio * value.scale - element.clientHeight) / 2);
    return { scale: value.scale, x: Math.max(-x, Math.min(x, value.x)), y: Math.max(-y, Math.min(y, value.y)) };
  }
  function zoom(element: HTMLElement, point: Point, scale: number) {
    const rect = element.getBoundingClientRect();
    const ratio = scale / current.current.scale;
    const x = point.x - rect.left - rect.width / 2;
    const y = point.y - rect.top - rect.height / 2;
    apply(bounded(element, { scale, x: x - ratio * (x - current.current.x), y: y - ratio * (y - current.current.y) }));
  }
  function toggle(point?: Point) {
    const element = stage.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    zoom(element, point || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, current.current.scale > 1 ? 1 : 2.5);
  }
  useEffect(() => {
    const element = stage.current;
    if (!element || !enabled) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("button,a,input") || (!event.ctrlKey && current.current.scale === 1)) return;
      event.preventDefault();
      clearTimeout(tapTimer.current);
      if (event.ctrlKey) zoom(element, { x: event.clientX, y: event.clientY }, Math.max(1, Math.min(5, current.current.scale * Math.exp(-event.deltaY * .01))));
      else apply(bounded(element, { ...current.current, x: current.current.x - event.deltaX, y: current.current.y - event.deltaY }));
    };
    const resize = new ResizeObserver(() => apply(bounded(element, current.current)));
    resize.observe(element);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { resize.disconnect(); element.removeEventListener("wheel", wheel); };
  }, [enabled]);
  function down(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || (event.target as HTMLElement).closest("button,a,video,input") || event.button !== 0) return;
    clearTimeout(tapTimer.current);
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 1) {
      suppressClick.current = false;
      gesture.current = { start: point, initial: current.current, moved: false, time: performance.now() };
    } else if (pointers.current.size === 2 && gesture.current) {
      const [left, right] = [...pointers.current.values()];
      gesture.current.moved = true;
      gesture.current.pinch = { distance: distance(left, right), center: middle(left, right), initial: current.current };
      suppressClick.current = true;
    }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = gesture.current;
    const dx = event.clientX - active.start.x;
    const dy = event.clientY - active.start.y;
    if (Math.hypot(dx, dy) > 8) { active.moved = true; suppressClick.current = true; setDragging(true); }
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
    } else if (active.moved && !active.pinch) {
      active.axis ||= Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (active.axis === "x") apply({ scale: 1, x: dx * ((dx > 0 ? hasPrevious : hasNext) ? .85 : .18), y: 0 });
      else apply({ scale: 1, x: 0, y: Math.max(0, dy) * .65 });
    }
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    if (event.pointerType !== "mouse") lastTouch.current = performance.now();
    pointers.current.delete(event.pointerId);
    const active = gesture.current;
    if (!pointers.current.size) {
      setDragging(false);
      if (enabled && active && !active.pinch && active.initial.scale === 1 && current.current.scale === 1) {
        const dx = event.clientX - active.start.x;
        const dy = event.clientY - active.start.y;
        const elapsed = Math.max(1, performance.now() - active.time);
        const swipe = Math.abs(dx) > Math.min(100, event.currentTarget.clientWidth * .2) || Math.abs(dx) > 35 && Math.abs(dx) / elapsed > .45;
        if (swipe && Math.abs(dx) > Math.abs(dy) * 1.3) {
          suppressClick.current = true;
          if (dx < 0) callbacks.current.next(); else callbacks.current.previous();
        } else if (dy > 110 && dy > Math.abs(dx) * 1.5) {
          suppressClick.current = true;
          callbacks.current.close();
        }
        reset();
      }
      if (enabled && active && !active.moved && event.pointerType !== "mouse") {
        const point = { x: event.clientX, y: event.clientY };
        const now = performance.now();
        if (lastTap.current && now - lastTap.current.time < 300 && distance(lastTap.current.point, point) < 28) {
          clearTimeout(tapTimer.current); lastTap.current = undefined; toggle(point);
        } else {
          lastTap.current = { point, time: now };
          tapTimer.current = setTimeout(() => callbacks.current.tap(), 280);
        }
        suppressClick.current = true;
      }
      gesture.current = undefined;
    } else if (pointers.current.size === 1 && active) {
      active.start = [...pointers.current.values()][0];
      active.initial = current.current;
    }
  }
  function cancel() {
    pointers.current.clear(); gesture.current = undefined; suppressClick.current = true; setDragging(false);
    if (stage.current) apply(bounded(stage.current, current.current));
  }
  function click(event: MouseEvent<HTMLDivElement>) {
    if (!enabled || (event.target as HTMLElement).closest("button,a,video,input")) return;
    if (suppressClick.current) { suppressClick.current = false; return; }
    clearTimeout(tapTimer.current);
    if (event.detail < 2) tapTimer.current = setTimeout(() => callbacks.current.tap(), 240);
  }
  function doubleClick(event: MouseEvent<HTMLDivElement>) {
    if (!enabled || (event.target as HTMLElement).closest("button,a,video,input")) return;
    clearTimeout(tapTimer.current);
    // Touch double taps are handled on pointerup, before the compatibility click events.
    if (performance.now() - lastTouch.current < 700) return;
    toggle({ x: event.clientX, y: event.clientY });
  }
  return { stage, transform, dragging, reset, toggle, handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: cancel, onClick: click, onDoubleClick: doubleClick } };
}
