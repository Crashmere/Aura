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

const ZOOM_PREF_KEY = "aura-grid-zoom-v2";
const ASPECT_PREF_KEY = "aura-grid-layout-v1";
const MAX_FLIP_TILES = 300;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export type GridAspectMode = "square" | "original";

interface FlipCaptureSnapshot {
  container: HTMLDivElement;
  rects: Map<HTMLElement, DOMRect>;
  sections: Set<HTMLElement>;
  anchorTile: HTMLElement | null;
}

function clampZoomStep(val: number): number {
  return Number.isFinite(val)
    ? Math.max(0, Math.min(6, Math.round(val)))
    : DEFAULT_ZOOM_STEP;
}

function loadSavedZoomStep(): number {
  try {
    const raw = localStorage.getItem(ZOOM_PREF_KEY);
    if (raw !== null && /^[0-6]$/.test(raw)) return Number(raw);
  } catch {
    /* Storage optional */
  }
  return DEFAULT_ZOOM_STEP;
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
  const rects = new Map<HTMLElement, DOMRect>();
  const sections = new Set<HTMLElement>();
  const margin = Math.min(480, window.innerHeight / 2);
  let anchorTile: HTMLElement | null = null;
  let minCenterDistance = Infinity;

  for (const child of container.children) {
    if (!(child instanceof HTMLElement) || !child.matches(".day-group")) continue;
    if (!isNearViewport(child.getBoundingClientRect(), margin)) continue;
    const grid = child.querySelector<HTMLElement>(":scope > .photo-grid");
    if (!grid) continue;
    sections.add(child);

    const gridRect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const cols = style.gridTemplateColumns.split(/\s+/).length;
    const rowGap = parseFloat(style.rowGap) || 0;
    const colGap = parseFloat(style.columnGap) || 0;
    const rowHeight = (gridRect.width - (cols - 1) * colGap) / cols + rowGap;
    if (rowHeight <= 0) continue;

    const firstIdx = Math.max(0, Math.floor((-margin - gridRect.top) / rowHeight)) * cols;
    const lastIdx = Math.min(
      grid.children.length,
      Math.ceil((window.innerHeight + margin - gridRect.top) / rowHeight) * cols,
    );

    for (let i = firstIdx; i < lastIdx && rects.size < MAX_FLIP_TILES; i++) {
      const tile = grid.children[i];
      if (!(tile instanceof HTMLElement) || !tile.matches(".photo")) continue;
      const r = tile.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      rects.set(tile, r);
      if (!isNearViewport(r, 0)) continue;
      const dist =
        Math.abs(r.top + r.height / 2 - window.innerHeight / 2) +
        Math.abs(r.left + r.width / 2 - (gridRect.left + gridRect.width / 2)) / 10;
      if (dist < minCenterDistance) {
        anchorTile = tile;
        minCenterDistance = dist;
      }
    }
    if (rects.size >= MAX_FLIP_TILES) break;
  }

  return { container, rects, sections, anchorTile };
}

