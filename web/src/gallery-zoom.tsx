import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Image as ImageIcon } from "lucide-react";
import "./gallery-zoom.css";

export const GALLERY_ZOOM_COLUMNS = [12, 10, 8, 7, 6, 5, 4] as const;
export const GALLERY_ZOOM_MOBILE_COLUMNS = [7, 6, 5, 4, 3, 2, 1] as const;
export const DEFAULT_GALLERY_ZOOM = 3;
const STORAGE_KEY = "aura-grid-zoom-v2";
const MAX_ANIMATED_CARDS = 300;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

type GridStyle = CSSProperties & { "--columns": number; "--mobile-columns": number };
type Snapshot = {
  root: HTMLDivElement;
  cards: Map<HTMLElement, DOMRect>;
  groups: Set<HTMLElement>;
  anchor: HTMLElement | null;
};

function normalizeZoom(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(6, Math.round(value))) : DEFAULT_GALLERY_ZOOM;
}

function readZoom() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    // In particular, an absent value must not become Number(null) === 0.
    if (saved !== null && /^[0-6]$/.test(saved)) return Number(saved);
  } catch { /* Storage is optional. */ }
  return DEFAULT_GALLERY_ZOOM;
}

function nearby(rect: DOMRect, margin: number) {
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
}

function capture(root: HTMLDivElement): Snapshot {
  const cards = new Map<HTMLElement, DOMRect>();
  const groups = new Set<HTMLElement>();
  const margin = Math.min(480, window.innerHeight / 2);
  let anchor: HTMLElement | null = null;
  let anchorDistance = Infinity;

  for (const group of root.children) {
    if (!(group instanceof HTMLElement) || !group.matches(".day-group")) continue;
    // Read only the outer box of skipped groups: measuring their descendants
    // would force layout throughout a content-visibility:auto timeline.
    if (!nearby(group.getBoundingClientRect(), margin)) continue;
    const grid = group.querySelector<HTMLElement>(":scope > .photo-grid");
    if (!grid) continue;
    groups.add(group);
    const gridRect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(/\s+/).length;
    const rowGap = parseFloat(style.rowGap) || 0;
    const columnGap = parseFloat(style.columnGap) || 0;
    const rowHeight = (gridRect.width - (columns - 1) * columnGap) / columns + rowGap;
    if (rowHeight <= 0) continue;
    // Square cards let us jump straight to nearby rows even in a very large day.
    const start = Math.max(0, Math.floor((-margin - gridRect.top) / rowHeight)) * columns;
    const end = Math.min(grid.children.length, Math.ceil((window.innerHeight + margin - gridRect.top) / rowHeight) * columns);
    for (let index = start; index < end && cards.size < MAX_ANIMATED_CARDS; index++) {
      const card = grid.children[index];
      if (!(card instanceof HTMLElement) || !card.matches(".photo")) continue;
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      cards.set(card, rect);
      if (!nearby(rect, 0)) continue;
      const distance = Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2)
        + Math.abs(rect.left + rect.width / 2 - (gridRect.left + gridRect.width / 2)) / 10;
      if (distance < anchorDistance) {
        anchor = card;
        anchorDistance = distance;
      }
    }
    if (cards.size >= MAX_ANIMATED_CARDS) break;
  }
  return { root, cards, groups, anchor };
}

/**
 * Spread timelineProps on the existing .timeline and skeletonProps on its
 * loading placeholder. Keep stable Photo keys and .day-group > .photo-grid >
 * .photo containers. All size changes must go through setZoom to capture FLIP.
 */
