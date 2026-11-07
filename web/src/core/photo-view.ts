import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";

let scrollLocks = 0;
let restoreScroll: (() => void) | undefined;
const pendingScrolls = new Set<() => void>();

export function whenPageScrollUnlocked(scroll: () => void): () => void {
  if (scrollLocks === 0) {
    scroll();
    return () => {};
  }
  pendingScrolls.add(scroll);
  return () => { pendingScrolls.delete(scroll); };
}

export function usePageScrollLock() {
  useLayoutEffect(() => {
    if (scrollLocks++ === 0) {
      const root = document.documentElement;
      const rootOverflow = root.style.overflow;
      const rootGutter = root.style.getPropertyValue("scrollbar-gutter");
      const { scrollX, scrollY } = window;
      if (window.innerWidth > root.clientWidth &&
        !getComputedStyle(root).getPropertyValue("scrollbar-gutter").includes("stable")) {
        root.style.setProperty("scrollbar-gutter", "stable");
      }
      // A body overflow lock would capture sticky headers in a non-scrolling ancestor.
      root.style.overflow = "hidden";
      restoreScroll = () => {
        root.style.overflow = rootOverflow;
        root.style.setProperty("scrollbar-gutter", rootGutter);
        window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      };
    }
    return () => {
      // Comparisons can cover a viewer; only the last photo dialog unlocks the page.
      if (--scrollLocks === 0) {
        restoreScroll?.();
        restoreScroll = undefined;
        const scrolls = [...pendingScrolls];
        pendingScrolls.clear();
        for (const scroll of scrolls) scroll();
      }
    };
  }, []);
}

export function zoomPhotoWithWheel(scale: number, event: WheelEvent, viewportHeight: number) {
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1);
  return Math.max(1, Math.min(5, scale * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002))));
}

type PhotoPan = { x: number; y: number };
type PhotoView = { scale: number; pan: PhotoPan };
type PhotoGestureEvent = Event & { scale: number; clientX: number; clientY: number };

