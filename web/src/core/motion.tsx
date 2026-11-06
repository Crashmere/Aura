import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const PresenceContext = createContext(true);
type MotionStyle = CSSProperties & Record<`--${string}`, string | number>;

export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => true,
  );
}

export function useIsPresent(): boolean {
  return useContext(PresenceContext);
}

export function MotionPresence({
  present,
  children,
  variant = "overlay",
  exitMs = 160,
}: {
  present: boolean;
  children: ReactNode;
  variant?: "overlay" | "menu" | "panel" | "toast" | "dock";
  exitMs?: number;
}) {
  const parentPresent = useIsPresent();
  const reducedMotion = useReducedMotion();
  const [retained, setRetained] = useState<ReactNode>(
    present ? children : null,
  );

  useLayoutEffect(() => {
    if (present) setRetained(children);
  }, [present, children]);

  useEffect(() => {
    if (present) return;
    if (reducedMotion) {
      setRetained(null);
      return;
    }
    const timer = window.setTimeout(() => setRetained(null), exitMs);
    return () => window.clearTimeout(timer);
  }, [present, reducedMotion, exitMs]);

  if (!present && (reducedMotion || retained === null)) return null;

  // Keep only the departing view alive; its controls and shortcuts stop immediately.
  return (
    <PresenceContext.Provider value={parentPresent && present}>
      <div
        className="motion-presence"
        data-presence={present ? "present" : "exiting"}
        data-motion={variant}
        style={{ "--motion-exit-duration": `${exitMs}ms` } as MotionStyle}
        inert={!present || !parentPresent}
        aria-hidden={!present || !parentPresent || undefined}
      >
        {present ? children : retained}
      </div>
    </PresenceContext.Provider>
  );
}

export function CollapsibleRegion({
  open,
  children,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & { open: boolean; children: ReactNode }) {
  const parentPresent = useIsPresent();
  return (
    <div
      {...props}
      className={`motion-collapse ${open ? "is-open" : ""} ${className}`.trim()}
    >
      <PresenceContext.Provider value={parentPresent && open}>
        <div
          className="motion-collapse-inner"
          inert={!open || !parentPresent}
          aria-hidden={!open || !parentPresent || undefined}
        >
          {children}
        </div>
      </PresenceContext.Provider>
    </div>
  );
}

export function useSlidingIndicator<T extends HTMLElement = HTMLDivElement>(
  activeKey: string | number,
  selector = ".is-active",
) {
  const ref = useRef<T>(null);
  const [style, setStyle] = useState<MotionStyle>({});

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    let frame = 0;

    const measure = () => {
      const selected = container.querySelector<HTMLElement>(selector);
      if (!selected) {
        setStyle((previous) =>
          previous["--motion-indicator-visible"] === 0
            ? previous
            : { ...previous, "--motion-indicator-visible": 0 },
        );
        return;
      }
      // Offsets ignore press/hover transforms and the mobile sidebar's slide.
      let x = selected.offsetLeft;
      let y = selected.offsetTop;
      let parent = selected.offsetParent;
      while (parent instanceof HTMLElement && parent !== container) {
        x += parent.offsetLeft + parent.clientLeft;
        y += parent.offsetTop + parent.clientTop;
        parent = parent.offsetParent;
      }
      const next: MotionStyle = {
        "--motion-indicator-x": `${x}px`,
        "--motion-indicator-y": `${y}px`,
        "--motion-indicator-width": `${selected.offsetWidth}px`,
        "--motion-indicator-height": `${selected.offsetHeight}px`,
        "--motion-indicator-visible": selected.offsetWidth ? 1 : 0,
      };
      setStyle((previous) => {
        if (
          Object.entries(next).every(
            ([key, value]) => previous[key as keyof MotionStyle] === value,
          )
        ) {
          return previous;
        }
        return {
          ...next,
          "--motion-indicator-duration": previous["--motion-indicator-width"]
            ? "220ms"
            : "0ms",
        };
      });
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    for (const button of container.querySelectorAll("button"))
      observer.observe(button);
    const mutations = new MutationObserver(() => {
      for (const button of container.querySelectorAll("button"))
        observer.observe(button);
      scheduleMeasure();
    });
    mutations.observe(container, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [activeKey, selector]);

  return { ref, style };
}