export function useGalleryZoom() {
  const [zoom, setZoomState] = useState(readZoom);
  const root = useRef<HTMLDivElement | null>(null);
  const requested = useRef(zoom);
  const committed = useRef(zoom);
  const pending = useRef<Snapshot | null>(null);
  const animations = useRef(new Set<Animation>());
  const activeGroups = useRef(new Set<HTMLElement>());

  const releaseGroups = useCallback(() => {
    for (const group of activeGroups.current) group.removeAttribute("data-gallery-zoom-active");
    activeGroups.current.clear();
  }, []);

  const cancelAnimations = useCallback(() => {
    for (const animation of animations.current) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
    animations.current.clear();
    releaseGroups();
  }, [releaseGroups]);

  const timelineRef = useCallback((node: HTMLDivElement | null) => {
    if (node !== root.current) {
      cancelAnimations();
      pending.current = null;
    }
    root.current = node;
  }, [cancelAnimations]);

  const setZoom = useCallback((value: number) => {
    const next = normalizeZoom(value);
    if (next === requested.current) return;
    requested.current = next;
    // Capture the current animated boxes before cancelling an interrupted move.
    // Capturing in effect cleanup would be too late: React has changed the DOM.
    pending.current = root.current && next !== committed.current ? capture(root.current) : null;
    cancelAnimations();
    setZoomState(next);
  }, [cancelAnimations]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(zoom)); } catch { /* Optional preference. */ }
  }, [zoom]);

  useLayoutEffect(() => {
    committed.current = zoom;
    const before = pending.current;
    pending.current = null;
    if (!before || root.current !== before.root) return;

    // Only nearby groups lose paint containment during FLIP. Distant groups
    // retain content-visibility and their cached intrinsic sizes.
    for (const group of before.groups) {
      if (!before.root.contains(group)) continue;
      group.setAttribute("data-gallery-zoom-active", "");
      activeGroups.current.add(group);
    }

    const anchor = before.anchor;
    if (anchor && before.root.contains(anchor)) {
      const first = before.cards.get(anchor)!;
      const last = anchor.getBoundingClientRect();
      const delta = last.top + last.height / 2 - first.top - first.height / 2;
      if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: "instant" });
    }

    if (window.matchMedia(REDUCED_MOTION).matches || typeof Element.prototype.animate !== "function") {
      releaseGroups();
      return;
    }

    const margin = Math.min(480, window.innerHeight / 2);
    const moves: { card: HTMLElement; first: DOMRect; last: DOMRect }[] = [];
    for (const [card, first] of before.cards) {
      if (!before.root.contains(card)) continue;
      const last = card.getBoundingClientRect();
      if (last.width && last.height && nearby(last, margin)) moves.push({ card, first, last });
    }
    // Batch all layout reads above before adding animation effects.
    for (const { card, first, last } of moves) {
      const x = first.left - last.left;
      const y = first.top - last.top;
      const scaleX = first.width / last.width;
      const scaleY = first.height / last.height;
      if (Math.abs(x) + Math.abs(y) < 0.5 && Math.abs(scaleX - 1) + Math.abs(scaleY - 1) < 0.005) continue;
      const animation = card.animate([
        { transform: `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`, transformOrigin: "0 0" },
        { transform: "none", transformOrigin: "0 0" },
      ], { duration: 260, easing: "cubic-bezier(.22, .8, .25, 1)", fill: "none" });
      animations.current.add(animation);
      const finish = () => {
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
        animations.current.delete(animation);
        if (!animations.current.size) releaseGroups();
      };
      animation.onfinish = finish;
      animation.oncancel = finish;
    }
    if (!animations.current.size) releaseGroups();
    return cancelAnimations;
  }, [zoom, cancelAnimations, releaseGroups]);

  useLayoutEffect(() => {
    const motion = window.matchMedia(REDUCED_MOTION);
    const stop = () => { pending.current = null; cancelAnimations(); };
    motion.addEventListener("change", stop);
    window.addEventListener("resize", stop);
    return () => {
      motion.removeEventListener("change", stop);
      window.removeEventListener("resize", stop);
      stop();
    };
  }, [cancelAnimations]);

  const columns = GALLERY_ZOOM_COLUMNS[zoom];
  const mobileColumns = GALLERY_ZOOM_MOBILE_COLUMNS[zoom];
  const gridStyle: GridStyle = { "--columns": columns, "--mobile-columns": mobileColumns };
  return {
    zoom, setZoom, columns, mobileColumns, gridStyle, timelineRef,
    timelineProps: { className: "timeline aura-gallery", ref: timelineRef, style: gridStyle, "data-gallery-zoom": zoom },
    skeletonProps: { className: "skeleton-grid gallery-skeleton", style: gridStyle },
    controlsProps: { zoom, onZoomChange: setZoom },
  };
}

export type GalleryZoomControlsProps = {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  disabled?: boolean;
};

export function GalleryZoomControls({ zoom, onZoomChange, disabled = false }: GalleryZoomControlsProps) {
  const value = normalizeZoom(zoom);
  return (
    <div className="gallery-zoom" role="group" aria-label="缩略图大小">
      <button type="button" aria-label="缩小缩略图" title="缩小缩略图" disabled={disabled || value === 0} onClick={() => onZoomChange(value - 1)}>
        <ImageIcon size={14} aria-hidden="true" />
      </button>
      <input
        type="range"
        aria-label="缩略图大小"
        aria-valuetext={`桌面 ${GALLERY_ZOOM_COLUMNS[value]} 列，手机 ${GALLERY_ZOOM_MOBILE_COLUMNS[value]} 列`}
        title="缩略图大小（左小右大）"
        min={0} max={6} step={1} value={value} disabled={disabled}
        onChange={event => onZoomChange(event.currentTarget.valueAsNumber)}
      />
      <button type="button" aria-label="放大缩略图" title="放大缩略图" disabled={disabled || value === 6} onClick={() => onZoomChange(value + 1)}>
        <ImageIcon size={20} aria-hidden="true" />
      </button>
    </div>
  );
}
