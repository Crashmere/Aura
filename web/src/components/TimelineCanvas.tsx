import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Check,
  CircleCheck,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Video,
} from "lucide-react";
import {
  buildMediaUrl,
  formatDurationClock,
  formatHumanDate,
  orientedDimensions,
} from "../core/client";
import type { CatalogAsset } from "../core/types";
import {
  abortSpeculativePreloads,
  schedulePreviewWarmup,
} from "../core/workspace";
import { AspectRatioGlyph, LiveRingsIcon } from "./Icons";

// ============================================================================
// 1. Grid Density & Aspect Ratio Controller with FLIP Animation
// ============================================================================

export const DESKTOP_COLUMN_STEPS = [12, 10, 8, 7, 6, 5, 4] as const;
export const MOBILE_COLUMN_STEPS = [7, 6, 5, 4, 3, 2, 1] as const;
export const DEFAULT_ZOOM_STEP = 3;

const LEGACY_ZOOM_PREF_KEY = "aura-grid-zoom-v2";
const ZOOM_PREF_KEY = "aura-grid-zoom-v3";
const DESKTOP_COLUMN_OFFSETS = [5, 3, 1, 0, -1, -2, -3] as const;
const MOBILE_COLUMN_OFFSETS = [3, 2, 1, 0, -1, -2, -3] as const;
const ASPECT_PREF_KEY = "aura-grid-layout-v1";
const MAX_FLIP_TILES = 300;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export type GridAspectMode = "square" | "original";

interface GridZoomPreference {
  baseline: number;
  zoom: number;
}

interface FlipCaptureSnapshot {
  container: HTMLDivElement;
  rects: Map<string, DOMRect>;
}

function clampZoomStep(val: number): number {
  return Number.isFinite(val)
    ? Math.max(0, Math.min(6, Math.round(val)))
    : DEFAULT_ZOOM_STEP;
}

function maxZoomStep(baseline: number, mobile: boolean): number {
  const columns = mobile ? MOBILE_COLUMN_STEPS[baseline] : DESKTOP_COLUMN_STEPS[baseline];
  return Math.min(6, DEFAULT_ZOOM_STEP + columns - 1);
}

function loadSavedZoomPreference(): GridZoomPreference {
  let baseline = DEFAULT_ZOOM_STEP;
  try {
    const raw = localStorage.getItem(ZOOM_PREF_KEY);
    if (raw !== null) {
      const saved = JSON.parse(raw) as GridZoomPreference;
      if (
        saved &&
        Number.isInteger(saved.baseline) && saved.baseline >= 0 && saved.baseline <= 6 &&
        Number.isInteger(saved.zoom) && saved.zoom >= 0 && saved.zoom <= 6
      ) {
        return { baseline: saved.baseline, zoom: saved.zoom };
      }
    }
  } catch {
    /* Storage optional */
  }
  try {
    // Preserve the current size while moving it to the center of the new range.
    const legacy = localStorage.getItem(LEGACY_ZOOM_PREF_KEY);
    if (legacy !== null && /^[0-6]$/.test(legacy)) baseline = Number(legacy);
  } catch {
    /* Storage optional */
  }
  return { baseline, zoom: DEFAULT_ZOOM_STEP };
}

function loadSavedAspectMode(): GridAspectMode {
  try {
    if (localStorage.getItem(ASPECT_PREF_KEY) === "original") return "original";
  } catch {
    /* Storage optional */
  }
  return "square";
}

function isNearViewport(rect: DOMRect, buffer: number): boolean {
  return rect.bottom >= -buffer && rect.top <= window.innerHeight + buffer;
}

function captureGridSnapshot(container: HTMLDivElement): FlipCaptureSnapshot {
  const rects = new Map<string, DOMRect>();
  const margin = Math.min(480, window.innerHeight / 2);

  // Density changes move photos between virtual rows and can replace their DOM nodes.
  for (const tile of container.querySelectorAll<HTMLElement>(".photo[data-asset-id]")) {
    const rect = tile.getBoundingClientRect();
    if (!rect.width || !rect.height || !isNearViewport(rect, margin)) continue;
    rects.set(tile.dataset.assetId!, rect);
    if (rects.size >= MAX_FLIP_TILES) break;
  }

  return { container, rects };
}