export function useGridDisplayPreferences() {
  const [zoom, setZoomRaw] = useState(loadSavedZoomStep);
  const [layout, setLayout] = useState<GridAspectMode>(loadSavedAspectMode);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestedZoom = useRef(zoom);
  const committedZoom = useRef(zoom);
  const snapshotRef = useRef<FlipCaptureSnapshot | null>(null);
  const runningAnimations = useRef(new Set<Animation>());
  const unlockedSections = useRef(new Set<HTMLElement>());

  const clearUnlockedSections = useCallback(() => {
    for (const sec of unlockedSections.current) {
      sec.removeAttribute("data-gallery-zoom-active");
    }
    unlockedSections.current.clear();
  }, []);

  const stopRunningAnimations = useCallback(() => {
    for (const anim of runningAnimations.current) {
      anim.onfinish = null;
      anim.oncancel = null;
      anim.cancel();
    }
    runningAnimations.current.clear();
    clearUnlockedSections();
  }, [clearUnlockedSections]);

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
      const clamped = clampZoomStep(nextValue);
      if (clamped === requestedZoom.current) return;
      requestedZoom.current = clamped;
      snapshotRef.current =
        containerRef.current && clamped !== committedZoom.current
          ? captureGridSnapshot(containerRef.current)
          : null;
      stopRunningAnimations();
      setZoomRaw(clamped);
    },
    [stopRunningAnimations],
  );

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_PREF_KEY, String(zoom));
    } catch {
      /* Optional */
    }
  }, [zoom]);

  useEffect(() => {
    try {
      localStorage.setItem(ASPECT_PREF_KEY, layout);
    } catch {
      /* Optional */
    }
  }, [layout]);

  useLayoutEffect(() => {
    committedZoom.current = zoom;
    const prev = snapshotRef.current;
    snapshotRef.current = null;
    if (!prev || containerRef.current !== prev.container) return;

    for (const sec of prev.sections) {
      if (!prev.container.contains(sec)) continue;
      sec.setAttribute("data-gallery-zoom-active", "");
      unlockedSections.current.add(sec);
    }

    if (prev.anchorTile && prev.container.contains(prev.anchorTile)) {
      const beforeBox = prev.rects.get(prev.anchorTile)!;
      const afterBox = prev.anchorTile.getBoundingClientRect();
      const dy = afterBox.top + afterBox.height / 2 - beforeBox.top - beforeBox.height / 2;
      if (Math.abs(dy) > 0.5) {
        window.scrollBy({ top: dy, behavior: "instant" });
      }
    }

    if (
      window.matchMedia(REDUCED_MOTION_QUERY).matches ||
      typeof Element.prototype.animate !== "function"
    ) {
      clearUnlockedSections();
      return;
    }

    const margin = Math.min(480, window.innerHeight / 2);
    const transitions: { tile: HTMLElement; from: DOMRect; to: DOMRect }[] = [];
    for (const [tile, fromRect] of prev.rects) {
      if (!prev.container.contains(tile)) continue;
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
        if (!runningAnimations.current.size) clearUnlockedSections();
      };
      anim.onfinish = cleanup;
      anim.oncancel = cleanup;
    }

    if (!runningAnimations.current.size) clearUnlockedSections();
    return stopRunningAnimations;
  }, [zoom, stopRunningAnimations, clearUnlockedSections]);

  useLayoutEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const abort = () => {
      snapshotRef.current = null;
      stopRunningAnimations();
    };
    mq.addEventListener("change", abort);
    window.addEventListener("resize", abort);
    return () => {
      mq.removeEventListener("change", abort);
      window.removeEventListener("resize", abort);
      abort();
    };
  }, [stopRunningAnimations]);

  const columns = DESKTOP_COLUMN_STEPS[zoom];
  const mobileColumns = MOBILE_COLUMN_STEPS[zoom];
  const cssVars = {
    "--columns": columns,
    "--mobile-columns": mobileColumns,
  } as CSSProperties;

  return {
    zoom,
    setZoom: changeZoom,
    layout,
    setLayout,
    columns,
    mobileColumns,
    timelineProps: {
      className: "timeline aura-gallery",
      ref: bindTimelineElement,
      style: cssVars,
      "data-gallery-zoom": zoom,
      "data-gallery-layout": layout,
    },
    skeletonProps: {
      className: "skeleton-grid gallery-skeleton",
      style: cssVars,
    },
  };
}

export function GridDensityControls({
  zoom,
  onZoomChange,
  layout,
  onLayoutChange,
  disabled = false,
}: {
  zoom: number;
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
        aria-valuetext={`桌面 ${DESKTOP_COLUMN_STEPS[step]} 列，手机 ${MOBILE_COLUMN_STEPS[step]} 列`}
        title="缩略图大小（左小右大）"
        min={0}
        max={6}
        step={1}
        value={step}
        disabled={disabled}
        onChange={(e) => onZoomChange(e.currentTarget.valueAsNumber)}
      />
      <button
        type="button"
        aria-label="放大缩略图"
        title="放大缩略图"
        disabled={disabled || step === 6}
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

  useEffect(() => {
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
          if (e.pointerType === "mouse" && !selecting && !disabled) {
            schedulePreviewWarmup([asset], 180);
          }
        }}
        onPointerLeave={abortSpeculativePreloads}
        onPointerDown={() => {
          if (!selecting && !disabled) {
            schedulePreviewWarmup([asset], 0);
          }
        }}
        onClick={onClick}
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
        >
          {selected && <Check size={14} />}
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

      const firstVisibleTile = [...el.querySelectorAll<HTMLElement>(".photo")].find(
        (node) => node.getBoundingClientRect().top >= 180,
      );
      if (firstVisibleTile?.dataset.assetId) {
        scrollAnchor.current = {
          id: firstVisibleTile.dataset.assetId,
          offsetTop: firstVisibleTile.getBoundingClientRect().top,
        };
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
                  onClick={(e) =>
                    selecting || e.shiftKey
                      ? onToggleAsset(asset.id, e.shiftKey)
                      : onOpenAsset(asset)
                  }
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
