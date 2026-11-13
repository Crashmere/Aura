import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns2,
  Download,
  Film,
  FolderPlus,
  History,
  Info,
  Layers3,
  LoaderCircle,
  MapPin,
  MoreHorizontal,
  Play,
  RotateCcw,
  RotateCw,
  Scissors,
  Sliders,
  Sparkles,
  Star,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  APP_BASE,
  buildMediaUrl,
  describeOriginalRole,
  formatByteSize,
  formatDurationClock,
  formatHumanDate,
  normalizeQuarterAngle,
  orientedDimensions,
  projectVersionAsAsset,
  requestJson,
  summarizeNativeAdjustments,
} from "../core/client";
import type {
  AssetDetailPayload,
  CatalogAsset,
  NativeEditRecord,
  StoredFile,
} from "../core/types";
import { acquireCoverStrip, coverStripResource, useCoverStrip } from "../core/cover-strip";
import { AssetAlbumBadges } from "./AssetAlbumBadges";
import {
  type NetworkMediaMode,
  schedulePreviewWarmup,
  updateMediaMode,
  useNetworkMediaPolicy,
} from "../core/workspace";
import {
  CollapsibleRegion,
  MotionPresence,
  useIsPresent,
  useSlidingIndicator,
} from "../core/motion";
import { ActionButton, CompatibilityPlaybackGlyph, LiveRingsIcon, RoundIconButton, TimelineCrosshairIcon } from "./Icons";
import { clampPhotoPan, usePageScrollLock, usePhotoViewGestures } from "../core/photo-view";
import {
  type FramePlayheadState,
  FrameTimelineStrip,
  ExactCoverPreview,
  PLAYER_SKIP_SECONDS,
  ProgressiveStagePhoto,
  StageVideoPlayer,
} from "./StagePlayer";

function pickMetaValue(meta: Record<string, unknown>, suffixes: string[]): string {
  for (const suffix of suffixes) {
    const key = Object.keys(meta).find(
      (k) => k === suffix || k.endsWith(`:${suffix}`),
    );
    if (key && meta[key] !== undefined && meta[key] !== null && String(meta[key]).trim()) {
      return String(meta[key]).trim();
    }
  }
  return "";
}

function describeEditorSource(editor?: string): string {
  if (!editor) return "原生编辑记录";
  const lower = editor.toLowerCase();
  if (lower.includes("camera")) return "Apple 相机";
  if (lower.includes("mobileslideshow") || lower.includes("photos")) return "Apple 照片";
  return editor;
}