export function useGridDisplayPreferences() {
  const [density, setDensity] = useState(loadSavedZoomPreference);
  const [mobile, setMobile] = useState(() => window.innerWidth <= 720);
  const maxZoom = maxZoomStep(density.baseline, mobile);
  const zoom = Math.min(density.zoom, maxZoom);
  const desktopColumnSteps = DESKTOP_COLUMN_OFFSETS.map((offset) =>
    Math.max(1, DESKTOP_COLUMN_STEPS[density.baseline] + offset),
  );
  const mobileColumnSteps = MOBILE_COLUMN_OFFSETS.map((offset) =>
    Math.max(1, MOBILE_COLUMN_STEPS[density.baseline] + offset),
  );
  const [layout, setLayoutRaw] = useState<GridAspectMode>(loadSavedAspectMode);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestedZoom = useRef(zoom);
  const committedZoom = useRef(zoom);
  const requestedLayout = useRef(layout);
  const committedLayout = useRef(layout);
  const snapshotRef = useRef<FlipCaptureSnapshot | null>(null);
  const runningAnimations = useRef(new Set<Animation>());
  const animationFrame = useRef(0);

  const stopRunningAnimations = useCallback(() => {
    cancelAnimationFrame(animationFrame.current);
    animationFrame.current = 0;
    for (const anim of runningAnimations.current) {
      anim.onfinish = null;
      anim.oncancel = null;
      anim.cancel();
    }
    runningAnimations.current.clear();
  }, []);

  const captureNextDisplay = useCallback(
    (nextZoom: number, nextLayout: GridAspectMode) => {
      stopRunningAnimations();
      snapshotRef.current =
        containerRef.current &&
        (nextZoom !== committedZoom.current || nextLayout !== committedLayout.current) &&
        !window.matchMedia(REDUCED_MOTION_QUERY).matches &&
        typeof Element.prototype.animate === "function"
          ? captureGridSnapshot(containerRef.current)
          : null;
    },
    [stopRunningAnimations],
  );

  const bindTimelineElement = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== containerRef.current) {
        stopRunningAnimations();
        snapshotRef.current = null;
      }
      containerRef.current = node;
    },
    [stopRunningAnimations],
  );

  const changeZoom = useCallback(
    (nextValue: number) => {
      const clamped = Math.min(clampZoomStep(nextValue), maxZoom);
      if (clamped === requestedZoom.current && clamped === density.zoom) return;
      requestedZoom.current = clamped;
      captureNextDisplay(clamped, requestedLayout.current);
      setDensity((current) => ({ ...current, zoom: clamped }));
    },
    [captureNextDisplay, maxZoom, density.zoom],
  );

  const changeLayout = useCallback(
    (nextLayout: GridAspectMode) => {
      if (nextLayout === requestedLayout.current) return;
      requestedLayout.current = nextLayout;
      captureNextDisplay(requestedZoom.current, nextLayout);
      setLayoutRaw(nextLayout);
    },
    [captureNextDisplay],
  );

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_PREF_KEY, JSON.stringify(density));
    } catch {
      /* Optional */
    }
  }, [density]);

  useEffect(() => {
    try {
      localStorage.setItem(ASPECT_PREF_KEY, layout);
    } catch {
      /* Optional */
    }
  }, [layout]);

  useLayoutEffect(() => {
    requestedZoom.current = zoom;
    committedZoom.current = zoom;
    committedLayout.current = layout;
    const prev = snapshotRef.current;
    snapshotRef.current = null;
    if (!prev || containerRef.current !== prev.container) return;

    if (
      window.matchMedia(REDUCED_MOTION_QUERY).matches ||
      typeof Element.prototype.animate !== "function"
    ) {
      return;
    }

    // Child layout effects settle scroll anchoring and its mounted row window first.
    animationFrame.current = requestAnimationFrame(() => {
      animationFrame.current = 0;
      if (
        containerRef.current !== prev.container ||
        !prev.container.isConnected ||
        window.matchMedia(REDUCED_MOTION_QUERY).matches
      ) {
        return;
      }

      const margin = Math.min(480, window.innerHeight / 2);
      const transitions: { tile: HTMLElement; from: DOMRect; to: DOMRect }[] = [];
      for (const tile of prev.container.querySelectorAll<HTMLElement>(".photo[data-asset-id]")) {
        const fromRect = prev.rects.get(tile.dataset.assetId!);
        if (!fromRect) continue;
        const toRect = tile.getBoundingClientRect();
        if (toRect.width && toRect.height && isNearViewport(toRect, margin)) {
          transitions.push({ tile, from: fromRect, to: toRect });
        }
      }

      for (const { tile, from, to } of transitions) {
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        const sx = from.width / to.width;
        const sy = from.height / to.height;
        if (Math.abs(dx) + Math.abs(dy) < 0.5 && Math.abs(sx - 1) + Math.abs(sy - 1) < 0.005) {
          continue;
        }
        const anim = tile.animate(
          [
            {
              transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
              transformOrigin: "0 0",
            },
            { transform: "none", transformOrigin: "0 0" },
          ],
          { duration: 250, easing: "cubic-bezier(.22, .8, .25, 1)", fill: "none" },
        );
        runningAnimations.current.add(anim);
        const cleanup = () => {
          anim.onfinish = null;
          anim.oncancel = null;
          anim.cancel();
          runningAnimations.current.delete(anim);
        };
        anim.onfinish = cleanup;
        anim.oncancel = cleanup;
      }
    });

    return stopRunningAnimations;
  }, [zoom, layout, stopRunningAnimations]);

  useLayoutEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const abort = () => {
      snapshotRef.current = null;
      stopRunningAnimations();
    };
    const resize = () => {
      abort();
      setMobile(window.innerWidth <= 720);
    };
    mq.addEventListener("change", abort);
    window.addEventListener("resize", resize);
    return () => {
      mq.removeEventListener("change", abort);
      window.removeEventListener("resize", resize);
      abort();
    };
  }, [stopRunningAnimations]);

  const columns = desktopColumnSteps[zoom];
  const mobileColumns = mobileColumnSteps[zoom];
  const cssVars = {
    "--columns": columns,
    "--mobile-columns": mobileColumns,
  } as CSSProperties;

  return {
    zoom,
    maxZoom,
    desktopColumnSteps,
    mobileColumnSteps,
    setZoom: changeZoom,
    layout,
    setLayout: changeLayout,
    columns,
    mobileColumns,
    timelineProps: {
      className: "timeline aura-gallery",
      ref: bindTimelineElement,
      style: cssVars,
      "data-gallery-zoom": zoom,
      "data-gallery-layout": layout,
      "data-gallery-dense": mobile ? mobileColumns >= 6 : columns >= 10,
    },
    skeletonProps: {
      className: "skeleton-grid gallery-skeleton",
      style: cssVars,
    },
  };
}

