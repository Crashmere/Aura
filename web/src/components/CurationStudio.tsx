import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  History,
  Images,
  Layers3,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import {
  formatHumanDate,
  orientedDimensions,
  requestJson,
} from "../core/client";
import { CollapsibleRegion, MotionPresence, useIsPresent, useSlidingIndicator } from "../core/motion";
import { usePageScrollLock, zoomPhotoWithWheel } from "../core/photo-view";
import type {
  CandidatePair,
  CatalogAsset,
  CurationHistoryPage,
  CurationHistoryRecord,
  CurationHistoryType,
  DinoIndexStatus,
  SimilarityScoreRange,
} from "../core/types";
import { ActionButton, RoundIconButton } from "./Icons";
import { ProgressiveStagePhoto } from "./StagePlayer";
import { PhotoTile } from "./TimelineCanvas";
import { AssetAlbumBadges, CurrentAlbumContext } from "./AssetAlbumBadges";
import { SimilarityScoreFilter } from "./SimilarityScoreFilter";

// ============================================================================
// 1. Photo Comparison Studio (Side-by-Side, Split Curtain, A/B Switch with V)
// ============================================================================

export function PhotoComparisonModal({
  left,
  right,
  onClose,
  onMergePair,
}: {
  left: CatalogAsset;
  right: CatalogAsset;
  onClose: () => void;
  onMergePair?: (left: CatalogAsset, right: CatalogAsset) => void;
}) {
  const isPresent = useIsPresent();
  const presentRef = useRef(isPresent);
  presentRef.current = isPresent;
  const rootRef = useRef<HTMLDivElement>(null);
  const closeCb = useRef(onClose);
  closeCb.current = onClose;

  const [mode, setMode] = useState<"side" | "overlay" | "switch">("side");
  const [activeSide, setActiveSide] = useState<"left" | "right">("left");
  const [curtainPercent, setCurtainPercent] = useState(50);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
    width: number;
    height: number;
  } | null>(null);
  const modesIndicator = useSlidingIndicator(mode, '[aria-pressed="true"]');

  usePageScrollLock();

  useLayoutEffect(() => {
    if (zoomScale <= 1.01) {
      setPanOffset(previous => previous.x || previous.y ? { x: 0, y: 0 } : previous);
    }
  }, [zoomScale]);

  const handleStageWheel = useEffectEvent((event: WheelEvent) => {
    if (!isPresent) return;
    event.preventDefault();
    setZoomScale(previous => zoomPhotoWithWheel(previous, event, stageRef.current!.clientHeight));
  });
  useEffect(() => {
    const stage = stageRef.current!;
    stage.addEventListener("wheel", handleStageWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleStageWheel);
  }, []);

  const toggleAbSide = () => {
    setMode("switch");
    setActiveSide((prev) => (prev === "left" ? "right" : "left"));
  };

  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  useEffect(() => {
    const prevFocus = document.activeElement;
    rootRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (
        !presentRef.current ||
        e.defaultPrevented ||
        e.isComposing ||
        e.keyCode === 229 ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.shiftKey
      ) {
        return;
      }
      if (e.key === "Escape" && !e.repeat) {
        e.preventDefault();
        closeCb.current();
        return;
      }
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        target?.isContentEditable ||
        target?.closest(
          'input, textarea, select, [role="textbox"], [role="combobox"], [role="slider"]',
        )
      ) {
        return;
      }
      if (e.key.toLowerCase() === "v" && !e.repeat) {
        e.preventDefault();
        toggleAbSide();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (prevFocus instanceof HTMLElement && prevFocus.isConnected) {
        prevFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const renderStagePhoto = (item: CatalogAsset) => (
    <div
      className="compare-image"
      style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})` }}
    >
      <ProgressiveStagePhoto
        key={`${item.primary}:${item.rotation || 0}:${item.cover?.revision || ""}`}
        asset={item}
        zoomed={zoomScale > 1.05}
        onClearReady={() => {}}
      />
    </div>
  );

  const leftDims = orientedDimensions(left);
  const rightDims = orientedDimensions(right);

  return (
    <CurrentAlbumContext value="">
    <div
      ref={rootRef}
      className={`photo-comparison ${mode === "overlay" ? "is-overlay" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="照片对比"
      tabIndex={-1}
    >
      <header className="comparison-header">
        <h2>照片对比</h2>
        <div
          className="comparison-modes motion-tabs"
          role="group"
          aria-label="对比方式"
          ref={modesIndicator.ref}
          style={modesIndicator.style}
        >
          <button
            type="button"
            aria-pressed={mode === "side"}
            onClick={() => setMode("side")}
          >
            <Columns2 size={15} />
            <span>并排</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "overlay"}
            onClick={() => setMode("overlay")}
          >
            <Layers3 size={15} />
            <span>叠加</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "switch"}
            aria-keyshortcuts="V"
            title="切换显示照片 A / B（V）"
            onClick={toggleAbSide}
          >
            <ArrowLeftRight size={15} />
            <span>切换版本</span>
            <kbd>V</kbd>
          </button>
        </div>
        {onMergePair && left.id !== right.id && (
          <ActionButton disabled={!!left.deletionPending || !!right.deletionPending}
            onClick={() => onMergePair(left, right)}>
            <Layers3 size={15} />归并
          </ActionButton>
        )}
        <RoundIconButton title="关闭对比（Esc）" onClick={onClose}>
          <X size={21} />
        </RoundIconButton>
      </header>

      <div className={`comparison-labels ${mode === "switch" ? "is-switch" : ""}`}>
        <span className={activeSide === "left" ? "is-current" : ""}>
          <strong>A · {left.name}</strong>
          <AssetAlbumBadges asset={left} />
          <small>
            {leftDims.width} × {leftDims.height}
          </small>
        </span>
        <span className={activeSide === "right" ? "is-current" : ""}>
          <strong>B · {right.name}</strong>
          <AssetAlbumBadges asset={right} />
          <small>
            {rightDims.width} × {rightDims.height}
          </small>
        </span>
      </div>

      <div
        ref={stageRef}
        className="comparison-workspace"
        style={{ cursor: zoomScale > 1.01 ? isDragging ? "grabbing" : "grab" : undefined }}
        onPointerDown={(e) => {
          if (!isPresent || e.button !== 0 || zoomScale <= 1.01 || dragRef.current) return;
          const target = e.target instanceof HTMLElement ? e.target : null;
          if (target?.closest("button, input, .comparison-divider")) return;
          const section = target?.closest("section");
          if (!section) return;
          const rect = section.getBoundingClientRect();
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = {
            pointerId: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            panX: panOffset.x,
            panY: panOffset.y,
            width: rect.width,
            height: rect.height,
          };
          setIsDragging(true);
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== e.pointerId || zoomScale <= 1.01) return;
          const maxX = (drag.width * (zoomScale - 1)) / 2;
          const maxY = (drag.height * (zoomScale - 1)) / 2;
          setPanOffset({
            x: Math.max(-maxX, Math.min(maxX, drag.panX + e.clientX - drag.x)),
            y: Math.max(-maxY, Math.min(maxY, drag.panY + e.clientY - drag.y)),
          });
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        {mode === "switch" ? (
          <div className="comparison-single">
            <section
              aria-label={`照片 A：${left.name}`}
              aria-hidden={activeSide !== "left"}
            >
              {renderStagePhoto(left)}
            </section>
            <section
              aria-label={`照片 B：${right.name}`}
              aria-hidden={activeSide !== "right"}
            >
              {renderStagePhoto(right)}
            </section>
          </div>
        ) : mode === "side" ? (
          <div className="comparison-side">
            <section aria-label={`照片 A：${left.name}`}>
              {renderStagePhoto(left)}
            </section>
            <section aria-label={`照片 B：${right.name}`}>
              {renderStagePhoto(right)}
            </section>
          </div>
        ) : (
          <div
            className="comparison-overlay"
            style={{ "--compare-position": `${curtainPercent}%` } as CSSProperties}
          >
            <section aria-label={`照片 B：${right.name}`}>
              {renderStagePhoto(right)}
            </section>
            <section
              className="comparison-reveal"
              aria-label={`照片 A：${left.name}`}
            >
              {renderStagePhoto(left)}
            </section>
            <div
              className="comparison-divider"
              aria-hidden="true"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                setCurtainPercent(
                  Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)),
                );
              }}
            >
              <span>↔</span>
            </div>
          </div>
        )}
      </div>

      <CollapsibleRegion open={mode === "overlay"} className="comparison-slider-region">
        <footer className="comparison-slider">
          <span>A</span>
          <input
            aria-label="叠加对比位置"
            type="range"
            min="0"
            max="100"
            value={curtainPercent}
            onChange={(e) => setCurtainPercent(Number(e.target.value))}
          />
          <span>B</span>
        </footer>
      </CollapsibleRegion>
    </div>
    </CurrentAlbumContext>
  );
}