export function LightboxStudio({
  asset,
  currentAlbumId,
  covered = false,
  neighbors,
  positionIndex,
  totalLoaded,
  hasMorePages,
  onClose,
  onSelectAsset,
  onLocateAsset,
  onUpdateAsset,
  onRemoveFromAlbum,
  onOpenAlbumAdd,
  onOpenSimilar,
  onOpenCompare,
  onOpenSplitHistory,
  onRequestPurge,
  onCatalogMutated,
  onNotify,
}: {
  asset: CatalogAsset;
  currentAlbumId?: string;
  covered?: boolean;
  neighbors: CatalogAsset[];
  positionIndex: number;
  totalLoaded: number;
  hasMorePages: boolean;
  onClose: () => void;
  onSelectAsset: (target: CatalogAsset) => void;
  onLocateAsset: (target: CatalogAsset, albumId: string) => Promise<void>;
  onUpdateAsset: (patch: Record<string, unknown>) => Promise<void>;
  onRemoveFromAlbum?: () => Promise<void>;
  onOpenAlbumAdd: () => void;
  onOpenSimilar: (asset: CatalogAsset) => void;
  onOpenCompare: (left: CatalogAsset, right: CatalogAsset) => void;
  onOpenSplitHistory: () => void;
  onRequestPurge: (target: CatalogAsset) => void;
  onCatalogMutated: () => Promise<void>;
  onNotify: (msg: string, isError?: boolean) => void;
}) {
  const isPresent = useIsPresent();
  const mediaPolicy = useNetworkMediaPolicy();
  const [loadedDetail, setDetail] = useState<AssetDetailPayload | null>(null);
  const detail = loadedDetail?.asset.id === asset.id ? loadedDetail : null;
  const [detailLoading, setDetailLoading] = useState(false);
  const [transientAssetId, setTransientAssetId] = useState(asset.id);
  const [selectedHashState, setSelectedHash] = useState<string>("");
  const [playingVideoFileState, setPlayingVideoFile] = useState<StoredFile | null>(null);
  const [playingLiveState, setPlayingLive] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [playbackDiagnosticsOpen, setPlaybackDiagnosticsOpen] = useState(false);

  const [infoOpen, setInfoOpen] = useState(false);
  const [infoTab, setInfoTab] = useState<"overview" | "versions" | "edits" | "raw">("overview");
  const inspectorTabs = useSlidingIndicator(`${infoOpen}:${infoTab}`, '[aria-selected="true"]');
  const [metaFilter, setMetaFilter] = useState("");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [locateMenuOpen, setLocateMenuOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const locateMenuRef = useRef<HTMLDivElement>(null);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [playerControlsHovered, setPlayerControlsHovered] = useState(false);
  const [filmstripOpen, setFilmstripOpen] = useState(false);
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [rotationDeltaState, setRotationDelta] = useState(0);
  const [savingRotation, setSavingRotation] = useState(false);

  const [coverPickerOpenState, setCoverPickerOpen] = useState(false);
  const [frameState, setFrameState] = useState<FramePlayheadState>({
    time: 0,
    duration: 0,
    ready: false,
  });
  const [savingCover, setSavingCover] = useState(false);
  const [mutatingVersion, setMutatingVersion] = useState(false);

  // Zoom & Pan state
  const [zoomScaleState, setZoomScale] = useState(1);
  const [panOffsetState, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [navDir, setNavDir] = useState<"next" | "prev" | "fade">("fade");
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureStartRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    pinchDist: number;
    startZoom: number;
    moved: boolean;
    pinched: boolean;
  } | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Navigation must not mount the outgoing asset's live/video resources for the new photo.
  const hasCurrentTransients = transientAssetId === asset.id;
  const selectedHash = hasCurrentTransients ? selectedHashState : "";
  const playingVideoFile = hasCurrentTransients ? playingVideoFileState : null;
  const playingLive = hasCurrentTransients && playingLiveState;
  const rotationDelta = hasCurrentTransients ? rotationDeltaState : 0;
  const coverPickerOpen = hasCurrentTransients && coverPickerOpenState;
  const zoomScale = hasCurrentTransients ? zoomScaleState : 1;
  const panOffset = hasCurrentTransients ? panOffsetState : { x: 0, y: 0 };

  usePageScrollLock();

  useLayoutEffect(() => {
    if (!covered) rootRef.current?.focus({ preventScroll: true });
  }, [covered]);

  useLayoutEffect(() => {
    if (zoomScale <= 1.01) {
      setPanOffset(previous => previous.x || previous.y ? { x: 0, y: 0 } : previous);
    }
  }, [zoomScale]);

  // Reset per-asset transient state when switching asset
  useLayoutEffect(() => {
    setTransientAssetId(asset.id);
    setSelectedHash("");
    setPlayingVideoFile(null);
    setPlayingLive(false);
    setVideoPlaying(false);
    setPlayerControlsHovered(false);
    setRotationDelta(0);
    setCoverPickerOpen(false);
    setMoreMenuOpen(false);
    setLocateMenuOpen(false);
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
    setIsDragging(false);
    pointersRef.current.clear();
    gestureStartRef.current = null;
    lastTapRef.current = null;
    clearTimeout(tapTimer.current);
  }, [asset.id]);

  useEffect(() => () => {
    clearTimeout(tapTimer.current);
    clearTimeout(chromeTimer.current);
  }, []);

  const chromePinned = playerControlsHovered || infoOpen || moreMenuOpen || locateMenuOpen || coverPickerOpen || rotationDelta !== 0;
  useEffect(() => {
    clearTimeout(chromeTimer.current);
    if (chromePinned) {
      setChromeHidden(false);
    } else if (videoPlaying && !chromeHidden) {
      chromeTimer.current = setTimeout(() => setChromeHidden(true), 2600);
    }
    return () => clearTimeout(chromeTimer.current);
  }, [videoPlaying, chromeHidden, chromePinned, asset.id]);
  useEffect(() => { if (!videoPlaying) setChromeHidden(false); }, [videoPlaying]);

  function revealChrome() {
    setChromeHidden(false);
    clearTimeout(chromeTimer.current);
    if (videoPlaying && !chromePinned) chromeTimer.current = setTimeout(() => setChromeHidden(true), 2600);
  }

  useEffect(() => {
    if (!locateMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !locateMenuRef.current?.contains(event.target)) {
        setLocateMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [locateMenuOpen]);

  // Fetch full detail payload
  useEffect(() => {
    const ctrl = new AbortController();
    setDetailLoading(true);
    requestJson<AssetDetailPayload>(`assets/${asset.id}`, undefined, undefined, ctrl.signal)
      .then((res) => {
        if (!ctrl.signal.aborted) {
          setDetail(res);
        }
      })
      .catch(() => {
        /* Detail fetch error is non-fatal for basic stage browsing */
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setDetailLoading(false);
      });
    return () => ctrl.abort();
  }, [asset.id, asset.primary, asset.rotation, asset.cover?.revision, asset.variants]);

  const files = detail?.files || [];
  const imageFiles = useMemo(
    () => files.filter((f) => f.mime.startsWith("image/")),
    [files],
  );
  const videoFiles = useMemo(
    () => files.filter((f) => f.mime.startsWith("video/")),
    [files],
  );
  const versionSelectableFiles =
    asset.kind === "video" && !imageFiles.length ? videoFiles : imageFiles;

  const activeFile = useMemo(() => {
    if (!files.length) return undefined;
    if (selectedHash) {
      const found = files.find((f) => f.hash === selectedHash);
      if (found) return found;
    }
    return files.find((f) => f.hash === asset.primary) || files[0];
  }, [files, selectedHash, asset.primary]);

  const effectiveAsset = useMemo(() => {
    if (playingVideoFile) {
      return projectVersionAsAsset(asset, playingVideoFile, files);
    }
    if (activeFile && detail) {
      return projectVersionAsAsset(detail.asset, activeFile, files);
    }
    return asset;
  }, [asset, detail, activeFile, playingVideoFile, files]);
  const versionTabs = useSlidingIndicator(
    `${effectiveAsset.primary}:${versionSelectableFiles.length}:${playingVideoFile?.hash || ""}`,
    ".version-pill.is-active",
  );

  const primaryAssetView = useMemo(() => {
    if (!detail) return asset;
    const priFile = files.find((f) => f.hash === detail.asset.primary);
    return priFile ? projectVersionAsAsset(detail.asset, priFile, files) : detail.asset;
  }, [detail, asset, files]);
  const assetAlbums = (detail?.asset || asset).albums || [];

  async function locateAsset(albumId: string) {
    if (locating || isLocked) return;
    setLocateMenuOpen(false);
    setLocating(true);
    try {
      await onLocateAsset(asset, albumId);
    } finally {
      setLocating(false);
    }
  }

  const canNavigatePrev = positionIndex > 0;
  const canNavigateNext = positionIndex >= 0 && (positionIndex < totalLoaded - 1 || hasMorePages);

  const navigateBy = (delta: -1 | 1) => {
    const idx = neighbors.findIndex((x) => x.id === asset.id);
    if (idx < 0) return;
    const target = neighbors[idx + delta];
    if (target) {
      setNavDir(delta > 0 ? "next" : "prev");
      onSelectAsset(target);
    }
  };

  // Warmup adjacent previews when clear photo finishes decoding
  const handleClearPhotoReady = () => {
    const idx = neighbors.findIndex((x) => x.id === asset.id);
    if (idx < 0) return;
    const candidates: CatalogAsset[] = [];
    if (neighbors[idx + 1]) candidates.push(neighbors[idx + 1]);
    if (neighbors[idx - 1]) candidates.push(neighbors[idx - 1]);
    if (candidates.length) schedulePreviewWarmup(candidates, 160);
  };

  const isLocked =
    !!asset.deletionPending || savingRotation || savingCover || mutatingVersion;
  const isVideoStage =
    effectiveAsset.kind === "video" || playingLive || coverPickerOpen;
  const dims = orientedDimensions({
    ...effectiveAsset,
    rotation: normalizeQuarterAngle((effectiveAsset.rotation || 0) + rotationDelta),
  });
  const fit = dims.width > 0 && dims.height > 0 && stageSize.width > 0 && stageSize.height > 0
    ? Math.min(stageSize.width / dims.width, stageSize.height / dims.height) : 1;
  const widthZoom = dims.width > 0 && stageSize.width > 0 ? Math.max(1, stageSize.width / (dims.width * fit)) : 1;
  const longPhoto = !isVideoStage && dims.height >= dims.width * 2.5 && widthZoom > 1.05;
  const maximumZoom = longPhoto ? Math.max(5, widthZoom) : 5;
  const canPickCover =
    effectiveAsset.kind === "video" ||
    (effectiveAsset.kind === "live" && !!effectiveAsset.motion);
  const stripResource = coverStripResource(effectiveAsset);
  const stripState = useCoverStrip(stripResource, coverPickerOpen);
  useEffect(() => {
    if (!stripResource || !isPresent || covered || !mediaPolicy.prefetch) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (!document.hidden) void acquireCoverStrip(stripResource, controller.signal).then((loaded) => loaded.release(), () => {});
    }, 400);
    const stopHidden = () => { if (document.hidden) controller.abort(); };
    document.addEventListener("visibilitychange", stopHidden);
    return () => { clearTimeout(timer); controller.abort(); document.removeEventListener("visibilitychange", stopHidden); };
  }, [stripResource, isPresent, covered, mediaPolicy.prefetch]);
  const hasRotationChange = normalizeQuarterAngle(rotationDelta) !== 0;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      pointersRef.current.clear();
      gestureStartRef.current = null;
      setIsDragging(false);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const scale = Math.min(maximumZoom, zoomScale);
    setZoomScale(previous => Math.min(maximumZoom, previous));
    setPanOffset(previous => {
      const next = clampPhotoPan(previous, scale, stageSize.width, stageSize.height, dims.width, dims.height);
      return next.x === previous.x && next.y === previous.y ? previous : next;
    });
  }, [stageSize.width, stageSize.height, dims.width, dims.height, maximumZoom]);

  function boundPan(pan: { x: number; y: number }, scale: number) {
    return clampPhotoPan(pan, scale, stageSize.width, stageSize.height, dims.width, dims.height);
  }

  function zoomToWidth() {
    setZoomScale(widthZoom);
    setPanOffset(boundPan(panOffset, widthZoom));
  }

  const trackpadActive = usePhotoViewGestures({
    stageRef, scale: zoomScale, pan: panOffset,
    enabled: isPresent && !covered && !coverPickerOpen,
    navigationOnly: isVideoStage,
    imageSize: dims, maximum: maximumZoom,
    onChange: view => { setZoomScale(view.scale); setPanOffset(view.pan); },
    onNavigate: direction => { if (!isLocked) navigateBy(direction); },
  });

  // Rotate handler
  const rotateBy = (step: -90 | 90) => {
    if (isLocked || coverPickerOpen) return;
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
    setRotationDelta((prev) => prev + step);
  };

  async function saveRotationDecision() {
    if (!hasRotationChange || savingRotation || isLocked) return;
    const baseRotation = effectiveAsset.rotation || 0;
    const targetRotation = normalizeQuarterAngle(baseRotation + rotationDelta);
    setSavingRotation(true);
    try {
      const updated = await requestJson<AssetDetailPayload>(
        `assets/${asset.id}/rotation`,
        {
          hash: effectiveAsset.primary,
          rotation: targetRotation,
          expectedRotation: baseRotation,
        },
        "PATCH",
      );
      setDetail(updated);
      setRotationDelta(0);
      onNotify("旋转方向已保存");
      await onCatalogMutated();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSavingRotation(false);
    }
  }

  // Cover frame save / reset
  const openCoverEditor = () => {
    if (!canPickCover || isLocked) return;
    setRotationDelta(0);
    setPlayingLive(false);
    setMoreMenuOpen(false);
    setNavDir("fade");
    const initialSec = effectiveAsset.cover?.time ?? 0;
    setFrameState({
      time: initialSec,
      duration:
        (effectiveAsset.kind === "live"
          ? effectiveAsset.motionDuration
          : effectiveAsset.duration) || 0,
      ready: false,
    });
    setCoverPickerOpen(true);
  };

  async function commitCoverDecision(timeVal: number | null) {
    if (savingCover || isLocked) return;
    const motionHash =
      effectiveAsset.kind === "live"
        ? effectiveAsset.motion || ""
        : effectiveAsset.primary;
    if (!motionHash) return;
    setSavingCover(true);
    try {
      const updated = await requestJson<AssetDetailPayload>(
        `assets/${asset.id}/cover`,
        {
          hash: effectiveAsset.primary,
          motion: motionHash,
          time: timeVal,
          expectedCover: effectiveAsset.cover?.revision || "",
        },
        "PATCH",
      );
      setDetail(updated);
      setCoverPickerOpen(false);
      onNotify(
        timeVal === null
          ? "已恢复默认封面"
          : effectiveAsset.kind === "live"
            ? "已设为实况主画面"
            : "已保存视频封面",
      );
      await onCatalogMutated();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSavingCover(false);
    }
  }

  // Version primary & split actions
  async function setAsPrimaryVersion(hash: string) {
    if (mutatingVersion || isLocked) return;
    setMutatingVersion(true);
    try {
      await onUpdateAsset({ primary: hash });
      const refreshed = await requestJson<AssetDetailPayload>(`assets/${asset.id}`);
      setDetail(refreshed);
      onNotify("已设为主版本");
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setMutatingVersion(false);
    }
  }

  async function splitVersionOut(hash: string) {
    if (mutatingVersion || isLocked || files.length < 2) return;
    setMutatingVersion(true);
    try {
      await requestJson<{ id: string }>(`assets/${asset.id}/split`, { hash });
      setSelectedHash("");
      onNotify("已分离为独立照片，可在整理记录中恢复");
      await onCatalogMutated();
      const refreshed = await requestJson<AssetDetailPayload>(`assets/${asset.id}`);
      setDetail(refreshed);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setMutatingVersion(false);
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPresent || covered || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target instanceof HTMLElement ? e.target : null;
      const targetDialog = target?.closest('[role="dialog"]');
      if (targetDialog && targetDialog !== stageRef.current?.closest('[role="dialog"]')) return;
      const inInput =
        target?.isContentEditable ||
        target?.closest('input, textarea, select, [role="textbox"], [role="combobox"]');

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (locateMenuOpen) {
          setLocateMenuOpen(false);
        } else if (moreMenuOpen) {
          setMoreMenuOpen(false);
        } else if (coverPickerOpen) {
          setCoverPickerOpen(false);
        } else if (hasRotationChange) {
          setRotationDelta(0);
        } else if (playingVideoFile) {
          setPlayingVideoFile(null);
        } else if (playingLive) {
          setPlayingLive(false);
        } else if (zoomScale > 1.01) {
          setZoomScale(1);
          setPanOffset({ x: 0, y: 0 });
        } else {
          onClose();
        }
        return;
      }

      if (inInput) return;

      if ((e.key === "ArrowLeft" || e.key.toLowerCase() === "a") && !coverPickerOpen) {
        e.preventDefault();
        navigateBy(-1);
      } else if ((e.key === "ArrowRight" || e.key.toLowerCase() === "d") && !coverPickerOpen) {
        e.preventDefault();
        navigateBy(1);
      } else if (e.key.toLowerCase() === "i") {
        e.preventDefault();
        setInfoOpen((v) => !v);
      } else if (e.key.toLowerCase() === "r" && !coverPickerOpen) {
        e.preventDefault();
        rotateBy(90);
      } else if (isVideoStage) {
        const root = stageRef.current;
        const video = root?.querySelector("video");
        if (!video) return;
        if (e.key === " ") {
          e.preventDefault();
          root?.querySelector<HTMLButtonElement>("[data-player-toggle]")?.click();
        } else if (e.key.toLowerCase() === "j") {
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - PLAYER_SKIP_SECONDS);
        } else if (e.key.toLowerCase() === "l") {
          e.preventDefault();
          video.currentTime = Math.min(
            video.duration || 0,
            video.currentTime + PLAYER_SKIP_SECONDS,
          );
        } else if (e.key.toLowerCase() === "m") {
          e.preventDefault();
          root?.querySelector<HTMLButtonElement>("[data-player-mute]")?.click();
        } else if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          root?.querySelector<HTMLButtonElement>("[data-player-fullscreen]")?.click();
        } else if (e.key === ",") {
          e.preventDefault();
          root?.querySelector<HTMLButtonElement>("[data-player-previous-frame]")?.click();
        } else if (e.key === ".") {
          e.preventDefault();
          root?.querySelector<HTMLButtonElement>("[data-player-next-frame]")?.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Pointer gestures on photo stage
  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isVideoStage || isLocked || e.button !== 0 ||
      (e.target instanceof Element && e.target.closest("button, a, input"))) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointersRef.current.values()];
    if (pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      gestureStartRef.current = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
        panX: panOffset.x,
        panY: panOffset.y,
        pinchDist: Math.max(10, dist),
        startZoom: zoomScale,
        moved: true,
        pinched: true,
      };
    } else if (pts.length === 1) {
      gestureStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panOffset.x,
        panY: panOffset.y,
        pinchDist: 0,
        startZoom: zoomScale,
        moved: false,
        pinched: false,
      };
    }
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId) || isVideoStage) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const start = gestureStartRef.current;
    if (!start) return;
    const pts = [...pointersRef.current.values()];

    if (pts.length === 2 && start.pinchDist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      setIsDragging(true);
      const nextZoom = Math.max(1, Math.min(maximumZoom, start.startZoom * (dist / start.pinchDist)));
      const rect = stageRef.current!.getBoundingClientRect();
      const midpoint = { x: (pts[0].x + pts[1].x) / 2 - rect.left - rect.width / 2,
        y: (pts[0].y + pts[1].y) / 2 - rect.top - rect.height / 2 };
      const anchor = { x: start.x - rect.left - rect.width / 2, y: start.y - rect.top - rect.height / 2 };
      const ratio = nextZoom / start.startZoom;
      setZoomScale(nextZoom);
      setPanOffset(boundPan({ x: midpoint.x - (anchor.x - start.panX) * ratio,
        y: midpoint.y - (anchor.y - start.panY) * ratio }, nextZoom));
      return;
    }

    if (pts.length === 1) {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 6) {
        start.moved = true;
        setIsDragging(true);
      }
      if (zoomScale > 1.01) {
        setPanOffset(boundPan({ x: start.panX + dx, y: start.panY + dy }, zoomScale));
      }
    }
  };

  const handleStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    const start = gestureStartRef.current;
    if (pointersRef.current.size === 1 && start?.pinched) {
      const remaining = [...pointersRef.current.values()][0];
      gestureStartRef.current = { x: remaining.x, y: remaining.y, panX: panOffset.x,
        panY: panOffset.y, pinchDist: 0, startZoom: zoomScale, moved: true, pinched: true };
      return;
    }
    if (pointersRef.current.size === 0) {
      gestureStartRef.current = null;
      setIsDragging(false);
    }
    if (!start || isVideoStage || start.pinched || e.type === "pointercancel") return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    if (!start.moved) {
      const now = Date.now();
      const last = lastTapRef.current;
      if (last && now - last.time < 280 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 32) {
        clearTimeout(tapTimer.current);
        lastTapRef.current = null;
        if (zoomScale > 1.01) {
          setZoomScale(1);
          setPanOffset({ x: 0, y: 0 });
        } else {
          const rect = stageRef.current!.getBoundingClientRect();
          const scale = longPhoto ? widthZoom : 2.5;
          setZoomScale(scale);
          setPanOffset(boundPan({ x: (e.clientX - rect.left - rect.width / 2) * (1 - scale),
            y: (e.clientY - rect.top - rect.height / 2) * (1 - scale) }, scale));
        }
      } else {
        lastTapRef.current = { time: now, x: e.clientX, y: e.clientY };
        tapTimer.current = setTimeout(() => { if (!chromePinned) setChromeHidden((v) => !v); }, 280);
      }
      return;
    }

    if (zoomScale <= 1.01 && e.pointerType === "touch") {
      if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        if (dx < 0) navigateBy(1);
        else navigateBy(-1);
      } else if (dy > 110 && dy > Math.abs(dx) * 1.4) {
        onClose();
      }
    }
  };

  const combinedMeta = detail?.metadata || {};
  const cameraText = pickMetaValue(combinedMeta, ["Model", "Make"]);
  const lensText = pickMetaValue(combinedMeta, [
    "LensModel",
    "Lens",
    "LensID",
    "LensSpecification",
  ]);
  const focalText = pickMetaValue(combinedMeta, ["FocalLength"]);
  const apertureText = pickMetaValue(combinedMeta, ["FNumber", "ApertureValue"]);
  const shutterText = pickMetaValue(combinedMeta, ["ExposureTime", "ShutterSpeedValue"]);
  const isoText = pickMetaValue(combinedMeta, ["ISO", "ISOSpeedRatings"]);
  const gpsText = pickMetaValue(combinedMeta, ["GPSPosition", "GPSCoordinates"]);

  const matchedEdits = useMemo(() => {
    if (!detail?.edits?.length) return [];
    const activeSourceKey = activeFile?.hints?.sourceKey;
    if (typeof activeSourceKey === "string" && activeSourceKey) {
      const exact = detail.edits.filter((ed) => ed.sourceKey === activeSourceKey);
      if (exact.length) return exact;
    }
    return detail.edits;
  }, [detail?.edits, activeFile]);

  const filteredMetaEntries = useMemo(() => {
    const entries = Object.entries(combinedMeta);
    const q = metaFilter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      ([k, v]) =>
        k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q),
    );
  }, [combinedMeta, metaFilter]);

  return (
    <div
      className={`lightbox-studio ${chromeHidden ? "is-immersive" : ""} ${infoOpen ? "with-inspector" : ""} ${filmstripOpen ? "with-filmstrip" : ""}`}
      ref={rootRef}
      tabIndex={-1}
      inert={covered}
      role="dialog"
      aria-modal={!covered}
      aria-label={effectiveAsset.name}
    >
      {/* Top Bar */}
      <header className="lightbox-topbar">
        <div className="lightbox-title-group">
          <RoundIconButton title="返回照片库（Esc）" onClick={onClose}>
            <X size={20} />
          </RoundIconButton>
          <div className="lightbox-title-text">
            <strong>{effectiveAsset.name}</strong>
            <AssetAlbumBadges asset={effectiveAsset} />
            <small>
              {formatHumanDate(effectiveAsset.capturedAt, true)} · {dims.width} ×{" "}
              {dims.height} · {formatByteSize(effectiveAsset.size)}
              {totalLoaded > 0 ? ` · ${positionIndex + 1} / ${totalLoaded}` : ""}
            </small>
          </div>
        </div>

        <div className="lightbox-toolbar">
          {effectiveAsset.kind === "live" && !!effectiveAsset.motion && !coverPickerOpen && (
            <button
              type="button"
              className={`lightbox-pill-btn ${playingLive ? "is-active" : ""}`}
              onClick={() => {
                setNavDir("fade");
                setPlayingLive((v) => !v);
              }}
              title="播放实况照片"
            >
              <LiveRingsIcon size={15} />
              <span>{playingLive ? "停止实况" : "实况"}</span>
            </button>
          )}

          {!isVideoStage && (
            <>
              <RoundIconButton
                title="缩小视图"
                disabled={zoomScale <= 1.01}
                onClick={() => {
                  setZoomScale(1);
                  setPanOffset({ x: 0, y: 0 });
                }}
              >
                <ZoomOut size={18} />
              </RoundIconButton>
              <RoundIconButton
                title="放大视图"
                onClick={() =>
                  setZoomScale((z) => (z > 2 ? 1 : Math.min(4, z + 1.25)))
                }
              >
                <ZoomIn size={18} />
              </RoundIconButton>
            </>
          )}

          <RoundIconButton
            title="向左旋转 90°"
            disabled={isLocked || coverPickerOpen}
            onClick={() => rotateBy(-90)}
          >
            <RotateCcw size={18} />
          </RoundIconButton>
          <RoundIconButton
            title="向右旋转 90°（R）"
            disabled={isLocked || coverPickerOpen}
            onClick={() => rotateBy(90)}
          >
            <RotateCw size={18} />
          </RoundIconButton>

          {canPickCover && (
            <button
              type="button"
              className={`lightbox-pill-btn ${coverPickerOpen ? "is-active" : ""}`}
              disabled={isLocked}
              onClick={() =>
                coverPickerOpen ? setCoverPickerOpen(false) : openCoverEditor()
              }
            >
              <Film size={15} />
              <span>{effectiveAsset.kind === "live" ? "实况主画面" : "视频封面"}</span>
            </button>
          )}

          {!asset.trashedAt && (
            <div className="lightbox-more-wrap" ref={locateMenuRef}>
              <button type="button"
                className={`icon-btn ${locateMenuOpen ? "is-active" : ""}`}
                title="定位照片" aria-label="定位照片"
                aria-haspopup={assetAlbums.length > 1 ? "menu" : undefined}
                aria-expanded={assetAlbums.length > 1 ? locateMenuOpen : undefined}
                disabled={isLocked || locating}
                onClick={() => {
                  setMoreMenuOpen(false);
                  if (assetAlbums.length > 1) setLocateMenuOpen((open) => !open);
                  else void locateAsset(assetAlbums[0]?.id || "");
                }}>
                {locating ? <LoaderCircle size={18} className="spin" /> : <TimelineCrosshairIcon />}
              </button>
              <MotionPresence present={locateMenuOpen} variant="menu">
                {locateMenuOpen && (
                  <div className="lightbox-dropdown lightbox-locate-dropdown" role="menu" aria-label="定位到">
                    <button type="button" role="menuitem" onClick={() => void locateAsset("")}>
                      照片库
                    </button>
                    {assetAlbums.map((album) => (
                      <button key={album.id} type="button" role="menuitem" title={album.name}
                        onClick={() => void locateAsset(album.id)}>
                        {album.name}
                      </button>
                    ))}
                  </div>
                )}
              </MotionPresence>
            </div>
          )}

          {!asset.trashedAt && (
            <RoundIconButton
              title="加入相片集"
              disabled={isLocked}
              onClick={onOpenAlbumAdd}
            >
              <FolderPlus size={18} />
            </RoundIconButton>
          )}

          {!asset.trashedAt && (
            <RoundIconButton title="查看相似照片" disabled={isLocked}
              onClick={() => onOpenSimilar(asset)}>
              <Sparkles size={18} />
            </RoundIconButton>
          )}

          <a
            className="icon-btn"
            href={
              asset.variants > 1
                ? `${APP_BASE}api/assets/${asset.id}/download`
                : buildMediaUrl(effectiveAsset.primary, "original")
            }
            download
            title={asset.variants > 1 ? "打包下载全部原件（ZIP）" : "下载当前原件"}
            aria-label="下载原件"
          >
            <Download size={18} />
          </a>

          {asset.trashedAt ? (
            <>
              <ActionButton
                variant="primary"
                disabled={isLocked}
                onClick={() => void onUpdateAsset({ trash: false })}
              >
                恢复照片
              </ActionButton>
              <ActionButton
                variant="danger"
                disabled={isLocked}
                onClick={() => onRequestPurge(asset)}
              >
                <Trash2 size={15} />
                <span>永久删除</span>
              </ActionButton>
            </>
          ) : (
            <RoundIconButton
              title="移入最近删除"
              disabled={isLocked}
              onClick={() => void onUpdateAsset({ trash: true })}
            >
              <Trash2 size={18} />
            </RoundIconButton>
          )}

          <div className="lightbox-more-wrap">
            <RoundIconButton
              title="更多操作与画质策略"
              active={moreMenuOpen}
              onClick={() => {
                setLocateMenuOpen(false);
                setMoreMenuOpen((v) => !v);
              }}
            >
              <MoreHorizontal size={18} />
            </RoundIconButton>

            <MotionPresence present={moreMenuOpen} variant="menu">
              {moreMenuOpen && (
                <div className="lightbox-dropdown" role="menu">
                  {isVideoStage && !coverPickerOpen && <>
                    <button type="button" role="menuitem" disabled={isLocked} onClick={() => {
                      rootRef.current?.querySelector<HTMLButtonElement>("[data-player-compatibility]")?.click();
                      setMoreMenuOpen(false);
                    }}><CompatibilityPlaybackGlyph size={16} />使用兼容模式播放</button>
                    <button type="button" role="menuitem" onClick={() => {
                      setPlaybackDiagnosticsOpen(true);
                      setMoreMenuOpen(false);
                    }}><Info size={16} />播放诊断</button>
                    <hr />
                  </>}
                  <div className="mobile-viewer-actions">
                    {longPhoto && <button type="button" role="menuitem" disabled={isLocked} onClick={() => { zoomToWidth(); setMoreMenuOpen(false); }}><ZoomIn size={16} />适应宽度阅读</button>}
                    {!isVideoStage && zoomScale > 1.01 && <button type="button" role="menuitem" onClick={() => { setZoomScale(1); setPanOffset({ x: 0, y: 0 }); setMoreMenuOpen(false); }}><ZoomOut size={16} />查看整图</button>}
                    <button type="button" role="menuitem" disabled={isLocked || coverPickerOpen} onClick={() => { rotateBy(-90); setMoreMenuOpen(false); }}><RotateCcw size={16} />向左旋转</button>
                    <button type="button" role="menuitem" disabled={isLocked || coverPickerOpen} onClick={() => { rotateBy(90); setMoreMenuOpen(false); }}><RotateCw size={16} />向右旋转</button>
                    {canPickCover && <button type="button" role="menuitem" disabled={isLocked} onClick={() => { openCoverEditor(); setMoreMenuOpen(false); }}><Film size={16} />{effectiveAsset.kind === "live" ? "选择实况主画面" : "选择视频封面"}</button>}
                    <button type="button" role="menuitem" onClick={() => { setFilmstripOpen(v => !v); setMoreMenuOpen(false); }}><Layers3 size={16} />{filmstripOpen ? "收起相邻照片与版本" : "相邻照片与版本"}</button>
                    {!asset.trashedAt && <>
                      <button type="button" role="menuitem" disabled={isLocked} onClick={() => { setMoreMenuOpen(false); onOpenAlbumAdd(); }}><FolderPlus size={16} />加入相片集</button>
                      <button type="button" role="menuitem" disabled={isLocked || locating} onClick={() => { setMoreMenuOpen(false); void locateAsset(currentAlbumId || assetAlbums[0]?.id || ""); }}><TimelineCrosshairIcon />定位照片</button>
                    </>}
                    <a role="menuitem" href={asset.variants > 1 ? `${APP_BASE}api/assets/${asset.id}/download` : buildMediaUrl(effectiveAsset.primary, "original")} download><Download size={16} />下载原件</a>
                    <button type="button" role="menuitem" disabled={isLocked} onClick={() => { setMoreMenuOpen(false); void onUpdateAsset({ trash: !asset.trashedAt }); }}><Trash2 size={16} />{asset.trashedAt ? "恢复照片" : "移入最近删除"}</button>
                    {asset.trashedAt && <button type="button" role="menuitem" disabled={isLocked} onClick={() => { setMoreMenuOpen(false); onRequestPurge(asset); }}><Trash2 size={16} />永久删除</button>}
                    <hr />
                  </div>
                  {!asset.trashedAt && (
                    <button type="button" role="menuitem" disabled={isLocked} onClick={() => {
                      setMoreMenuOpen(false);
                      onOpenSimilar(asset);
                    }}>
                      <Sparkles size={14} />
                      <span>查看相似照片</span>
                    </button>
                  )}
                  <div className="dropdown-group-label">清晰图加载策略</div>
                  {(
                    [
                      ["auto", "自动（按网络状况）"],
                      ["quality", "始终高清并预读相邻"],
                      ["save", "省流（手动点按加载）"],
                    ] as [NetworkMediaMode, string][]
                  ).map(([modeKey, label]) => (
                    <button
                      type="button"
                      key={modeKey}
                      role="menuitemradio"
                      aria-checked={mediaPolicy.mode === modeKey}
                      onClick={() => {
                        updateMediaMode(modeKey);
                        setMoreMenuOpen(false);
                      }}
                    >
                      <span>{label}</span>
                      {mediaPolicy.mode === modeKey && <Check size={14} />}
                    </button>
                  ))}

                  <hr />
                  {onRemoveFromAlbum && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMoreMenuOpen(false);
                        void onRemoveFromAlbum();
                      }}
                    >
                      从当前相片集移除
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onOpenSplitHistory();
                    }}
                  >
                    <History size={14} />
                    <span>查看分离与整理记录</span>
                  </button>
                </div>
              )}
            </MotionPresence>
          </div>

          <RoundIconButton
            className="mobile-viewer-info"
            title="信息与原始资源面版（I）"
            active={infoOpen}
            onClick={() => setInfoOpen((v) => !v)}
          >
            <Info size={18} />
          </RoundIconButton>
        </div>
      </header>

      {/* Unsaved Rotation Banner */}
      <CollapsibleRegion open={hasRotationChange && !coverPickerOpen} className="lightbox-bar-reveal">
        <MotionPresence present={hasRotationChange && !coverPickerOpen} variant="panel" exitMs={220}>
          {hasRotationChange && !coverPickerOpen && (
            <div className="lightbox-action-bar" role="region" aria-label="保存旋转方向">
              <span>
                已旋转{" "}
                {normalizeQuarterAngle((effectiveAsset.rotation || 0) + rotationDelta)}°
                （无损浏览方向标记，不重编码原件）
              </span>
              <div className="action-bar-buttons">
                <ActionButton
                  disabled={savingRotation}
                  onClick={() => setRotationDelta(0)}
                >
                  取消
                </ActionButton>
                <ActionButton
                  variant="primary"
                  disabled={savingRotation}
                  onClick={() => void saveRotationDecision()}
                >
                  {savingRotation ? "正在保存…" : "保存方向"}
                </ActionButton>
              </div>
            </div>
          )}
        </MotionPresence>
      </CollapsibleRegion>

      {/* Cover Frame Editor Bar */}
      <CollapsibleRegion open={coverPickerOpen} className="lightbox-bar-reveal">
        <MotionPresence present={coverPickerOpen} variant="panel" exitMs={220}>
          {coverPickerOpen && (
            <div className="lightbox-cover-editor" role="region" aria-label="选择封面帧">
              <div className="cover-editor-head">
                <div className="cover-editor-status">
                  <Film size={16} />
                  <strong>
                    {effectiveAsset.kind === "live"
                      ? "选择实况照片主画面"
                      : "选择视频封面帧"}
                  </strong>
                  <small>
                    当前时刻 {frameState.time.toFixed(2)} 秒 · 可用 , / . 键逐帧微调
                  </small>
                </div>
                <div className="cover-editor-actions">
                  {effectiveAsset.cover && (
                    <ActionButton
                      disabled={savingCover}
                      onClick={() => void commitCoverDecision(null)}
                    >
                      还原默认
                    </ActionButton>
                  )}
                  <ActionButton
                    disabled={savingCover}
                    onClick={() => setCoverPickerOpen(false)}
                  >
                    取消
                  </ActionButton>
                  <ActionButton
                    variant="primary"
                    disabled={savingCover || !frameState.duration}
                    onClick={() => void commitCoverDecision(frameState.time)}
                  >
                    {savingCover
                      ? "正在生成封面…"
                      : effectiveAsset.kind === "live"
                        ? "设为主画面"
                        : "设为封面"}
                  </ActionButton>
                </div>
              </div>
              <FrameTimelineStrip
                asset={effectiveAsset}
                time={frameState.time}
                duration={frameState.duration}
                locked={savingCover}
                stripState={stripState}
                onSeek={(t) => {
                  const video = stageRef.current?.querySelector("video");
                  if (video) {
                    video.pause();
                    video.currentTime = t;
                  }
                }}
              />
            </div>
          )}
        </MotionPresence>
      </CollapsibleRegion>

      {/* Main Stage + Optional Inspector Drawer */}
      <div className="lightbox-workspace">
        <div
          ref={stageRef}
          className="lightbox-stage"
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerUp}
          onPointerCancel={handleStagePointerUp}
        >
          {!coverPickerOpen && canNavigatePrev && (
            <button
              type="button"
              className="lightbox-nav prev"
              aria-label="上一张"
              onClick={(e) => {
                e.stopPropagation();
                navigateBy(-1);
              }}
            >
              <ChevronLeft size={26} />
            </button>
          )}

          <div
            key={`${asset.id}:${effectiveAsset.primary}`}
            className={`lightbox-canvas nav-${navDir} ${isDragging || trackpadActive ? "is-dragging" : ""}`}
            style={
              !isVideoStage && zoomScale > 1.01
                ? { cursor: isDragging ? "grabbing" : "grab" }
                : undefined
            }
          >
            {isVideoStage ? (
              <StageVideoPlayer
                key={`${effectiveAsset.primary}:${playingLive ? "live" : "video"}:${coverPickerOpen ? "picker" : "play"}`}
                asset={effectiveAsset}
                live={playingLive || (coverPickerOpen && effectiveAsset.kind === "live")}
                rotationDelta={rotationDelta}
                locked={isLocked}
                diagnosticsOpen={playbackDiagnosticsOpen}
                onCloseDiagnostics={() => setPlaybackDiagnosticsOpen(false)}
                chromeHidden={chromeHidden}
                onToggleChrome={() => { if (!chromePinned) setChromeHidden((v) => !v); }}
                onActivity={revealChrome}
                onControlsHoverChange={setPlayerControlsHovered}
                onPlaybackChange={setVideoPlaying}
                onEnded={() => {
                  if (playingLive) setPlayingLive(false);
                }}
                onPrevious={() => navigateBy(-1)}
                onNext={() => navigateBy(1)}
                onClose={onClose}
                framePicker={
                  coverPickerOpen
                    ? {
                        initialTime: effectiveAsset.cover?.time ?? 0,
                        onChange: setFrameState,
                      }
                    : undefined
                }
              />
            ) : (
              <ProgressiveStagePhoto
                key={`${effectiveAsset.primary}:${effectiveAsset.rotation || 0}:${effectiveAsset.cover?.revision || ""}`}
                asset={effectiveAsset}
                zoomed={zoomScale > 1.05}
                view={{ scale: zoomScale, pan: panOffset }}
                rotationDelta={rotationDelta}
                originalMime={activeFile?.mime}
                onClearReady={handleClearPhotoReady}
              />
            )}

            {/* Extracted high-res cover preview overlay when paused in frame picker */}
            {coverPickerOpen && frameState.ready && frameState.duration > 0 && (
              <ExactCoverPreview asset={effectiveAsset} time={frameState.time} strip={stripState.strip} />
            )}
          </div>

          {!coverPickerOpen && canNavigateNext && (
            <button
              type="button"
              className="lightbox-nav next"
              aria-label="下一张"
              onClick={(e) => {
                e.stopPropagation();
                navigateBy(1);
              }}
            >
              <ChevronRight size={26} />
            </button>
          )}
        </div>

        {/* Right-Side Inspector Drawer */}
        <div className="inspector-reveal" data-open={infoOpen} aria-hidden={!infoOpen} inert={!infoOpen}>
          <div className="inspector-reveal-inner">
            <MotionPresence present={infoOpen} variant="panel" exitMs={220}>
              {infoOpen && (
                <aside className="lightbox-inspector" aria-label="照片详情与资源管理">
                  <header className="inspector-header">
                    <div
                      className="inspector-tabs motion-tabs"
                      role="tablist"
                      ref={inspectorTabs.ref}
                      style={inspectorTabs.style}
                    >
                      {(
                        [
                          ["overview", "概览"],
                          ["versions", `原件 (${files.length || asset.variants})`],
                          ...(matchedEdits.length ? [["edits", "编辑记录"]] : []),
                          ["raw", "EXIF"],
                        ] as ["overview" | "versions" | "edits" | "raw", string][]
                      ).map(([tabId, label]) => (
                        <button
                          type="button"
                          role="tab"
                          key={tabId}
                          aria-selected={infoTab === tabId}
                          className={infoTab === tabId ? "active" : ""}
                          onClick={() => setInfoTab(tabId)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <RoundIconButton title="收起详情面板" onClick={() => setInfoOpen(false)}>
                      <X size={17} />
                    </RoundIconButton>
                  </header>

                  <div className="inspector-body" key={infoTab}>
                    {detailLoading && !detail && (
                      <div className="loading-inline">
                        <LoaderCircle size={18} className="spin" />
                        <span>正在读取原件与元数据…</span>
                      </div>
                    )}

                    {infoTab === "overview" && (
                      <div className="inspector-section-list">
                        <section className="inspector-card">
                          <h4>基本属性</h4>
                          <dl className="inspector-kv">
                            <div>
                              <dt>
                                <Clock size={14} /> 拍摄时间
                              </dt>
                              <dd>
                                {formatHumanDate(effectiveAsset.capturedAt, true)}{" "}
                                {new Date(effectiveAsset.capturedAt).toLocaleTimeString("zh-CN")}
                              </dd>
                            </div>
                            <div>
                              <dt>尺寸与体积</dt>
                              <dd>
                                {dims.width} × {dims.height} ·{" "}
                                {((dims.width * dims.height) / 1_000_000).toFixed(1)} MP ·{" "}
                                {formatByteSize(effectiveAsset.size)}
                              </dd>
                            </div>
                            {effectiveAsset.grouping && (
                              <div>
                                <dt>
                                  <Layers3 size={14} /> 版本组织
                                </dt>
                                <dd>
                                  {effectiveAsset.grouping === "manual"
                                    ? `手动归并（共 ${effectiveAsset.variants} 份原件）`
                                    : `自动组合（${effectiveAsset.imageVersions} 个照片版本，共 ${effectiveAsset.variants} 份原件）`}
                                </dd>
                              </div>
                            )}
                            {gpsText && (
                              <div>
                                <dt>
                                  <MapPin size={14} /> 地理位置
                                </dt>
                                <dd>{gpsText}</dd>
                              </div>
                            )}
                          </dl>
                        </section>

                        {(cameraText || lensText || focalText || apertureText || shutterText || isoText) && (
                          <section className="inspector-card">
                            <h4>
                              <Camera size={14} /> 拍摄设备与曝光
                            </h4>
                            <div className="camera-badges">
                              {cameraText && <span className="equip-pill">{cameraText}</span>}
                              {lensText && <span className="equip-pill">{lensText}</span>}
                            </div>
                            <div className="exposure-grid">
                              {focalText && (
                                <div>
                                  <small>焦距</small>
                                  <strong>{focalText}</strong>
                                </div>
                              )}
                              {apertureText && (
                                <div>
                                  <small>光圈</small>
                                  <strong>ƒ/{apertureText.replace(/^f\//i, "")}</strong>
                                </div>
                              )}
                              {shutterText && (
                                <div>
                                  <small>快门</small>
                                  <strong>{shutterText}s</strong>
                                </div>
                              )}
                              {isoText && (
                                <div>
                                  <small>ISO</small>
                                  <strong>{isoText}</strong>
                                </div>
                              )}
                            </div>
                          </section>
                        )}
                      </div>
                    )}

                    {infoTab === "versions" && (
                      <div className="inspector-section-list">
                        {files.map((file) => {
                          const isPrimary = file.hash === (detail?.asset.primary || asset.primary);
                          const isCurrent = file.hash === effectiveAsset.primary;
                          const isImg = file.mime.startsWith("image/");
                          const isVid = file.mime.startsWith("video/");
                          return (
                            <article
                              key={file.hash}
                              className={`resource-item-card ${isCurrent ? "is-viewing" : ""}`}
                            >
                              <div className="resource-item-head">
                                <div>
                                  <span className="resource-role-badge">
                                    {describeOriginalRole(file)}
                                  </span>
                                  {isPrimary && (
                                    <span className="resource-primary-badge">
                                      <Star size={11} /> 主版本
                                    </span>
                                  )}
                                </div>
                                <small className="mono-hash">{file.hash.slice(0, 10)}</small>
                              </div>
                              <strong className="resource-filename">{file.name}</strong>
                              <small className="resource-specs">
                                {file.width > 0 && file.height > 0
                                  ? `${file.width} × ${file.height} · `
                                  : ""}
                                {formatByteSize(file.size)} · {file.mime}
                              </small>

                              <div className="resource-actions">
                                {isImg && !isCurrent && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setNavDir("fade");
                                      setPlayingVideoFile(null);
                                      setSelectedHash(file.hash);
                                    }}
                                  >
                                    预览此版本
                                  </button>
                                )}
                                {isVid && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setNavDir("fade");
                                      setPlayingVideoFile((prev) =>
                                        prev?.hash === file.hash ? null : file,
                                      );
                                    }}
                                  >
                                    <Play size={12} />
                                    <span>
                                      {playingVideoFile?.hash === file.hash
                                        ? "返回照片"
                                        : "播放视频"}
                                    </span>
                                  </button>
                                )}
                                {isImg && !isPrimary && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={isLocked}
                                      onClick={() => void setAsPrimaryVersion(file.hash)}
                                    >
                                      设为主版本
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onOpenCompare(
                                          primaryAssetView,
                                          projectVersionAsAsset(
                                            detail?.asset || asset,
                                            file,
                                            files,
                                          ),
                                        )
                                      }
                                    >
                                      <Columns2 size={12} />
                                      <span>对比主版本</span>
                                    </button>
                                  </>
                                )}
                                {files.length > 1 && (
                                  <button
                                    type="button"
                                    disabled={isLocked}
                                    onClick={() => void splitVersionOut(file.hash)}
                                  >
                                    <Scissors size={12} />
                                    <span>分离为独立项</span>
                                  </button>
                                )}
                                <a
                                  href={buildMediaUrl(file.hash, "original")}
                                  download={file.name}
                                >
                                  下载原件
                                </a>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}

                    {infoTab === "edits" && (
                      <div className="inspector-section-list">
                        {matchedEdits.map((rec: NativeEditRecord) => {
                          const summaryRows = summarizeNativeAdjustments(rec);
                          return (
                            <section key={rec.hash} className="inspector-card">
                              <div className="edit-record-header">
                                <strong>
                                  <Sparkles size={14} /> {describeEditorSource(rec.editor)}
                                </strong>
                                {rec.timestamp && (
                                  <small>{formatHumanDate(rec.timestamp, true)}</small>
                                )}
                              </div>
                              <small className="edit-format-tag">
                                格式 {rec.format || "Apple Adjustment"} · 版本{" "}
                                {rec.version || "1.0"}
                              </small>
                              {rec.state === "parsed" && summaryRows.length > 0 ? (
                                <dl className="inspector-kv">
                                  {summaryRows.map((row, idx) => (
                                    <div key={idx}>
                                      <dt>{row.label}</dt>
                                      <dd>{row.value}</dd>
                                    </div>
                                  ))}
                                </dl>
                              ) : (
                                <p className="inspector-note">
                                  {rec.state === "unsupported"
                                    ? "此原生编辑记录使用私有二进制格式，已完整保留原件供下载。"
                                    : "未包含可识别的启用项。"}
                                </p>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    )}

                    {infoTab === "raw" && (
                      <div className="inspector-raw-meta">
                        <input
                          type="search"
                          placeholder="筛选 EXIF / QuickTime 标签…"
                          value={metaFilter}
                          onChange={(e) => setMetaFilter(e.target.value)}
                        />
                        <dl className="raw-meta-list">
                          {filteredMetaEntries.map(([k, v]) => (
                            <div key={k}>
                              <dt>{k}</dt>
                              <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                  </div>
                </aside>
              )}
            </MotionPresence>
          </div>
        </div>
      </div>

      {/* Bottom Version Strip & Nearby Filmstrip */}
      <CollapsibleRegion open={!coverPickerOpen} className="lightbox-bar-reveal lightbox-footer-reveal">
        <footer className="lightbox-bottom-bar">
          {versionSelectableFiles.length > 1 && (
            <div
              className="version-selector-strip motion-tabs"
              role="group"
              aria-label="照片版本切换"
              ref={versionTabs.ref}
              style={versionTabs.style}
            >
              {versionSelectableFiles.map((file) => {
                const active = file.hash === effectiveAsset.primary && !playingVideoFile;
                const isPrimary = file.hash === (detail?.asset.primary || asset.primary);
                return (
                  <button
                    type="button"
                    key={file.hash}
                    className={`version-pill ${active ? "is-active" : ""}`}
                    onClick={() => {
                      setNavDir("fade");
                      setPlayingVideoFile(null);
                      setSelectedHash(file.hash);
                    }}
                  >
                    <img
                      src={buildMediaUrl(
                        file.hash,
                        "thumb",
                        file.rotation,
                        file.cover?.revision,
                      )}
                      alt=""
                    />
                    <span>
                      {describeOriginalRole(file)}
                      {isPrimary ? " · 主" : ""}
                    </span>
                  </button>
                );
              })}
              {effectiveAsset.primary !== (detail?.asset.primary || asset.primary) && (
                <div className="version-quick-actions">
                  <button
                    type="button"
                    disabled={isLocked}
                    onClick={() => void setAsPrimaryVersion(effectiveAsset.primary)}
                  >
                    设为主版本
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenCompare(primaryAssetView, effectiveAsset)}
                  >
                    对比主版本
                  </button>
                </div>
              )}
            </div>
          )}

          {positionIndex >= 0 && neighbors.length > 1 && (
            <div className="filmstrip-rail" role="navigation" aria-label="相邻照片快速跳转">
              {neighbors
                .slice(
                  Math.max(0, positionIndex - 9),
                  Math.min(neighbors.length, positionIndex + 10),
                )
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`filmstrip-thumb ${item.id === asset.id ? "is-current" : ""}`}
                    aria-label={item.name}
                    onClick={() => {
                      const targetIdx = neighbors.findIndex((x) => x.id === item.id);
                      if (targetIdx >= 0 && positionIndex >= 0 && targetIdx !== positionIndex) {
                        setNavDir(targetIdx > positionIndex ? "next" : "prev");
                      } else {
                        setNavDir("fade");
                      }
                      onSelectAsset(item);
                    }}
                  >
                    <img
                      src={buildMediaUrl(
                        item.primary,
                        "thumb",
                        item.rotation,
                        item.cover?.revision,
                      )}
                      alt=""
                      loading="lazy"
                    />
                  </button>
                ))}
            </div>
          )}
        </footer>
      </CollapsibleRegion>
    </div>
  );
}