export function GridDensityControls({
  zoom,
  maxZoom,
  desktopColumnSteps,
  mobileColumnSteps,
  onZoomChange,
  layout,
  onLayoutChange,
  disabled = false,
}: {
  zoom: number;
  maxZoom: number;
  desktopColumnSteps: number[];
  mobileColumnSteps: number[];
  onZoomChange: (next: number) => void;
  layout: GridAspectMode;
  onLayoutChange: (next: GridAspectMode) => void;
  disabled?: boolean;
}) {
  const step = clampZoomStep(zoom);
  const toggleLabel = layout === "square" ? "原始比例网格" : "正方形照片网格";

  return (
    <div className="gallery-zoom" role="group" aria-label="照片网格显示">
      <button
        type="button"
        className="gallery-layout-toggle"
        aria-label={toggleLabel}
        title={toggleLabel}
        aria-pressed={layout === "original"}
        disabled={disabled}
        onClick={() => onLayoutChange(layout === "square" ? "original" : "square")}
      >
        <AspectRatioGlyph />
      </button>
      <button
        type="button"
        aria-label="缩小缩略图"
        title="缩小缩略图"
        disabled={disabled || step === 0}
        onClick={() => onZoomChange(step - 1)}
      >
        <ImageIcon size={14} aria-hidden="true" />
      </button>
      <input
        type="range"
        aria-label="缩略图大小"
        aria-valuetext={`${step === DEFAULT_ZOOM_STEP ? "默认，" : ""}桌面 ${desktopColumnSteps[step]} 列，手机 ${mobileColumnSteps[step]} 列`}
        title="缩略图大小（左小右大，双击恢复默认）"
        min={0}
        max={maxZoom}
        step={1}
        value={step}
        disabled={disabled}
        onChange={(e) => onZoomChange(e.currentTarget.valueAsNumber)}
        onDoubleClick={() => onZoomChange(DEFAULT_ZOOM_STEP)}
      />
      <button
        type="button"
        aria-label="放大缩略图"
        title="放大缩略图"
        disabled={disabled || step === maxZoom}
        onClick={() => onZoomChange(step + 1)}
      >
        <ImageIcon size={19} aria-hidden="true" />
      </button>
    </div>
  );
}

