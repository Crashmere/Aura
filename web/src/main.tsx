import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  CalendarDays,
  CheckCheck,
  CloudUpload,
  Columns2,
  Copy,
  FolderOpen,
  FolderPlus,
  History,
  Images,
  Layers,
  Layers3,
  ListChecks,
  LoaderCircle,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { formatByteSize, requestJson } from "./core/client";
import {
  enqueueUploadFiles,
  getUploadActivitySummary,
  markAssetsPurgedInQueue,
  subscribeUploadEngine,
} from "./core/importer";
import { ConfirmPurgeModal, PurgeStatusBanner, usePurgeTracker } from "./core/purge-tracker";
import { CollapsibleRegion, MotionPresence, useSlidingIndicator } from "./core/motion";
import type {
  AlbumGroup,
  AlbumItem,
  CandidatePair,
  CatalogAsset,
  CurationHistoryType,
  DinoIndexStatus,
  LibraryTelemetry,
  PurgeRequestReceipt,
  SimilarCandidatesPage,
  SimilarityScoreRange,
  TimelineSummary,
  WorkspaceViewId,
} from "./core/types";
import {
  buildActiveFilterChips,
  createEmptyFilters,
  type FilterParameterKey,
  readRouteFromWindow,
  resolveMonthBounds,
  serializeFilterParams,
  syncRouteToWindow,
  VIEW_TITLES,
  WORKSPACE_MODULES,
  type WorkspaceRouteState,
} from "./core/workspace";
import {
  AlbumActionModal,
  type AlbumModalState,
  AlbumsCollectionGrid,
} from "./components/AlbumsStudio";
import {
  CurationHistoryModal,
  PhotoComparisonModal,
  SimilarWorkspaceView,
} from "./components/CurationStudio";
import { ActiveFiltersBar, FilterSheet } from "./components/FilterSheet";
import { ActionButton, LiveRingsIcon, RoundIconButton } from "./components/Icons";
import { ImportHubModal } from "./components/ImportHub";
import { LightboxStudio } from "./components/LightboxStudio";
import { PipelineTaskCenter } from "./components/PipelineCenter";
import { CurrentAlbumContext } from "./components/AssetAlbumBadges";
import { MergePhotosModal } from "./components/MergePhotosModal";
import {
  type DayAssetGroup,
  GridDensityControls,
  useGridDisplayPreferences,
  VirtualizedTimelineCanvas,
} from "./components/TimelineCanvas";
import "./styles/aura.css";
import "./styles/motion.css";
import "./styles/motion-gallery.css";
import "./styles/motion-studios.css";
import "./styles/motion-viewer.css";

// ============================================================================
// Global Keyboard Focus & Tab Interception Policy
// ============================================================================

function installKeyboardFocusGuard(): void {
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (
        e.key === "Tab" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.isComposing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
      }
    },
    true,
  );
}

installKeyboardFocusGuard();

// ============================================================================
// Navigation Icon Resolver
// ============================================================================

function ModuleIcon({ id }: { id: WorkspaceViewId }) {
  switch (id) {
    case "all":
      return <Images size={17} />;
    case "live":
      return <LiveRingsIcon size={17} />;
    case "videos":
      return <Video size={17} />;
    case "albums":
      return <FolderOpen size={17} />;
    case "automatic":
      return <Layers size={17} />;
    case "merged":
      return <Layers3 size={17} />;
    case "grouped":
      return <Sparkles size={17} />;
    case "similar":
      return <Copy size={17} />;
    case "jobs":
      return <ListChecks size={17} />;
    case "trash":
      return <Trash2 size={17} />;
  }
}

// ============================================================================
// Main Aura Application Shell
// ============================================================================