// ============================================================================
// 2. Curation Review History Modal (Dismissed Similar Pairs & Split Records)
// ============================================================================

export function CurationHistoryModal({
  initialKind,
  onClose,
  onCatalogMutated,
  onOpenAsset,
  onComparePair,
  onNotify,
  covered = false,
}: {
  initialKind: CurationHistoryType;
  onClose: () => void;
  onCatalogMutated: () => Promise<void>;
  onOpenAsset: (asset: CatalogAsset) => void;
  onComparePair: (left: CatalogAsset, right: CatalogAsset) => void;
  onNotify: (msg: string, isError?: boolean) => void;
  covered?: boolean;
}) {
  const [kind, setKind] = useState<CurationHistoryType>(initialKind);
  const [pageData, setPageData] = useState<CurationHistoryPage>({
    items: [],
    assets: {},
    next: "",
  });
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const isPresent = useIsPresent();
  const presentRef = useRef(isPresent);
  presentRef.current = isPresent;
  const tabsIndicator = useSlidingIndicator<HTMLElement>(kind, '[aria-pressed="true"]');

  const abortRef = useRef<AbortController | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  const closeCb = useRef(onClose);
  closeCb.current = onClose;
  const blockedRef = useRef(false);
  blockedRef.current = covered || !!restoringId;
  const activeKindRef = useRef(kind);
  activeKindRef.current = kind;

  useEffect(() => {
    const prevFocus = document.activeElement;
    modalRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        presentRef.current &&
        !e.isComposing &&
        !e.defaultPrevented &&
        !blockedRef.current
      ) {
        e.preventDefault();
        closeCb.current();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      abortRef.current?.abort();
      if (prevFocus instanceof HTMLElement && prevFocus.isConnected) {
        prevFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  async function fetchHistory(append = false) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setErrorMsg("");
    try {
      const res = await requestJson<CurationHistoryPage>(
        `review-history?${new URLSearchParams({
          kind,
          limit: "20",
          ...(append && pageData.next ? { cursor: pageData.next } : {}),
        }).toString()}`,
        undefined,
        undefined,
        ctrl.signal,
      );
      if (!ctrl.signal.aborted) {
        setPageData((prev) =>
          append
            ? {
                items: [...prev.items, ...res.items],
                assets: { ...prev.assets, ...res.assets },
                next: res.next,
              }
            : res,
        );
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    setPageData({ items: [], assets: {}, next: "" });
    void fetchHistory();
    return () => abortRef.current?.abort();
  }, [kind, reloadTick]);

  async function handleRestoreRecord(record: CurationHistoryRecord) {
    if (restoringId) return;
    const requestedKind = kind;
    setRestoringId(record.id);
    try {
      if (kind === "similar") {
        await requestJson(
          "similar/ignore",
          { left: record.left, right: record.right },
          "DELETE",
        );
      } else {
        await requestJson(`splits/${record.id}/restore`, {}, "POST");
      }
      if (activeKindRef.current === requestedKind) {
        setPageData((prev) => ({
          ...prev,
          items: prev.items.filter((x) => x.id !== record.id),
        }));
      }
      onNotify(
        kind === "similar"
          ? "已撤销确认不同，可重新参与推荐"
          : "已重新组合，所有原件均已保留",
      );
      await onCatalogMutated();
      if (activeKindRef.current === requestedKind) {
        setReloadTick((v) => v + 1);
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
      setReloadTick((v) => v + 1);
    } finally {
      setRestoringId("");
    }
  }

  return (
    <CurrentAlbumContext value="">
    <div
      className="modal-scrim review-history-scrim"
      onClick={() => {
        if (!restoringId) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal-card review-history-modal"
        role="dialog"
        aria-modal={!covered}
        aria-label="整理记录"
        inert={covered}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>
            <History size={18} />
            <span>整理记录</span>
          </h2>
          <RoundIconButton
            title="关闭整理记录"
            disabled={!!restoringId}
            onClick={onClose}
          >
            <X size={20} />
          </RoundIconButton>
        </header>

        <nav
          className="review-history-tabs motion-tabs"
          aria-label="记录类型"
          ref={tabsIndicator.ref}
          style={tabsIndicator.style}
        >
          <button
            type="button"
            aria-pressed={kind === "similar"}
            disabled={!!restoringId}
            onClick={() => setKind("similar")}
          >
            已确认不同
          </button>
          <button
            type="button"
            aria-pressed={kind === "split"}
            disabled={!!restoringId}
            onClick={() => setKind("split")}
          >
            分离记录
          </button>
        </nav>

        <div className="modal-body review-history-body" key={kind}>
          {errorMsg && (
            <div className="inline-alert">
              <span>{errorMsg}</span>
              <ActionButton onClick={() => void fetchHistory()}>重试</ActionButton>
            </div>
          )}

          {!pageData.items.length && !loading && !errorMsg && (
            <p className="review-history-empty">
              {kind === "similar"
                ? "没有已确认不同的候选"
                : "没有待恢复的分离记录"}
            </p>
          )}

          {pageData.items.map((rec) => {
            const leftAsset = pageData.assets[rec.left];
            const rightAsset = pageData.assets[rec.right];
            return (
              <article
                className="review-history-item"
                key={rec.id}
                aria-busy={restoringId === rec.id}
              >
                <div className="review-history-photos">
                  {[leftAsset, rightAsset].map((asset, idx) =>
                    asset ? (
                      <PhotoTile
                        key={idx}
                        asset={asset}
                        originalAspect
                        onClick={() => onOpenAsset(asset)}
                        disabled={!!restoringId || !!asset.deletionPending}
                      />
                    ) : (
                      <div key={idx} className="history-photo-unavailable">
                        照片已不在图库中
                      </div>
                    ),
                  )}
                </div>
                <div className="review-history-info">
                  <strong>
                    {kind === "similar" ? "已确认不同" : rec.name || "分离的版本"}
                  </strong>
                  <small>
                    {formatHumanDate(rec.createdAt, true)}{" "}
                    {new Date(rec.createdAt).toLocaleTimeString("zh-CN")}
                  </small>
                  {rec.reason && <p>{rec.reason}</p>}
                  <div className="review-history-actions">
                    {leftAsset && rightAsset && leftAsset.id !== rightAsset.id && (
                      <ActionButton
                        disabled={
                          !!restoringId ||
                          !!leftAsset.deletionPending ||
                          !!rightAsset.deletionPending
                        }
                        onClick={() => onComparePair(leftAsset, rightAsset)}
                      >
                        对比
                      </ActionButton>
                    )}
                    <ActionButton
                      disabled={!!restoringId || !rec.canRestore}
                      onClick={() => void handleRestoreRecord(rec)}
                    >
                      {restoringId === rec.id ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <RotateCcw size={14} />
                      )}
                      <span>
                        {kind === "similar" ? "撤销确认不同" : "重新组合"}
                      </span>
                    </ActionButton>
                  </div>
                </div>
              </article>
            );
          })}

          {loading && (
            <p className="review-history-empty">
              <LoaderCircle size={18} className="spin" />
              <span>正在读取记录</span>
            </p>
          )}

          {!loading && pageData.next && (
            <ActionButton
              disabled={!!restoringId}
              onClick={() => void fetchHistory(true)}
            >
              加载更多记录
            </ActionButton>
          )}
        </div>
      </section>
    </div>
    </CurrentAlbumContext>
  );
}

// ============================================================================
// 3. Similar Media Workspace (dHash & DINOv2)
// ============================================================================

export function SimilarWorkspaceView({
  video = false,
  onSelectMedia,
  source,
  onSelectSource,
  pairs,
  assetsMap,
  counts,
  paginationTotal,
  pageSize,
  onSelectPageSize,
  resultsSource,
  resultsVideo,
  hasResults,
  resultsStale,
  scoreRange,
  onSelectScoreRange,
  error,
  onRetry,
  dinoIndex,
  pageIndex,
  hasNextPage,
  loading,
  ignoringKey,
  lastIgnoredPair,
  onSelectDinoPage,
  onAppendDhash,
  onOpenHistory,
  onOpenAsset,
  onComparePair,
  onMergePair,
  onIgnorePair,
  onUndoIgnore,
}: {
  video?: boolean;
  onSelectMedia: (media: "photo" | "video") => void;
  source: "dhash" | "dino";
  onSelectSource: (src: "dhash" | "dino") => void;
  pairs: CandidatePair[];
  assetsMap: Record<string, CatalogAsset>;
  counts?: Record<"dhash" | "dino", number>;
  paginationTotal?: number;
  pageSize: number;
  onSelectPageSize: (size: number) => void;
  resultsSource: "dhash" | "dino";
  resultsVideo: boolean;
  hasResults: boolean;
  resultsStale: boolean;
  scoreRange: SimilarityScoreRange;
  onSelectScoreRange: (range: SimilarityScoreRange) => void;
  error: string;
  onRetry: () => void;
  dinoIndex?: DinoIndexStatus;
  pageIndex: number;
  hasNextPage: boolean;
  loading: boolean;
  ignoringKey: string;
  lastIgnoredPair: CandidatePair | null;
  onSelectDinoPage: (pageIndex: number) => void;
  onAppendDhash: () => void;
  onOpenHistory: () => void;
  onOpenAsset: (asset: CatalogAsset) => void;
  onComparePair: (left: CatalogAsset, right: CatalogAsset, evidence?: CandidatePair) => void;
  onMergePair: (left: CatalogAsset, right: CatalogAsset) => void;
  onIgnorePair: (pair: CandidatePair) => Promise<void>;
  onUndoIgnore: (pair: CandidatePair) => Promise<void>;
}) {
  const tabsIndicator = useSlidingIndicator(source, ".active");
  const mediaIndicator = useSlidingIndicator(video ? "video" : "photo", ".active");
  const resultsDisabled = loading || resultsStale || !!error;
  const moreRef = useRef<HTMLDivElement>(null);
  const canAppendDhash = source === "dhash" && resultsSource === "dhash"
    && hasNextPage && !resultsDisabled && !ignoringKey;
  const appendVisibleDhash = useEffectEvent(() => {
    if (canAppendDhash) onAppendDhash();
  });
  useEffect(() => {
    const more = moreRef.current;
    if (!canAppendDhash || !more) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) appendVisibleDhash();
    }, { rootMargin: "0px 0px 200px 0px" });
    observer.observe(more);
    return () => observer.disconnect();
  }, [canAppendDhash]);
  const pageCount = Math.max(1, Math.ceil((paginationTotal || 0) / pageSize));
  const currentPage = Math.min(pageCount, pageIndex + 1);
  const windowStart = Math.max(2, Math.min(currentPage - 1, pageCount - 3));
  const pageNumbers = pageCount <= 7
    ? Array.from({ length: pageCount }, (_, i) => i + 1)
    : [1, windowStart, windowStart + 1, windowStart + 2, pageCount];
  const [jumpPage, setJumpPage] = useState("");
  useEffect(() => setJumpPage(""), [pageIndex, pageSize, video, source]);
  const jumpTarget = Number(jumpPage);
  const validJump = Number.isInteger(jumpTarget) && jumpTarget >= 1 && jumpTarget <= pageCount;
  const dinoPager = (
    <nav className="similar-toolbar-pagination" aria-label="智能推荐分页" aria-busy={loading}>
      <div className="similar-page-buttons">
        <button className="btn" type="button" aria-label="上一页" title="上一页"
          disabled={resultsDisabled || !!ignoringKey || currentPage === 1}
          onClick={() => onSelectDinoPage(currentPage - 2)}><ChevronLeft size={16} /></button>
        {pageNumbers.map((page, index) => <React.Fragment key={page}>
          {index > 0 && page - pageNumbers[index - 1] > 1 && <span className="similar-page-gap">...</span>}
          <button type="button" className={`btn${page === currentPage ? " btn-primary" : ""}`}
            aria-label={`第 ${page} 页`} aria-current={page === currentPage ? "page" : undefined}
            disabled={resultsDisabled || !!ignoringKey || paginationTotal === undefined || paginationTotal === 0}
            onClick={() => onSelectDinoPage(page - 1)}>{page}</button>
        </React.Fragment>)}
        <button className="btn" type="button" aria-label="下一页" title="下一页"
          disabled={resultsDisabled || !!ignoringKey || currentPage === pageCount}
          onClick={() => onSelectDinoPage(currentPage)}><ChevronRight size={16} /></button>
      </div>
      <label className="similar-page-size">每页
        <select aria-label="每页候选组数" value={pageSize} disabled={!!ignoringKey}
          onChange={event => onSelectPageSize(Number(event.target.value))}>
          {[20, 50, 100].map(size => <option key={size} value={size}>{size} 组</option>)}
        </select>
      </label>
      <span className="similar-page-summary" aria-live="polite">
        共 {paginationTotal?.toLocaleString("zh-CN") ?? "-"} 组 / {paginationTotal === undefined ? "-" : pageCount} 页
      </span>
    </nav>
  );

  return (
    <CurrentAlbumContext value="">
    <div className="similar-workspace">
      <div className="similar-review-toolbar">
        <div className="similar-mode-switches">
          <div
            className="similar-tabs motion-tabs"
            aria-label="媒体类型"
            ref={mediaIndicator.ref}
            style={mediaIndicator.style}
          >
            <button
              type="button"
              className={!video ? "active" : ""}
              aria-pressed={!video}
              disabled={!!ignoringKey}
              onClick={() => onSelectMedia("photo")}
            >
              <Images size={15} />
              <span>照片</span>
            </button>
            <button
              type="button"
              className={video ? "active" : ""}
              aria-pressed={video}
              disabled={!!ignoringKey}
              onClick={() => onSelectMedia("video")}
            >
              <Video size={15} />
              <span>视频</span>
            </button>
          </div>
          <div
            className="similar-tabs motion-tabs"
            aria-label="分析方式"
            ref={tabsIndicator.ref}
            style={tabsIndicator.style}
          >
            <button
              type="button"
              className={source === "dhash" ? "active" : ""}
              aria-pressed={source === "dhash"}
              disabled={!!ignoringKey}
              onClick={() => onSelectSource("dhash")}
            >
              <Copy size={16} />
              <span>算法判定</span>
              <small className="similar-count" title="候选总数">
                {counts ? counts.dhash.toLocaleString("zh-CN") : "-"}
              </small>
            </button>
            <button
              type="button"
              className={source === "dino" ? "active" : ""}
              aria-pressed={source === "dino"}
              disabled={!!ignoringKey}
              onClick={() => onSelectSource("dino")}
            >
              <Sparkles size={16} />
              <span>智能推荐</span>
              <small className="similar-count" title="候选总数">
                {counts ? counts.dino.toLocaleString("zh-CN") : "-"}
              </small>
            </button>
          </div>
        </div>
        <div className={`similar-filter-tools${source === "dhash" ? " is-compact" : ""}`}>
          {source === "dino" && <div className="similar-score-toolbar">
            <SimilarityScoreFilter range={scoreRange} disabled={!!ignoringKey} onChange={onSelectScoreRange} />
          </div>}
          {source === "dino" && <form className="similar-page-jump" onSubmit={event => {
            event.preventDefault();
            if (!resultsDisabled && !ignoringKey && validJump) onSelectDinoPage(jumpTarget - 1);
          }}>
            <label>跳至<input type="number" min={1} max={pageCount} aria-label="跳转页码"
              placeholder={String(currentPage)} value={jumpPage} disabled={resultsDisabled || !!ignoringKey}
              onChange={event => setJumpPage(event.target.value)} />页</label>
            <ActionButton type="submit" disabled={resultsDisabled || !!ignoringKey || !validJump}>前往</ActionButton>
          </form>}
          <span className="similar-switch-status" role="status" aria-busy={loading}>
            {loading && <LoaderCircle size={14} className="spin" aria-label="正在更新候选" />}
          </span>
        </div>
        {source === "dino" && dinoPager}
        <button
          type="button"
          className="btn review-history-link"
          onClick={onOpenHistory}
        >
          <History size={14} />
          <span>已确认不同</span>
        </button>
      </div>

      <MotionPresence present={!!dinoIndex} variant="panel">
        {dinoIndex && (
          <div className="similar-index-banner">
            {dinoIndex.state === "processing" && (
              <LoaderCircle size={14} className="spin" />
            )}
            <span>
              {dinoIndex.state === "unavailable"
                ? "智能分析暂不可用，稍后自动重试"
                : dinoIndex.state === "disabled"
                  ? "智能分析已暂停"
                  : dinoIndex.pending
                    ? `${dinoIndex.state === "processing" ? "正在分析" : "等待批量分析"} · ${dinoIndex.ready} / ${dinoIndex.total}`
                    : `已分析 ${dinoIndex.ready} ${video ? "条视频" : "张照片"}`}
            </span>
            {dinoIndex.engine && <span className="index-engine-pill">{dinoIndex.engine}</span>}
            {!!dinoIndex.errors && <span>{dinoIndex.errors} {video ? "条" : "张"}稍后重试</span>}
          </div>
        )}
      </MotionPresence>

      {error && <div className="asset-similar-error" role="alert">
        <span>{error}</span>
        <button className="btn" type="button" disabled={loading} onClick={onRetry}>重试</button>
      </div>}

      <div className={`similar-results${resultsStale && hasResults ? " is-updating" : ""}`}
        aria-busy={loading} inert={resultsStale || undefined}>

      <MotionPresence present={!!lastIgnoredPair} variant="panel">
        {lastIgnoredPair && (
          <div className="similar-undo-banner">
            <span>已确认一组候选不同，后续不再提示。</span>
            <button
              type="button"
              disabled={resultsDisabled || !!ignoringKey}
              onClick={() => void onUndoIgnore(lastIgnoredPair)}
            >
              撤销
            </button>
          </div>
        )}
      </MotionPresence>

      {loading && !hasResults ? (
        <div className="loading-inline">
          <LoaderCircle className="spin" size={20} />
          <span>{video ? "正在查找相似视频" : "正在查找相似照片"}</span>
        </div>
      ) : !pairs.length && !hasNextPage && !error ? (
        <div className="empty-state">
          <div className="empty-icon-ring">
            <Copy size={28} strokeWidth={1.3} />
          </div>
          <h2>
            {resultsVideo ? (!resultsStale && dinoIndex?.pending ? "索引更新后会显示相似视频" : "未找到符合条件的相似视频") :
            resultsSource === "dino" && pageIndex > 0
              ? "当前页暂无推荐照片"
              : resultsSource === "dino" && !resultsStale && (scoreRange[0] > .7 || scoreRange[1] < 1)
                ? "没有符合相似度范围的照片"
              : resultsSource === "dino" && !resultsStale && dinoIndex?.pending
                ? "分析完成后会显示推荐照片"
                : resultsSource === "dino"
                  ? "暂无智能推荐"
                  : "没有算法判定相似的照片"}
          </h2>
        </div>
      ) : (
        <div
          className="similar-pairs-grid"
          aria-busy={loading}
        >
          {pairs.map((pair) => {
            const left = assetsMap[pair.left];
            const right = assetsMap[pair.right];
            if (!left || !right) return null;
            return (
              <article
                className="similar-pair-card"
                key={`${pair.left}:${pair.right}`}
                aria-busy={ignoringKey === `${pair.left}:${pair.right}`}
              >
                <PhotoTile
                  asset={left}
                  originalAspect
                  disabled={resultsDisabled}
                  onClick={() => onOpenAsset(left)}
                />
                <PhotoTile
                  asset={right}
                  originalAspect
                  disabled={resultsDisabled}
                  onClick={() => onOpenAsset(right)}
                />
                <div className="pair-actions">
                  <div className="pair-meta">
                    {ignoringKey === `${pair.left}:${pair.right}` && (
                      <LoaderCircle size={14} className="spin" aria-label="正在整理" />
                    )}
                    <strong>
                      {resultsSource === "dino" ? "画面内容相近" : resultsVideo ? "多帧时序相近" : "图像指纹相近"}
                    </strong>
                    {resultsSource === "dino" && pair.score !== undefined && (
                      <small className="similar-score">
                        特征相似度 {(100 * Math.min(1, pair.score)).toFixed(1)}%
                      </small>
                    )}
                    {resultsVideo && pair.coverage !== undefined && <small>抽样帧匹配率 {(pair.coverage * 100).toFixed(0)}%</small>}
                    <small>
                      {left.width} × {left.height} · {right.width} × {right.height}
                    </small>
                  </div>
                  <div className="pair-buttons">
                    <ActionButton
                      disabled={resultsDisabled || !!left.deletionPending || !!right.deletionPending}
                      onClick={() => onComparePair(left, right, pair)}
                    >
                      <Columns2 size={15} />
                      <span>对比</span>
                    </ActionButton>
                    <ActionButton
                      variant="primary"
                      disabled={resultsDisabled || !!ignoringKey || !!left.deletionPending || !!right.deletionPending}
                      onClick={() => void onMergePair(left, right)}
                    >
                      <Layers3 size={15} />
                      <span>归并为一项</span>
                    </ActionButton>
                    <ActionButton
                      className="similar-ignore-btn"
                      disabled={resultsDisabled || !!ignoringKey}
                      onClick={() => void onIgnorePair(pair)}
                    >
                      确认不同
                    </ActionButton>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {resultsSource === "dhash" && hasNextPage && (
        <div className="similar-more-wrap" ref={moreRef}>
          <ActionButton disabled={resultsDisabled || !!ignoringKey} onClick={onAppendDhash}>
            {loading ? "正在加载" : "加载更多候选"}
          </ActionButton>
        </div>
      )}
      {resultsVideo && <p className="video-similarity-note">按抽样画面判断，不比较音轨；归并后所有原件均保留。</p>}
      </div>
    </div>
    </CurrentAlbumContext>
  );
}