// ============================================================================
// 2. Photo Tile Card
// ============================================================================

export function PhotoTile({
  asset,
  onClick,
  selected = false,
  selecting = false,
  onToggleSelect,
  disabled = false,
  originalAspect = false,
}: {
  asset: CatalogAsset;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  selected?: boolean;
  selecting?: boolean;
  onToggleSelect?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  originalAspect?: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [measuredRatio, setMeasuredRatio] = useState<{ src: string; ratio: number } | null>(
    null,
  );

  const thumbUrl =
    buildMediaUrl(asset.primary, "thumb", asset.rotation, asset.cover?.revision) +
    (retryCount ? `&retry=${retryCount}` : "");
  const dims = orientedDimensions(asset);
  const aspect =
    measuredRatio?.src === thumbUrl
      ? measuredRatio.ratio
      : dims.width > 0 && dims.height > 0
        ? dims.width / dims.height
        : 1;

  const customVars = {
    "--photo-aspect": aspect,
    "--photo-natural-width": `${Math.min(1, aspect) * 100}%`,
    "--photo-natural-height": `${Math.min(1, 1 / aspect) * 100}%`,
    "--photo-crop-scale": Math.max(aspect, 1 / aspect),
  } as CSSProperties;

  useEffect(() => {
    setBroken(false);
  }, [thumbUrl, asset.status]);

  useLayoutEffect(() => {
    setLoaded(!!imgRef.current?.complete && !!imgRef.current?.naturalWidth);
  }, [thumbUrl]);

  useEffect(() => {
    if (!broken) return;
    const handleOnline = () => {
      setRetryCount((n) => n + 1);
      setBroken(false);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [broken]);

  return (
    <div
      data-asset-id={asset.id}
      style={customVars}
      className={`photo ${originalAspect ? "original-aspect" : ""} ${selected ? "selected" : ""} ${selecting ? "selecting" : ""} ${loaded || broken ? "is-ready" : "is-loading"}`}
    >
      <button
        type="button"
        className="photo-open"
        disabled={disabled}
        onPointerEnter={(e) => {
          if (
            e.pointerType === "mouse" && !selecting && !disabled &&
            !e.ctrlKey && !e.metaKey && !e.shiftKey
          ) {
            schedulePreviewWarmup([asset], 180);
          }
        }}
        onPointerLeave={abortSpeculativePreloads}
        onPointerDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            abortSpeculativePreloads();
          } else if (!selecting && !disabled) {
            schedulePreviewWarmup([asset], 0);
          }
        }}
        onClick={onClick}
        onContextMenu={(e) => {
          // macOS reports Ctrl-left-click as a context menu instead of a click.
          if (e.ctrlKey && e.button === 0 && !disabled) {
            e.preventDefault();
            onClick(e);
          }
        }}
        aria-label={
          selecting ? `${selected ? "取消选择" : "选择"} ${asset.name}` : `查看 ${asset.name}`
        }
      >
        <div className="photo-frame">
          {!broken ? (
            <img
              ref={imgRef}
              key={thumbUrl}
              src={thumbUrl}
              onLoad={(e) => {
                const { naturalWidth, naturalHeight } = e.currentTarget;
                if (naturalWidth && naturalHeight) {
                  setMeasuredRatio({ src: thumbUrl, ratio: naturalWidth / naturalHeight });
                }
                setLoaded(true);
              }}
              className={loaded ? "is-loaded" : ""}
              alt={asset.name}
              loading="lazy"
              decoding="async"
              onError={() => setBroken(true)}
            />
          ) : (
            <div className="photo-missing">
              <ImageIcon size={20} />
              <span>
                {asset.status === "error"
                  ? "预览处理失败"
                  : ["queued", "processing"].includes(asset.status)
                    ? "正在生成预览"
                    : "预览加载失败"}
              </span>
            </div>
          )}

          <div className="photo-shade" />

          {asset.kind === "live" && (
            <span className="photo-kind">
              <LiveRingsIcon size={13} />
              <span>实况</span>
            </span>
          )}
          {asset.kind === "video" && !asset.duration && (
            <span className="photo-kind">
              <Video size={13} />
            </span>
          )}
          {asset.kind === "video" && !!asset.duration && (
            <span className="photo-duration">{formatDurationClock(asset.duration)}</span>
          )}
          {asset.imageVersions > 1 && !asset.deletionPending && (
            <span
              className="photo-versions"
              title={`${asset.grouping === "manual" ? "手动归并" : "自动组合"} · ${asset.imageVersions} 个照片版本`}
            >
              <Layers3 size={12} />
              <span>
                {asset.grouping === "manual" ? "归并" : "版本"} {asset.imageVersions}
              </span>
            </span>
          )}
          {asset.deletionPending && (
            <span className="photo-deletion-pending">
              <LoaderCircle className="spin" size={12} />
              <span>清理中</span>
            </span>
          )}
        </div>
      </button>

      {broken && (
        <button
          type="button"
          className="photo-retry"
          aria-label="重新加载预览"
          title="重新加载预览"
          onClick={() => {
            setRetryCount((n) => n + 1);
            setBroken(false);
          }}
        >
          <RefreshCw size={13} />
          <span>重试</span>
        </button>
      )}

      {onToggleSelect && (
        <button
          type="button"
          className={`select-photo ${selected ? "checked" : ""}`}
          aria-label={`${selected ? "取消选择" : "选择照片"} ${asset.name}`}
          aria-pressed={selected}
          disabled={disabled || !!asset.deletionPending}
          onClick={onToggleSelect}
          onContextMenu={(e) => {
            if (e.ctrlKey && e.button === 0 && !disabled && !asset.deletionPending) {
              e.preventDefault();
              onToggleSelect(e);
            }
          }}
        >
          <Check size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ============================================================================
// 3. Virtualized Day-Grouped Timeline Canvas
// ============================================================================

export interface DayAssetGroup {
  date: string;
  items: CatalogAsset[];
}

interface VirtualRowSlice {
  group: DayAssetGroup;
  assets?: CatalogAsset[];
  top: number;
  height: number;
}

export function VirtualizedTimelineCanvas({
  groups,
  columns,
  mobileColumns,
  selectedIds,
  selecting,
  busy,
  onToggleGroup,
  onToggleAsset,
  onOpenAsset,
}: {
  groups: DayAssetGroup[];
  columns: number;
  mobileColumns: number;
  selectedIds: Set<string>;
  selecting: boolean;
  busy: boolean;
  onToggleGroup: (items: CatalogAsset[]) => void;
  onToggleAsset: (id: string, shiftRange: boolean) => void;
  onOpenAsset: (asset: CatalogAsset) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({
    width: 960,
    mobile: window.innerWidth <= 720,
  });
  const [visibleWindow, setVisibleWindow] = useState({
    top: 0,
    bottom: window.innerHeight + 900,
  });
  const scrollAnchor = useRef<{ id: string; offsetTop: number } | undefined>(undefined);
  const layoutSignature = useRef("");

  const activeCols = viewport.mobile ? mobileColumns : columns;
  const gridGap = viewport.mobile ? 2 : 3;

  const { rows, totalHeight } = useMemo(() => {
    const computedRows: VirtualRowSlice[] = [];
    let currentTop = 0;
    const tileEdge = Math.max(1, (viewport.width - (activeCols - 1) * gridGap) / activeCols);

    for (const group of groups) {
      computedRows.push({ group, top: currentTop, height: 44 });
      currentTop += 44;
      for (let idx = 0; idx < group.items.length; idx += activeCols) {
        computedRows.push({
          group,
          assets: group.items.slice(idx, idx + activeCols),
          top: currentTop,
          height: tileEdge + gridGap,
        });
        currentTop += tileEdge + gridGap;
      }
      currentTop += 24 - gridGap;
    }

    return { rows: computedRows, totalHeight: currentTop };
  }, [groups, activeCols, gridGap, viewport.width]);

  useLayoutEffect(() => {
    const sig = `${activeCols}:${viewport.width}`;
    if (
      layoutSignature.current &&
      layoutSignature.current !== sig &&
      scrollAnchor.current &&
      rootRef.current
    ) {
      const saved = scrollAnchor.current;
      const targetRow = rows.find((r) => r.assets?.some((a) => a.id === saved.id));
      if (targetRow) {
        window.scrollBy({
          top:
            rootRef.current.getBoundingClientRect().top +
            targetRow.top -
            saved.offsetTop,
          behavior: "instant",
        });
      }
    }
    layoutSignature.current = sig;
  }, [activeCols, viewport.width, rows]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let rafId = 0;

    const measure = () => {
      rafId = 0;
      const rect = el.getBoundingClientRect();
      const isMobile = window.innerWidth <= 720;
      setViewport((prev) =>
        prev.width === rect.width && prev.mobile === isMobile
          ? prev
          : { width: rect.width, mobile: isMobile },
      );
      const topBound = Math.max(0, -rect.top - 700);
      const bottomBound = Math.max(0, window.innerHeight - rect.top + 700);

      // Read unanimated row geometry so an in-flight FLIP cannot change the saved anchor.
      for (const grid of el.querySelectorAll<HTMLElement>(".photo-grid")) {
        const top = grid.getBoundingClientRect().top;
        const tile = grid.firstElementChild as HTMLElement | null;
        if (top < 180 || !tile?.dataset.assetId) continue;
        scrollAnchor.current = { id: tile.dataset.assetId, offsetTop: top };
        break;
      }

      setVisibleWindow((prev) =>
        Math.abs(prev.top - topBound) < 80 && Math.abs(prev.bottom - bottomBound) < 80
          ? prev
          : { top: topBound, bottom: bottomBound },
      );
    };

    const schedule = () => {
      if (!rafId) rafId = requestAnimationFrame(measure);
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    measure();

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [totalHeight]);

  useLayoutEffect(() => {
    const onScrollToAsset = (e: Event) => {
      const targetId = (e as CustomEvent<string>).detail;
      const row = rows.find((r) => r.assets?.some((a) => a.id === targetId));
      const el = rootRef.current;
      if (row && el) {
        window.scrollTo({
          top:
            window.scrollY +
            el.getBoundingClientRect().top +
            row.top +
            row.height / 2 -
            window.innerHeight / 2,
          behavior: "instant",
        });
      }
    };
    window.addEventListener("aura-gallery-scroll", onScrollToAsset);
    return () => window.removeEventListener("aura-gallery-scroll", onScrollToAsset);
  }, [rows]);

  function findRowIndex(yPos: number): number {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid].top + rows[mid].height < yPos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const startIdx = findRowIndex(visibleWindow.top);
  const endIdx = Math.min(rows.length, findRowIndex(visibleWindow.bottom) + 1);

  const renderGroupHeader = (group: DayAssetGroup): ReactNode => {
    const selectableItems = group.items.filter((a) => !a.deletionPending);
    const allGroupSelected =
      selectableItems.length > 0 && selectableItems.every((a) => selectedIds.has(a.id));

    return (
      <div className="day-heading">
        <h2>
          {formatHumanDate(`${group.date}T12:00:00`)}
          <span>{group.date.slice(0, 4)}</span>
        </h2>
        <button
          type="button"
          className="day-select"
          disabled={busy || selectableItems.length === 0}
          aria-pressed={allGroupSelected}
          onClick={() => onToggleGroup(group.items)}
          title="选择或取消选择当天照片"
        >
          <span>{group.items.length} 项</span>
          <span className="day-select-label">
            {allGroupSelected ? "取消选择" : "选择当天"}
          </span>
          <CircleCheck size={15} />
        </button>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className="virtual-gallery"
      style={{ height: totalHeight, position: "relative" }}
    >
      {rows.slice(startIdx, endIdx).map((row) => (
        <section
          className="day-group"
          key={`${row.group.date}:${row.assets?.[0]?.id || "heading"}`}
          style={{
            position: "absolute",
            top: row.top,
            width: "100%",
            height: row.height,
          }}
        >
          {row.assets ? (
            <div
              className="photo-grid"
              style={{
                gridTemplateColumns: `repeat(${activeCols}, minmax(0, 1fr))`,
                gap: gridGap,
              }}
            >
              {row.assets.map((asset) => (
                <PhotoTile
                  key={asset.id}
                  asset={asset}
                  selected={selectedIds.has(asset.id)}
                  selecting={selecting}
                  disabled={busy}
                  onToggleSelect={(e) => onToggleAsset(asset.id, e.shiftKey)}
                  onClick={(e) => {
                    if (selecting || e.shiftKey || e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      if (!asset.deletionPending) onToggleAsset(asset.id, e.shiftKey);
                    } else {
                      onOpenAsset(asset);
                    }
                  }}
                />
              ))}
            </div>
          ) : (
            renderGroupHeader(row.group)
          )}
        </section>
      ))}
    </div>
  );
}