function AuraApplication() {
  const [route, setRoute] = useState<WorkspaceRouteState>(readRouteFromWindow);
  const [searchDraft, setSearchDraft] = useState(route.query);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [monthRailOpen, setMonthRailOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const navigationIndicator = useSlidingIndicator<HTMLElement>(route.view);
  const monthIndicator = useSlidingIndicator(`${route.from}:${route.to}`);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const main = header?.parentElement;
    if (!header || !main) return;

    // The command header can wrap, so the month rail must track its actual height.
    const updateHeight = () => {
      main.style.setProperty("--sticky-header-height", `${header.getBoundingClientRect().height}px`);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => {
      observer.disconnect();
      main.style.removeProperty("--sticky-header-height");
    };
  }, []);

  // Telemetry & Catalog
  const [telemetry, setTelemetry] = useState<LibraryTelemetry>();
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [albumGroups, setAlbumGroups] = useState<AlbumGroup[]>([]);
  const [activeAlbumDetail, setActiveAlbumDetail] = useState<AlbumItem | null>(null);
  const [months, setMonths] = useState<{ month: string; count: number }[]>([]);

  const [assets, setAssets] = useState<CatalogAsset[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [openAssetObj, setOpenAssetObj] = useState<CatalogAsset | null>(null);

  // Selection state
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIdRef = useRef<string>("");
  const [batchBusy, setBatchBusy] = useState(false);

  // Modals & Studios
  const [uploadHubTab, setUploadHubTab] = useState<string | null>(null);
  const [albumModal, setAlbumModal] = useState<AlbumModalState | null>(null);
  const [purgeTargets, setPurgeTargets] = useState<CatalogAsset[] | null>(null);
  const [comparePair, setComparePair] = useState<{
    left: CatalogAsset;
    right: CatalogAsset;
  } | null>(null);
  const [mergePair, setMergePair] = useState<{ left: CatalogAsset; right: CatalogAsset } | null>(null);
  const [historyKind, setHistoryKind] = useState<CurationHistoryType | null>(null);
  const [toast, setToast] = useState<{
    text: string;
    isError?: boolean;
  } | null>(null);
  const [dragHover, setDragHover] = useState(false);
  const internalDrag = useRef(false);

  useEffect(() => {
    let dragTimeout: number | undefined;
    const resetDrag = () => {
      window.clearTimeout(dragTimeout);
      setDragHover(false);
    };
    // Browsers can expose page images as files during a native drag.
    const onDragStart = () => {
      internalDrag.current = true;
      resetDrag();
    };
    const onDragEnd = () => {
      internalDrag.current = false;
      resetDrag();
    };
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = internalDrag.current ? "none" : "copy";
      if (internalDrag.current) return;
      setDragHover(true);
      window.clearTimeout(dragTimeout);
      // Native drag cancellation can omit dragend and keyboard events in the page.
      dragTimeout = window.setTimeout(resetDrag, 1200);
    };
    const onDragLeave = (event: DragEvent) => {
      if (
        !event.relatedTarget &&
        (event.clientX <= 0 || event.clientY <= 0 ||
          event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)
      ) resetDrag();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") resetDrag();
    };
    const onVisibilityChange = () => {
      if (document.hidden) resetDrag();
    };

    window.addEventListener("dragstart", onDragStart, true);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", resetDrag);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("blur", resetDrag);
    window.addEventListener("pointermove", resetDrag);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(dragTimeout);
      window.removeEventListener("dragstart", onDragStart, true);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", resetDrag);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("blur", resetDrag);
      window.removeEventListener("pointermove", resetDrag);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Similar studio state
  const [similarSource, setSimilarSource] = useState<"dhash" | "dino">("dhash");
  const [dinoScoreRange, setDinoScoreRange] = useState<SimilarityScoreRange>([.7, 1]);
  const [similarPairs, setSimilarPairs] = useState<CandidatePair[]>([]);
  const [similarAssets, setSimilarAssets] = useState<Record<string, CatalogAsset>>({});
  const [similarCounts, setSimilarCounts] = useState<Record<"dhash" | "dino", number>>();
  const [similarTotal, setSimilarTotal] = useState(0);
  const [similarError, setSimilarError] = useState("");
  const [dinoIndex, setDinoIndex] = useState<DinoIndexStatus>();
  const [similarNext, setSimilarNext] = useState("");
  const [dinoPageIdx, setDinoPageIdx] = useState(0);
  const dinoCursorsRef = useRef<string[]>([""]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const similarRequestIdRef = useRef(0);
  const similarRequestRef = useRef<AbortController | null>(null);
  const similarPageRef = useRef<{ source: "dhash" | "dino"; cursor: string; pageIndex: number; scoreRange: SimilarityScoreRange }>({
    source: "dhash", cursor: "", pageIndex: 0, scoreRange: [.7, 1],
  });
  const [ignoringKey, setIgnoringKey] = useState("");
  const [lastIgnoredPair, setLastIgnoredPair] = useState<CandidatePair | null>(null);

  const gridPrefs = useGridDisplayPreferences();
  const uploadActivity = useSyncExternalStore(subscribeUploadEngine, getUploadActivitySummary);

  const showToast = useCallback((text: string, isError = false) => {
    setToast({ text, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Migrate legacy ?unfiled=1 preference if present
  useEffect(() => {
    try {
      if (localStorage.getItem("aura-hide-album-assets") === "1") {
        localStorage.removeItem("aura-hide-album-assets");
        setRoute((prev) =>
          prev.filters.albumState
            ? prev
            : { ...prev, filters: { ...prev.filters, albumState: "none" } },
        );
      }
    } catch {
      /* Storage optional */
    }
  }, []);

  // Browser history popstate sync
  useEffect(() => {
    const onPop = () => {
      const next = readRouteFromWindow();
      setRoute(next);
      setSearchDraft(next.query);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const updateRoute = useCallback(
    (
      updater: (prev: WorkspaceRouteState) => WorkspaceRouteState,
      historyMode: "push" | "replace" = "replace",
    ) => {
      setRoute((prev) => {
        const next = updater(prev);
        syncRouteToWindow(next, historyMode);
        return next;
      });
    },
    [],
  );

  // Debounce search box input into route.query
  useEffect(() => {
    if (searchDraft === route.query) return;
    const t = setTimeout(() => {
      updateRoute((prev) => ({ ...prev, query: searchDraft }), "replace");
    }, 260);
    return () => clearTimeout(t);
  }, [searchDraft, route.query, updateRoute]);

  const currentModule = useMemo(
    () => WORKSPACE_MODULES.find((m) => m.id === route.view) || WORKSPACE_MODULES[0],
    [route.view],
  );

  const isAlbumOverview = route.view === "albums" && !route.album;
  const isGalleryView = route.view !== "similar" && route.view !== "jobs" && !isAlbumOverview;

  // Build shared query parameters for /api/assets and /api/timeline
  const buildCatalogQuery = useCallback(
    (includeCaptureDates = true, cursor = "") => {
      const params = new URLSearchParams(serializeFilterParams(route.filters));
      if (route.view !== "all" && route.view !== "similar" && route.view !== "jobs") {
        params.set("view", route.view);
      }
      if (route.view === "albums" && route.album) {
        params.set("album", route.album);
      }
      if (route.query.trim()) {
        params.set("q", route.query.trim());
      }
      if (includeCaptureDates) {
        if (route.from) params.set("from", route.from);
        if (route.to) params.set("to", route.to);
      }
      if (cursor) params.set("cursor", cursor);
      return params;
    },
    [route.filters, route.view, route.album, route.query, route.from, route.to],
  );

  // Fetch global info & albums list
  const fetchOverview = useCallback(async () => {
    try {
      const [infoRes, albumsRes, groupsRes] = await Promise.all([
        requestJson<LibraryTelemetry>("info"),
        requestJson<AlbumItem[]>("albums"),
        requestJson<AlbumGroup[]>("album-groups"),
      ]);
      setTelemetry(infoRes);
      setAlbums(albumsRes);
      setAlbumGroups(groupsRes);
      if (route.view === "albums" && route.album) {
        const found = albumsRes.find((a) => a.id === route.album);
        if (found) {
          setActiveAlbumDetail(found);
        } else {
          const detailRes = await requestJson<AlbumItem>(`albums/${route.album}`).catch(() => null);
          setActiveAlbumDetail(detailRes);
        }
      } else {
        setActiveAlbumDetail(null);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }, [route.view, route.album, showToast]);

  // Fetch timeline month counts
  const fetchTimelineMonths = useCallback(async () => {
    if (!isGalleryView) {
      setMonths([]);
      return;
    }
    try {
      const q = buildCatalogQuery(false);
      const res = await requestJson<TimelineSummary>(`timeline?${q.toString()}`);
      setMonths(res.months || []);
    } catch {
      /* Non-critical */
    }
  }, [isGalleryView, buildCatalogQuery]);

  // Fetch gallery page
  const pageReqIdRef = useRef(0);
  const galleryScopeRef = useRef("");
  const fetchGalleryPage = useCallback(
    async (cursor = "", append = false) => {
      if (!isGalleryView) return;
      const reqId = ++pageReqIdRef.current;
      setLoadingPage(true);
      setLoadError("");
      try {
        const q = buildCatalogQuery(true, cursor);
        const res = await requestJson<{ items: CatalogAsset[]; next: string }>(
          `assets?${q.toString()}`,
        );
        if (reqId !== pageReqIdRef.current) return;
        setAssets((prev) => {
          if (!append) return res.items;
          const seen = new Set(prev.map((x) => x.id));
          return [...prev, ...res.items.filter((x) => !seen.has(x.id))];
        });
        setNextCursor(res.next);
      } catch (err) {
        if (reqId === pageReqIdRef.current) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (reqId === pageReqIdRef.current) {
          setLoadingPage(false);
        }
      }
    },
    [isGalleryView, buildCatalogQuery],
  );

  // Bounded refresh of loaded gallery items without resetting scroll
  const refreshBoundedCatalog = useCallback(async () => {
    const similarRequestId = similarRequestIdRef.current;
    const similarWasLoading = !!similarRequestRef.current;
    await Promise.all([fetchOverview(), fetchTimelineMonths()]);
    if (route.view === "similar") {
      // A delayed background refresh must not replace a page the user just requested.
      if (similarWasLoading || similarRequestRef.current || similarRequestId !== similarRequestIdRef.current) return;
      const page = similarPageRef.current;
      void fetchSimilarCandidates(
        page.source,
        page.cursor,
        false,
        page.pageIndex,
      );
      return;
    }
    if (!isGalleryView) return;

    try {
      const firstPageQuery = buildCatalogQuery(true, "");
      const firstPage = await requestJson<{
        items: CatalogAsset[];
        next: string;
      }>(`assets?${firstPageQuery.toString()}`);
      setAssets((prev) => {
        if (prev.length <= firstPage.items.length) {
          setNextCursor(firstPage.next);
          return firstPage.items;
        }
        return prev;
      });

      if (assets.length > 0) {
        const boundedIds = [
          ...new Set([
            ...assets.slice(0, 300).map((a) => a.id),
            ...selectedIds,
            ...(route.asset ? [route.asset] : []),
          ]),
        ].slice(0, 900);

        if (boundedIds.length > 0) {
          const idQuery = buildCatalogQuery(true, "");
          idQuery.set("ids", boundedIds.join(","));
          idQuery.set("limit", String(boundedIds.length));
          const refreshed = await requestJson<{ items: CatalogAsset[] }>(
            `assets?${idQuery.toString()}`,
          );
          const refreshedMap = new Map(refreshed.items.map((x) => [x.id, x]));
          const firstIds = new Set(firstPage.items.map((x) => x.id));

          setAssets((prev) => {
            const mergedTop = [...firstPage.items];
            for (const old of prev) {
              if (firstIds.has(old.id)) continue;
              const updated = refreshedMap.get(old.id);
              if (updated) mergedTop.push(updated);
            }
            return mergedTop;
          });
        }
      }
    } catch {
      void fetchGalleryPage("", false);
    }
  }, [
    fetchOverview,
    fetchTimelineMonths,
    route.view,
    route.asset,
    isGalleryView,
    buildCatalogQuery,
    assets,
    selectedIds,
    fetchGalleryPage,
  ]);

  // Initial & filter-change reload
  const filterKey = JSON.stringify({
    view: route.view,
    album: route.album,
    q: route.query.trim(),
    from: route.from,
    to: route.to,
    filters: route.filters,
  });

  useEffect(() => {
    void fetchOverview();
    void fetchTimelineMonths();
    setSelectedIds(new Set());
    setSelecting(false);
    if (isGalleryView) {
      const scope = `${route.view}:${route.album}`;
      if (galleryScopeRef.current !== scope) setAssets([]);
      galleryScopeRef.current = scope;
      setNextCursor("");
      void fetchGalleryPage("", false);
    }
  }, [filterKey]);

  // Listen to global library change events (e.g. upload finished)
  useEffect(() => {
    const onChanged = () => {
      void refreshBoundedCatalog();
    };
    window.addEventListener("aura-library-changed", onChanged);
    return () => window.removeEventListener("aura-library-changed", onChanged);
  }, [refreshBoundedCatalog]);

  // Background poll when server has active processing jobs
  useEffect(() => {
    const hasActiveWork =
      (telemetry?.queued || 0) > 0 ||
      (telemetry?.similarityIndex?.state === "processing" && route.view === "similar");
    if (!hasActiveWork) return;
    const t = setInterval(() => {
      if (!document.hidden) void refreshBoundedCatalog();
    }, 4500);
    return () => clearInterval(t);
  }, [telemetry?.queued, telemetry?.similarityIndex?.state, route.view, refreshBoundedCatalog]);

  // Infinite scroll pagination trigger for gallery
  useEffect(() => {
    if (!isGalleryView || !nextCursor || loadingPage || loadError) return;
    const checkScrollBottom = () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 850) {
        void fetchGalleryPage(nextCursor, true);
      }
    };
    window.addEventListener("scroll", checkScrollBottom, { passive: true });
    return () => window.removeEventListener("scroll", checkScrollBottom);
  }, [isGalleryView, nextCursor, loadingPage, loadError, fetchGalleryPage]);

  // Sync openAssetObj with route.asset
  useEffect(() => {
    if (!route.asset) {
      setOpenAssetObj(null);
      return;
    }
    const inLoaded = assets.find((a) => a.id === route.asset);
    if (inLoaded) {
      setOpenAssetObj(inLoaded);
      return;
    }
    let alive = true;
    requestJson<{ asset: CatalogAsset }>(`assets/${route.asset}`)
      .then((res) => {
        if (alive) setOpenAssetObj(res.asset);
      })
      .catch(() => {
        if (alive) {
          setOpenAssetObj(null);
          updateRoute((prev) => ({ ...prev, asset: "" }), "replace");
        }
      });
    return () => {
      alive = false;
    };
  }, [route.asset, assets, updateRoute]);

  // Auto-load next page when viewer approaches end of loaded list
  const openAssetIndex = useMemo(
    () => (openAssetObj ? assets.findIndex((a) => a.id === openAssetObj.id) : -1),
    [openAssetObj, assets],
  );

  useEffect(() => {
    if (openAssetIndex >= 0 && assets.length - openAssetIndex <= 5 && nextCursor && !loadingPage) {
      void fetchGalleryPage(nextCursor, true);
    }
  }, [openAssetIndex, assets.length, nextCursor, loadingPage, fetchGalleryPage]);

  // Similar Candidates Fetcher
  async function fetchSimilarCandidates(src: "dhash" | "dino", cursor = "", append = false, pageIndex = 0,
    scoreRange = similarPageRef.current.scoreRange) {
    const requestId = ++similarRequestIdRef.current;
    similarRequestRef.current?.abort();
    const controller = new AbortController();
    similarRequestRef.current = controller;
    similarPageRef.current = { source: src, cursor: append ? similarPageRef.current.cursor : cursor, pageIndex, scoreRange };
    setSimilarLoading(true);
    setSimilarError("");
    try {
      const q = new URLSearchParams({
        source: src,
        paged: "true",
        limit: "20",
        ...(cursor ? { cursor } : {}),
      });
      if (src === "dino") {
        q.set("minScore", String(scoreRange[0]));
        q.set("maxScore", String(scoreRange[1]));
      }
      const res = await requestJson<SimilarCandidatesPage>(`similar?${q.toString()}`, undefined, undefined, controller.signal);
      if (requestId !== similarRequestIdRef.current) return;
      setSimilarPairs((prev) => (append ? [...prev, ...res.items] : res.items));
      setSimilarAssets((prev) => (append ? { ...prev, ...res.assets } : res.assets || {}));
      setSimilarCounts(res.counts);
      setSimilarTotal(res.total);
      if (res.index) setDinoIndex(res.index);
      setSimilarNext(res.next || "");
      if (src === "dino") setDinoPageIdx(pageIndex);
    } catch (err) {
      if (requestId === similarRequestIdRef.current && !controller.signal.aborted) {
        setSimilarError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (requestId === similarRequestIdRef.current) {
        similarRequestRef.current = null;
        setSimilarLoading(false);
      }
    }
  }

  useEffect(() => {
    if (route.view !== "similar") return;
    dinoCursorsRef.current = [""];
    if (similarPageRef.current.source !== similarSource) {
      setDinoPageIdx(0);
      setSimilarPairs([]);
      setSimilarNext("");
    }
    void fetchSimilarCandidates(similarSource, "", false, 0, dinoScoreRange);
    return () => {
      similarRequestIdRef.current++;
      similarRequestRef.current?.abort();
      similarRequestRef.current = null;
    };
  }, [route.view, similarSource, dinoScoreRange]);

  // Group loaded assets by calendar capture day
  const dayGroups = useMemo<DayAssetGroup[]>(() => {
    const map = new Map<string, CatalogAsset[]>();
    for (const item of assets) {
      const day = (item.capturedAt || "").slice(0, 10) || "未知日期";
      const list = map.get(day);
      if (list) list.push(item);
      else map.set(day, [item]);
    }
    return [...map.entries()].map(([date, items]) => ({ date, items }));
  }, [assets]);

  // Selection helpers
  const toggleSelectAsset = useCallback(
    (id: string, shiftRange: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (shiftRange && lastClickedIdRef.current && lastClickedIdRef.current !== id) {
          const idxA = assets.findIndex((a) => a.id === lastClickedIdRef.current);
          const idxB = assets.findIndex((a) => a.id === id);
          if (idxA >= 0 && idxB >= 0) {
            const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
            for (let i = lo; i <= hi; i++) {
              if (!assets[i].deletionPending) next.add(assets[i].id);
            }
            lastClickedIdRef.current = id;
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        lastClickedIdRef.current = id;
        return next;
      });
      if (!selecting) setSelecting(true);
    },
    [assets, selecting],
  );

  const toggleSelectDayGroup = useCallback((groupItems: CatalogAsset[]) => {
    const eligible = groupItems.filter((a) => !a.deletionPending);
    if (!eligible.length) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = eligible.every((a) => next.has(a.id));
      for (const item of eligible) {
        if (allSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
    setSelecting(true);
  }, []);

  const selectAllLoaded = () => {
    const eligible = assets.filter((a) => !a.deletionPending).map((a) => a.id);
    if (eligible.every((id) => selectedIds.has(id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(eligible));
    }
  };

  // Batch mutations
  async function batchSetTrash(trash: boolean) {
    if (batchBusy || !selectedIds.size) return;
    setBatchBusy(true);
    try {
      const ids = [...selectedIds].slice(0, 1000);
      await requestJson("assets", { ids, trash }, "PATCH");
      setSelectedIds(new Set());
      setSelecting(false);
      showToast(trash ? `已将 ${ids.length} 项移入最近删除` : `已恢复 ${ids.length} 项照片`);
      await refreshBoundedCatalog();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
      await refreshBoundedCatalog();
    } finally {
      setBatchBusy(false);
    }
  }

  function batchMergeSelected() {
    const ids = [...selectedIds];
    if (ids.length !== 2 || batchBusy) return;
    const left = assets.find((asset) => asset.id === ids[0]);
    const right = assets.find((asset) => asset.id === ids[1]);
    if (left && right) setMergePair({ left, right });
  }

  async function batchRemoveFromCurrentAlbum() {
    if (!route.album || !selectedIds.size || batchBusy) return;
    setBatchBusy(true);
    try {
      const ids = [...selectedIds];
      await requestJson(`albums/${route.album}/assets`, { assets: ids }, "DELETE");
      setSelectedIds(new Set());
      setSelecting(false);
      showToast(`已从相片集移除 ${ids.length} 项`);
      await refreshBoundedCatalog();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBatchBusy(false);
    }
  }

  async function setSelectedAlbumCover() {
    if (route.view !== "albums" || !route.album || selectedIds.size !== 1 || batchBusy) return;
    const assetId = [...selectedIds][0];
    if (!assets.some((asset) => asset.id === assetId && !asset.deletionPending)) return;
    setBatchBusy(true);
    try {
      await requestJson(`albums/${route.album}/cover`, { assetId }, "PATCH");
      showToast("相片集封面已更新");
      await refreshBoundedCatalog();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBatchBusy(false);
    }
  }

  // Permanent deletion tracker
  const purgeTracker = usePurgeTracker(
    route.view === "trash" || (telemetry?.pendingDeletions || 0) > 0,
    () => {
      void refreshBoundedCatalog();
    },
    (completedTask) => {
      markAssetsPurgedInQueue(completedTask.ids);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of completedTask.ids) next.delete(id);
        return next;
      });
    },
    telemetry?.pendingDeletions,
  );

  // Switch navigation module
  const switchWorkspaceModule = (viewId: WorkspaceViewId) => {
    setMobileNavOpen(false);
    setSelecting(false);
    setSelectedIds(new Set());
    setSearchDraft("");
    updateRoute(
      () => ({
        view: viewId,
        album: "",
        query: "",
        from: "",
        to: "",
        asset: "",
        filters: createEmptyFilters(),
      }),
      "push",
    );
  };

  // Locate a specific asset from ImportHub or PipelineCenter
  const locateAssetInLibrary = async (assetId: string) => {
    setUploadHubTab(null);
    try {
      const detail = await requestJson<{ asset: CatalogAsset }>(`assets/${assetId}`);
      const targetView: WorkspaceViewId = detail.asset.trashedAt ? "trash" : "all";
      setSearchDraft("");
      updateRoute(
        () => ({
          view: targetView,
          album: "",
          query: "",
          from: "",
          to: "",
          asset: assetId,
          filters: createEmptyFilters(),
        }),
        "push",
      );
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("aura-gallery-scroll", { detail: assetId }));
      }, 150);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  };

  const activeChips = useMemo(() => buildActiveFilterChips(route.filters), [route.filters]);
  const hasAnyFilter = !!route.query || !!route.from || !!route.to || activeChips.length > 0;

  return (
    <CurrentAlbumContext value={route.view === "albums" ? route.album : ""}>
    <div
      className="aura-shell"
      onDrop={(e) => {
        e.preventDefault();
        setDragHover(false);
        if (internalDrag.current) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length > 0) {
          enqueueUploadFiles(files, route.view === "albums" ? route.album : "");
          setUploadHubTab("files");
        }
      }}
    >
      {/* Left Navigation Sidebar */}
      <aside className={`aura-sidebar ${mobileNavOpen ? "is-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark">
            <img src="/aura/favicon.svg" alt="Aura" />
            <div>
              <strong>Aura</strong>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary sidebar-upload-cta"
            onClick={() => {
              setMobileNavOpen(false);
              setUploadHubTab("files");
            }}
          >
            <CloudUpload size={16} />
            <span>导入照片</span>
          </button>
        </div>

        <nav
          className="sidebar-nav motion-tabs"
          ref={navigationIndicator.ref}
          style={navigationIndicator.style}
          aria-label="主导航"
        >
          {(
            [
              ["browse", "浏览与相片集"],
              ["curation", "版本与智能整理"],
              ["system", "处理与维护"],
            ] as const
          ).map(([secKey, secTitle]) => (
            <div className="nav-section" key={secKey}>
              <span className="nav-section-title">{secTitle}</span>
              {WORKSPACE_MODULES.filter((m) => m.section === secKey).map((mod) => {
                const badge = mod.badgeCount?.(telemetry, albums.length);
                const isActive = route.view === mod.id;
                return (
                  <button
                    type="button"
                    key={mod.id}
                    className={`nav-item ${isActive ? "is-active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => switchWorkspaceModule(mod.id)}
                  >
                    <span className="nav-item-label">
                      <ModuleIcon id={mod.id} />
                      <span>{mod.title}</span>
                    </span>
                    {badge !== undefined && (
                      <small className="nav-badge">{badge.toLocaleString("zh-CN")}</small>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <footer className="sidebar-footer">
          {uploadActivity.total > 0 && (
            <button
              type="button"
              className="sidebar-upload-pill"
              onClick={() => setUploadHubTab("files")}
            >
              {uploadActivity.running || uploadActivity.scanning ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <CheckCheck size={15} />
              )}
              <span>
                上传队列 {uploadActivity.completed} / {uploadActivity.total}
              </span>
            </button>
          )}
          {telemetry && (
            <div className="storage-summary">
              <div className="storage-row">
                <span>原件存储</span>
                <strong>{formatByteSize(telemetry.bytes)}</strong>
              </div>
              <small>
                共 {telemetry.originals.toLocaleString("zh-CN")} 份原件 ·{" "}
                {telemetry.total.toLocaleString("zh-CN")} 项照片
              </small>
            </div>
          )}
        </footer>
      </aside>

      <MotionPresence present={mobileNavOpen}>
        {mobileNavOpen && (
          <div className="mobile-sidebar-backdrop" onClick={() => setMobileNavOpen(false)} />
        )}
      </MotionPresence>

      {/* Main Content Stage */}
      <div className="aura-main">
        {/* Sticky Command Header */}
        <header className="aura-header" ref={headerRef}>
          <div className="header-left">
            <button
              type="button"
              className="icon-btn mobile-menu-trigger"
              aria-label="打开导航菜单"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu size={20} />
            </button>

            {route.view === "albums" && route.album ? (
              <div className="album-breadcrumb" key={`album:${route.album}`}>
                <button
                  type="button"
                  className="btn btn-subtle"
                  onClick={() => updateRoute((prev) => ({ ...prev, album: "" }), "push")}
                >
                  <ArrowLeft size={16} />
                  <span>相片集</span>
                </button>
                {activeAlbumDetail && (
                  <RoundIconButton
                    title="重命名相片集"
                    onClick={() => setAlbumModal({ kind: "rename", album: activeAlbumDetail })}
                  >
                    <Pencil size={16} />
                  </RoundIconButton>
                )}
                <h1>{activeAlbumDetail?.name || "相片集"}</h1>
                {activeAlbumDetail && (
                  <small className="header-count-pill">{activeAlbumDetail.count} 项</small>
                )}
              </div>
            ) : (
              <div className="header-title-block" key={`view:${route.view}`}>
                <h1>{VIEW_TITLES[route.view]}</h1>
                {currentModule.subtitle && (
                  <p className="header-subtitle">{currentModule.subtitle}</p>
                )}
              </div>
            )}
          </div>

          <div className="header-controls">
            {currentModule.supportsSearch && !isAlbumOverview && (
              <div className="header-search">
                <Search size={15} />
                <input
                  type="search"
                  aria-label="搜索照片文件名、相机或元数据"
                  placeholder="搜索文件名、相机、镜头…"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                />
                {searchDraft && (
                  <button
                    type="button"
                    aria-label="清空搜索"
                    onClick={() => {
                      setSearchDraft("");
                      updateRoute((prev) => ({ ...prev, query: "" }), "replace");
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            )}

            {currentModule.supportsTimelineFilters && !isAlbumOverview && (
              <>
                <button
                  ref={filterBtnRef}
                  type="button"
                  className={`btn ${activeChips.length || route.from || route.to ? "btn-active-filter" : ""}`}
                  onClick={() => setFilterSheetOpen(true)}
                >
                  <SlidersHorizontal size={15} />
                  <span>筛选</span>
                  {activeChips.length > 0 && (
                    <small className="chip-counter">{activeChips.length}</small>
                  )}
                </button>

                {months.length > 0 && (
                  <button
                    type="button"
                    className={`btn ${monthRailOpen ? "btn-active-filter" : ""}`}
                    onClick={() => setMonthRailOpen((v) => !v)}
                    title="按月份快速定位"
                  >
                    <CalendarDays size={15} />
                    <span>月份</span>
                  </button>
                )}

                <GridDensityControls
                  zoom={gridPrefs.zoom}
                  maxZoom={gridPrefs.maxZoom}
                  desktopColumnSteps={gridPrefs.desktopColumnSteps}
                  mobileColumnSteps={gridPrefs.mobileColumnSteps}
                  onZoomChange={gridPrefs.setZoom}
                  layout={gridPrefs.layout}
                  onLayoutChange={gridPrefs.setLayout}
                />
              </>
            )}

            {isAlbumOverview && (
              <ActionButton onClick={() => setAlbumModal({ kind: "group-create" })}>
                <FolderPlus size={16} />
                <span>新建分组</span>
              </ActionButton>
            )}
            {isAlbumOverview && (
              <ActionButton variant="primary" onClick={() => setAlbumModal({ kind: "create" })}>
                <Plus size={16} />
                <span>新建相片集</span>
              </ActionButton>
            )}

            {route.view === "albums" && route.album && activeAlbumDetail && (
              <div className="album-header-actions">
                <ActionButton
                  className="album-group-badge"
                  title="移动到分组"
                  onClick={() => setAlbumModal({ kind: "move", albums: [activeAlbumDetail] })}
                >
                  <FolderOpen size={15} />
                  <span>{albumGroups.find((group) => group.id === activeAlbumDetail.groupId)?.name || "未分组"}</span>
                </ActionButton>
                <ActionButton
                  variant="primary"
                  onClick={() => setAlbumModal({ kind: "pick", album: activeAlbumDetail })}
                >
                  <Plus size={15} />
                  <span>添加照片</span>
                </ActionButton>
                <RoundIconButton
                  title="删除相片集"
                  onClick={() => setAlbumModal({ kind: "delete", album: activeAlbumDetail })}
                >
                  <Trash2 size={16} />
                </RoundIconButton>
              </div>
            )}

            {(route.view === "automatic" ||
              route.view === "merged" ||
              route.view === "grouped") && (
              <ActionButton onClick={() => setHistoryKind("split")}>
                <History size={15} />
                <span>分离记录</span>
              </ActionButton>
            )}

            {currentModule.supportsBatchSelection && !isAlbumOverview && assets.length > 0 && (
              <ActionButton
                variant={selecting ? "primary" : "default"}
                onClick={() => {
                  if (selecting) {
                    setSelecting(false);
                    setSelectedIds(new Set());
                  } else {
                    setSelecting(true);
                  }
                }}
              >
                {selecting ? `退出选择 (${selectedIds.size})` : "选择"}
              </ActionButton>
            )}
          </div>
        </header>

        {/* Active Filters Strip */}
        <CollapsibleRegion open={hasAnyFilter && !isAlbumOverview}>
          <ActiveFiltersBar
            query={route.query}
            from={route.from}
            to={route.to}
            chips={activeChips}
            isAlbumOverview={isAlbumOverview}
            onClearSearch={() => {
              setSearchDraft("");
              updateRoute((prev) => ({ ...prev, query: "" }));
            }}
            onClearDates={() => updateRoute((prev) => ({ ...prev, from: "", to: "" }))}
            onClearChip={(keys: FilterParameterKey[]) =>
              updateRoute((prev) => {
                const nextFilters = { ...prev.filters };
                for (const k of keys) nextFilters[k] = "";
                return { ...prev, filters: nextFilters };
              })
            }
            onClearAll={() => {
              setSearchDraft("");
              updateRoute((prev) => ({
                ...prev,
                query: "",
                from: "",
                to: "",
                filters: createEmptyFilters(),
              }));
            }}
          />
        </CollapsibleRegion>

        {/* Collapsible Month Timeline Strip */}
        <CollapsibleRegion
          open={monthRailOpen && months.length > 0 && isGalleryView}
          className="month-filter-region"
        >
          <div
            className="month-scrubber-bar motion-tabs"
            ref={monthIndicator.ref}
            style={monthIndicator.style}
            aria-label="按拍摄月份筛选"
          >
            <button
              type="button"
              className={!route.from && !route.to ? "is-active" : ""}
              onClick={() => updateRoute((prev) => ({ ...prev, from: "", to: "" }))}
            >
              <span>全部时间</span>
            </button>
            {months.map((m) => {
              const bounds = resolveMonthBounds(m.month);
              const isSelected = route.from === bounds.from && route.to === bounds.to;
              return (
                <button
                  type="button"
                  key={m.month}
                  className={isSelected ? "is-active" : ""}
                  onClick={() =>
                    updateRoute((prev) =>
                      isSelected
                        ? { ...prev, from: "", to: "" }
                        : { ...prev, from: bounds.from, to: bounds.to },
                    )
                  }
                >
                  <strong>{m.month}</strong>
                  <small>{m.count}</small>
                </button>
              );
            })}
          </div>
        </CollapsibleRegion>

        {/* Permanent Deletion Progress Banner */}
        {(route.view === "trash" || (telemetry?.pendingDeletions || 0) > 0) && (
          <PurgeStatusBanner
            tracker={purgeTracker}
            hasServerPending={(telemetry?.pendingDeletions || 0) > 0}
          />
        )}

        {/* Main Workspace Body */}
        <main className="aura-content" key={`${route.view}:${route.album}`}>
          {route.view === "jobs" ? (
            <PipelineTaskCenter
              info={telemetry}
              onOpenUploadHub={() => setUploadHubTab("files")}
              onLocateAsset={(id) => void locateAssetInLibrary(id)}
              onCatalogMutated={() => void refreshBoundedCatalog()}
            />
          ) : route.view === "similar" ? (
            <SimilarWorkspaceView
              source={similarSource}
              onSelectSource={setSimilarSource}
              pairs={similarPairs}
              assetsMap={similarAssets}
              counts={similarCounts}
              total={similarTotal}
              scoreRange={dinoScoreRange}
              onSelectScoreRange={setDinoScoreRange}
              error={similarError}
              onRetry={() => {
                const page = similarPageRef.current;
                void fetchSimilarCandidates(page.source, page.cursor, false, page.pageIndex, page.scoreRange);
              }}
              dinoIndex={dinoIndex || telemetry?.similarityIndex}
              pageIndex={dinoPageIdx}
              hasNextPage={!!similarNext}
              loading={similarLoading}
              ignoringKey={ignoringKey}
              lastIgnoredPair={lastIgnoredPair}
              onTurnDinoPage={(delta) => {
                if (similarRequestRef.current || ignoringKey) return;
                const nextIdx = dinoPageIdx + delta;
                if (nextIdx < 0 || (delta > 0 && !similarNext)) return;
                if (delta > 0 && similarNext) {
                  dinoCursorsRef.current[nextIdx] = similarNext;
                }
                void fetchSimilarCandidates("dino", dinoCursorsRef.current[nextIdx] || "", false, nextIdx);
              }}
              onAppendDhash={() => void fetchSimilarCandidates("dhash", similarNext, true)}
              onOpenHistory={() => setHistoryKind("similar")}
              onOpenAsset={(asset) => updateRoute((prev) => ({ ...prev, asset: asset.id }), "push")}
              onComparePair={(left, right) => setComparePair({ left, right })}
              onMergePair={(left, right) => setMergePair({ left, right })}
              onIgnorePair={async (pair) => {
                const key = `${pair.left}:${pair.right}`;
                setIgnoringKey(key);
                try {
                  await requestJson("similar/ignore", {
                    left: pair.left,
                    right: pair.right,
                  });
                  setLastIgnoredPair(pair);
                  setSimilarPairs((prev) =>
                    prev.filter((p) => !(p.left === pair.left && p.right === pair.right)),
                  );
                  await refreshBoundedCatalog();
                } catch (err) {
                  showToast(err instanceof Error ? err.message : String(err), true);
                } finally {
                  setIgnoringKey("");
                }
              }}
              onUndoIgnore={async (pair) => {
                const key = `${pair.left}:${pair.right}`;
                setIgnoringKey(key);
                try {
                  await requestJson(
                    "similar/ignore",
                    { left: pair.left, right: pair.right },
                    "DELETE",
                  );
                  setLastIgnoredPair(null);
                  await refreshBoundedCatalog();
                } catch (err) {
                  showToast(err instanceof Error ? err.message : String(err), true);
                } finally {
                  setIgnoringKey("");
                }
              }}
            />
          ) : isAlbumOverview ? (
            albums.length > 0 || albumGroups.length > 0 ? (
              <AlbumsCollectionGrid
                albums={albums}
                groups={albumGroups}
                onAction={setAlbumModal}
                onUpdated={fetchOverview}
                onNotify={showToast}
                onOpenAlbum={(alb) => {
                  setActiveAlbumDetail(alb);
                  updateRoute((prev) => ({ ...prev, view: "albums", album: alb.id }), "push");
                }}
              />
            ) : (
              <div className="empty-state">
                <div className="empty-icon-ring">
                  <FolderOpen size={30} strokeWidth={1.3} />
                </div>
                <h2>还没有相片集</h2>
                <p>创建相片集按主题或旅程整理照片，同一张照片可归入多个相片集。</p>
                <ActionButton variant="primary" onClick={() => setAlbumModal({ kind: "create" })}>
                  <Plus size={16} />
                  <span>新建相片集</span>
                </ActionButton>
              </div>
            )
          ) : (
            <div {...gridPrefs.timelineProps}>
              {loadError && (
                <div className="inline-alert" role="alert">
                  <span>{loadError}</span>
                  <ActionButton onClick={() => void fetchGalleryPage(nextCursor, !!nextCursor)}>
                    <RefreshCw size={14} />
                    <span>重试</span>
                  </ActionButton>
                </div>
              )}

              {assets.length > 0 ? (
                <div className="catalog-results" aria-busy={loadingPage} inert={loadingPage || (!nextCursor && !!loadError)}>
                  <VirtualizedTimelineCanvas
                    groups={dayGroups}
                    columns={gridPrefs.columns}
                    mobileColumns={gridPrefs.mobileColumns}
                    selectedIds={selectedIds}
                    selecting={selecting}
                    busy={batchBusy}
                    onToggleGroup={toggleSelectDayGroup}
                    onToggleAsset={toggleSelectAsset}
                    onOpenAsset={(item) =>
                      updateRoute((prev) => ({ ...prev, asset: item.id }), "push")
                    }
                  />
                </div>
              ) : loadingPage ? (
                <div {...gridPrefs.skeletonProps}>
                  {Array.from({ length: 21 }).map((_, idx) => (
                    <div key={idx} className="skeleton-tile" />
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon-ring">
                    <Images size={30} strokeWidth={1.3} />
                  </div>
                  <h2>
                    {hasAnyFilter
                      ? "没有符合筛选条件的照片"
                      : route.view === "trash"
                        ? "最近删除为空"
                        : "此处暂无照片"}
                  </h2>
                  {hasAnyFilter ? (
                    <ActionButton
                      onClick={() => {
                        setSearchDraft("");
                        updateRoute((prev) => ({
                          ...prev,
                          query: "",
                          from: "",
                          to: "",
                          filters: createEmptyFilters(),
                        }));
                      }}
                    >
                      清除全部筛选条件
                    </ActionButton>
                  ) : (
                    route.view === "all" && (
                      <ActionButton variant="primary" onClick={() => setUploadHubTab("files")}>
                        <CloudUpload size={16} />
                        <span>导入第一批照片</span>
                      </ActionButton>
                    )
                  )}
                </div>
              )}

              {loadingPage && assets.length > 0 && (
                <div className="loading-inline">
                  <LoaderCircle size={18} className="spin" />
                  <span>{nextCursor ? "正在加载更多照片…" : "正在更新照片…"}</span>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Floating Batch Selection Action Dock */}
        <MotionPresence present={selecting && isGalleryView} variant="dock">
          {selecting && isGalleryView && (
            <div className="selection-action-dock" role="region" aria-label="批量操作栏">
              <div className="dock-summary">
                <strong>
                  已选择{" "}
                  <span className="motion-count" key={selectedIds.size}>
                    {selectedIds.size}
                  </span>{" "}
                  项
                </strong>
                <button type="button" onClick={selectAllLoaded}>
                  全选已加载 ({assets.filter((a) => !a.deletionPending).length})
                </button>
                {selectedIds.size > 0 && (
                  <button type="button" onClick={() => setSelectedIds(new Set())}>
                    清空
                  </button>
                )}
              </div>

              <div className="dock-buttons">
                {selectedIds.size === 2 && (
                  <>
                    <ActionButton
                      disabled={batchBusy}
                      onClick={() => {
                        const [idA, idB] = [...selectedIds];
                        const left = assets.find((a) => a.id === idA);
                        const right = assets.find((a) => a.id === idB);
                        if (left && right) setComparePair({ left, right });
                      }}
                    >
                      <Columns2 size={15} />
                      <span>对比所选</span>
                    </ActionButton>
                    <ActionButton disabled={batchBusy} onClick={() => void batchMergeSelected()}>
                      <Layers3 size={15} />
                      <span>归并为一项</span>
                    </ActionButton>
                  </>
                )}

                {route.view === "trash" ? (
                  <>
                    <ActionButton
                      variant="primary"
                      disabled={batchBusy || !selectedIds.size}
                      onClick={() => void batchSetTrash(false)}
                    >
                      <RotateCcw size={15} />
                      <span>恢复所选</span>
                    </ActionButton>
                    <ActionButton
                      variant="danger"
                      disabled={batchBusy || !selectedIds.size}
                      onClick={() => {
                        const targets = assets.filter((a) => selectedIds.has(a.id));
                        if (targets.length) setPurgeTargets(targets);
                      }}
                    >
                      <Trash2 size={15} />
                      <span>永久删除</span>
                    </ActionButton>
                  </>
                ) : (
                  <>
                    <ActionButton
                      disabled={batchBusy || !selectedIds.size}
                      onClick={() => setAlbumModal({ kind: "add", assets: [...selectedIds] })}
                    >
                      <FolderPlus size={15} />
                      <span>加入相片集</span>
                    </ActionButton>
                    {route.view === "albums" && route.album && (
                      <ActionButton
                        disabled={batchBusy || selectedIds.size !== 1}
                        onClick={() => void setSelectedAlbumCover()}
                      >
                        <Images size={15} />
                        <span>设为相片集封面</span>
                      </ActionButton>
                    )}
                    {route.view === "albums" && route.album && (
                      <ActionButton
                        disabled={batchBusy || !selectedIds.size}
                        onClick={() => void batchRemoveFromCurrentAlbum()}
                      >
                        移出当前相片集
                      </ActionButton>
                    )}
                    <ActionButton
                      variant="danger"
                      disabled={batchBusy || !selectedIds.size}
                      onClick={() => void batchSetTrash(true)}
                    >
                      <Trash2 size={15} />
                      <span>移入最近删除</span>
                    </ActionButton>
                  </>
                )}

                <ActionButton
                  onClick={() => {
                    setSelecting(false);
                    setSelectedIds(new Set());
                  }}
                >
                  取消
                </ActionButton>
              </div>
            </div>
          )}
        </MotionPresence>
      </div>

      {/* Filter Popover Sheet */}
      <MotionPresence present={filterSheetOpen} variant="menu">
        {filterSheetOpen && (
          <FilterSheet
            value={{ ...route.filters, from: route.from, to: route.to }}
            anchorRef={filterBtnRef}
            onClose={() => setFilterSheetOpen(false)}
            onApply={(draft) => {
              const { from, to, ...restFilters } = draft;
              updateRoute(
                (prev) => ({
                  ...prev,
                  from,
                  to,
                  filters: restFilters,
                }),
                "push",
              );
            }}
          />
        )}
      </MotionPresence>

      {/* Lightbox Viewer & Inspector */}
      <MotionPresence present={!!openAssetObj}>
        {openAssetObj && (
          <LightboxStudio
            asset={openAssetObj}
            currentAlbumId={route.view === "albums" ? route.album : undefined}
            neighbors={assets}
            positionIndex={openAssetIndex}
            totalLoaded={assets.length}
            hasMorePages={!!nextCursor}
            onClose={() => {
              if (window.history.state?.auraViewer) {
                window.history.back();
              } else {
                updateRoute((prev) => ({ ...prev, asset: "" }), "replace");
              }
            }}
            onSelectAsset={(target) => {
              setOpenAssetObj(target);
              updateRoute((prev) => ({ ...prev, asset: target.id }), "replace");
            }}
            onUpdateAsset={async (patch) => {
              const updated = await requestJson<CatalogAsset>(
                `assets/${openAssetObj.id}`,
                patch,
                "PATCH",
              );
              if (patch.trash !== undefined) {
                showToast(patch.trash ? "已移入最近删除" : "已恢复到照片库");
                updateRoute((prev) => ({ ...prev, asset: "" }), "replace");
              } else {
                setOpenAssetObj(updated);
              }
              await refreshBoundedCatalog();
            }}
            onRemoveFromAlbum={
              route.view === "albums" && route.album
                ? async () => {
                    await requestJson(
                      `albums/${route.album}/assets`,
                      { assets: [openAssetObj.id] },
                      "DELETE",
                    );
                    showToast("已从当前相片集移除");
                    updateRoute((prev) => ({ ...prev, asset: "" }), "replace");
                    await refreshBoundedCatalog();
                  }
                : undefined
            }
            onOpenAlbumAdd={() => setAlbumModal({ kind: "add", assets: [openAssetObj.id] })}
            onOpenCompare={(left, right) => setComparePair({ left, right })}
            onOpenSplitHistory={() => setHistoryKind("split")}
            onRequestPurge={(target) => setPurgeTargets([target])}
            onCatalogMutated={refreshBoundedCatalog}
            onNotify={showToast}
          />
        )}
      </MotionPresence>

      {/* Photo Comparison Studio */}
      <MotionPresence present={!!comparePair}>
        {comparePair && (
          <PhotoComparisonModal
            left={comparePair.left}
            right={comparePair.right}
            onMergePair={(left, right) => {
              setComparePair(null);
              setMergePair({ left, right });
            }}
            onClose={() => setComparePair(null)}
          />
        )}
      </MotionPresence>

      <MotionPresence present={!!mergePair}>
        {mergePair && (
          <MergePhotosModal left={mergePair.left} right={mergePair.right}
            onClose={() => setMergePair(null)}
            onMerge={async (primary) => {
              setBatchBusy(true);
              try {
                await requestJson(`assets/${mergePair.left.id}/merge`, { other: mergePair.right.id, primary });
                setSelectedIds(new Set());
                setSelecting(false);
                showToast("已归并并保留所选主版本，所有原件均保留");
                await refreshBoundedCatalog();
              } finally {
                setBatchBusy(false);
              }
            }} />
        )}
      </MotionPresence>

      {/* Curation History Modal */}
      <MotionPresence present={!!historyKind}>
        {historyKind && (
          <CurationHistoryModal
            initialKind={historyKind}
            covered={!!comparePair || !!openAssetObj}
            onClose={() => setHistoryKind(null)}
            onCatalogMutated={refreshBoundedCatalog}
            onOpenAsset={(item) => updateRoute((prev) => ({ ...prev, asset: item.id }), "push")}
            onComparePair={(left, right) => setComparePair({ left, right })}
            onNotify={showToast}
          />
        )}
      </MotionPresence>

      {/* Album Operations Modal */}
      <MotionPresence present={!!albumModal}>
        {albumModal && (
          <AlbumActionModal
            state={albumModal}
            groups={albumGroups}
            onClose={() => setAlbumModal(null)}
            onSaved={(savedAlbum) => {
              const kind = albumModal.kind;
              setAlbumModal(null);
              if (kind === "group-create") {
                showToast("分组已创建");
              } else if (kind === "group-rename") {
                showToast("分组已重命名");
              } else if (kind === "group-delete") {
                showToast("分组已删除，相片集已移至未分组");
              } else if (kind === "move") {
                showToast("相片集分组已更新");
              } else if (kind === "delete") {
                showToast("相片集已删除");
                updateRoute((prev) => ({ ...prev, album: "" }), "replace");
              } else if (kind === "create" && savedAlbum) {
                showToast(`已创建“${savedAlbum.name}”`);
                setActiveAlbumDetail(savedAlbum);
                updateRoute((prev) => ({ ...prev, view: "albums", album: savedAlbum.id }), "push");
              } else if (kind === "rename" && savedAlbum) {
                showToast("相片集已重命名");
                setActiveAlbumDetail(savedAlbum);
              } else {
                showToast("相片集已更新");
              }
              void refreshBoundedCatalog();
            }}
          />
        )}
      </MotionPresence>

      {/* Confirm Permanent Deletion Modal */}
      <MotionPresence present={!!purgeTargets}>
        {purgeTargets && (
          <ConfirmPurgeModal
            targets={purgeTargets}
            onClose={() => setPurgeTargets(null)}
            onConfirm={async (ids, confirmation) => {
              const receipt = await requestJson<PurgeRequestReceipt>("assets/purge", {
                ids,
                confirmation,
              });
              purgeTracker.track(receipt.requestId, receipt.accepted, receipt.state);
              setPurgeTargets(null);
              setSelectedIds(new Set());
              setSelecting(false);
              if (openAssetObj && ids.includes(openAssetObj.id)) {
                updateRoute((prev) => ({ ...prev, asset: "" }), "replace");
              }
              showToast(
                receipt.state === "complete"
                  ? "已永久删除所选照片"
                  : "已提交永久删除，正在后台清理原件",
              );
              await refreshBoundedCatalog();
            }}
          />
        )}
      </MotionPresence>

      {/* Import & Continuous Upload Hub */}
      <MotionPresence present={!!uploadHubTab}>
        {uploadHubTab && (
          <ImportHubModal
            activeTab={uploadHubTab}
            onSelectTab={setUploadHubTab}
            onClose={() => setUploadHubTab(null)}
            onLocateAsset={(id) => void locateAssetInLibrary(id)}
            onOpenJobsView={() => {
              setUploadHubTab(null);
              switchWorkspaceModule("jobs");
            }}
          />
        )}
      </MotionPresence>

      {/* Drag & Drop Fullscreen Overlay */}
      <MotionPresence present={dragHover}>
        {dragHover && (
          <div className="drop-fullscreen-overlay">
            <div className="drop-card">
              <CloudUpload size={42} />
              <h2>松开鼠标导入到 Aura</h2>
              <p>原件将通过 SHA-256 完整校验并自动去重</p>
            </div>
          </div>
        )}
      </MotionPresence>

      {/* Toast Notification */}
      <MotionPresence present={!!toast} variant="toast">
        {toast && (
          <div
            className={`aura-toast ${toast.isError ? "is-error" : ""}`}
            role="status"
            aria-live="polite"
          >
            <span>{toast.text}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setToast(null)}>
              <X size={14} />
            </button>
          </div>
        )}
      </MotionPresence>
    </div>
    </CurrentAlbumContext>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuraApplication />
  </React.StrictMode>,
);