export function clampPhotoPan(pan: PhotoPan, scale: number, width: number, height: number): PhotoPan {
  if (scale <= 1.01) return { x: 0, y: 0 };
  const maxX = width * (scale - 1) / 2;
  const maxY = height * (scale - 1) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

export function usePhotoViewGestures({
  stageRef, scale, pan, enabled, navigationOnly = false, onChange, onNavigate, getViewport,
}: {
  stageRef: RefObject<HTMLElement | null>;
  scale: number;
  pan: PhotoPan;
  enabled: boolean;
  navigationOnly?: boolean;
  onChange: (view: PhotoView) => void;
  onNavigate?: (direction: -1 | 1) => void;
  getViewport?: (target: Element) => HTMLElement | null;
}) {
  const viewRef = useRef<PhotoView>({ scale, pan });
  const wheelRef = useRef<{
    time: number; pinch: boolean; trackpad: boolean;
    action: "pan" | "navigate"; x: number; y: number; navigationTime: number;
  } | null>(null);
  const safariRef = useRef<{ scale: number; viewport: HTMLElement } | null>(null);
  const safariUntilRef = useRef(0);
  const [active, setActive] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => { viewRef.current = { scale, pan }; }, [scale, pan]);
  useLayoutEffect(() => {
    if (enabled && !navigationOnly) return;
    if (!enabled) wheelRef.current = null;
    safariRef.current = null;
    safariUntilRef.current = 0;
    clearTimeout(idleTimer.current);
    setActive(false);
  }, [enabled, navigationOnly]);

  function markActive() {
    clearTimeout(idleTimer.current);
    setActive(true);
    idleTimer.current = setTimeout(() => setActive(false), 160);
  }

  function viewportFor(event: Event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!enabled || !target || target.closest("button, input, textarea, select, [contenteditable], [role='slider'], .player-controls")) return null;
    return getViewport ? getViewport(target) : stageRef.current;
  }

  function changeView(view: PhotoView) {
    // Wheel bursts can arrive before React commits the previous frame.
    viewRef.current = view;
    onChange(view);
    markActive();
  }

  function zoomAt(nextScale: number, viewport: HTMLElement, clientX: number, clientY: number) {
    const previous = viewRef.current;
    const rect = viewport.getBoundingClientRect();
    const x = Number.isFinite(clientX) && clientX >= rect.left && clientX <= rect.right
      ? clientX - rect.left - rect.width / 2 : 0;
    const y = Number.isFinite(clientY) && clientY >= rect.top && clientY <= rect.bottom
      ? clientY - rect.top - rect.height / 2 : 0;
    const ratio = nextScale / previous.scale;
    changeView({
      scale: nextScale,
      pan: clampPhotoPan({
        x: x - (x - previous.pan.x) * ratio,
        y: y - (y - previous.pan.y) * ratio,
      }, nextScale, rect.width, rect.height),
    });
  }

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    const viewport = viewportFor(event);
    if (!viewport || event.altKey || event.metaKey) return;
    if (navigationOnly && (event.ctrlKey || event.deltaMode !== 0 || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.3)) return;
    event.preventDefault();
    const now = performance.now();
    // Safari may emit wheel events as well as its native pinch sequence.
    if (safariRef.current || (event.ctrlKey && now < safariUntilRef.current)) return;
    if (!event.deltaX && !event.deltaY) return;
    let wheel = wheelRef.current;
    if (!wheel || now - wheel.time > 220 || wheel.pinch !== event.ctrlKey) {
      // WheelEvent has no device identity. Fine pixel deltas and horizontal
      // scrolling identify a trackpad burst; coarse/line wheels retain zoom.
      wheel = {
        time: now, pinch: event.ctrlKey,
        trackpad: event.deltaMode === 0 && (event.deltaX !== 0 || Math.abs(event.deltaY) < 50 || !Number.isInteger(event.deltaY)),
        action: viewRef.current.scale > 1.01 ? "pan" : "navigate",
        x: 0, y: 0, navigationTime: -Infinity,
      };
      wheelRef.current = wheel;
    }
    wheel.time = now;
    if (!navigationOnly && (event.ctrlKey || !wheel.trackpad)) {
      zoomAt(zoomPhotoWithWheel(viewRef.current.scale, event, viewport.clientHeight), viewport, event.clientX, event.clientY);
      return;
    }
    if (navigationOnly) wheel.action = "navigate";
    else if (viewRef.current.scale > 1.01) wheel.action = "pan";
    if (wheel.action === "pan") {
      const view = viewRef.current;
      changeView({ scale: view.scale, pan: clampPhotoPan({
        x: view.pan.x - event.deltaX,
        y: view.pan.y - event.deltaY,
      }, view.scale, viewport.clientWidth, viewport.clientHeight) });
      return;
    }
    // Discard motion during the image transition instead of queuing jumps.
    if (now - wheel.navigationTime < 220) return;
    if (wheel.x * event.deltaX < 0) {
      wheel.x = 0;
      wheel.y = 0;
    }
    wheel.x += event.deltaX;
    wheel.y += Math.abs(event.deltaY);
    if (Math.abs(wheel.x) >= 80 && Math.abs(wheel.x) > wheel.y * 1.3) {
      const direction = wheel.x > 0 ? 1 : -1;
      wheel.navigationTime = now;
      wheel.x = 0;
      wheel.y = 0;
      onNavigate?.(direction);
    }
  });

  const handleGesture = useEffectEvent((event: Event) => {
    if (navigationOnly) return;
    const gesture = event as PhotoGestureEvent;
    const viewport = safariRef.current?.viewport || viewportFor(event);
    if (!enabled || !viewport) return;
    event.preventDefault();
    safariUntilRef.current = performance.now() + 220;
    wheelRef.current = null;
    if (event.type === "gesturestart") {
      safariRef.current = { scale: viewRef.current.scale, viewport };
    } else if (event.type === "gestureend") {
      safariRef.current = null;
    } else if (safariRef.current && Number.isFinite(gesture.scale) && gesture.scale > 0) {
      zoomAt(Math.max(1, Math.min(5, safariRef.current.scale * gesture.scale)), viewport, gesture.clientX, gesture.clientY);
    }
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Non-passive listeners suppress page zoom, scrolling and history swipes.
    stage.addEventListener("wheel", handleWheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      stage.addEventListener(type, handleGesture, { passive: false });
    }
    return () => {
      stage.removeEventListener("wheel", handleWheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
        stage.removeEventListener(type, handleGesture);
      }
      clearTimeout(idleTimer.current);
    };
  }, [stageRef]);
  return active;
}
