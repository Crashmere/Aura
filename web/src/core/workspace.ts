import { useSyncExternalStore } from "react";
import { buildMediaUrl } from "./client";
import type { CatalogAsset, LibraryTelemetry, WorkspaceViewId } from "./types";

// ============================================================================
// 1. Extensible Workspace Module Registry
// ============================================================================

export interface WorkspaceModuleDescriptor {
  id: WorkspaceViewId;
  title: string;
  subtitle?: string;
  section: "browse" | "curation" | "system";
  supportsSearch: boolean;
  supportsTimelineFilters: boolean;
  supportsBatchSelection: boolean;
  badgeCount?: (info?: LibraryTelemetry, albumCount?: number) => number | undefined;
}

export const WORKSPACE_MODULES: readonly WorkspaceModuleDescriptor[] = [
  {
    id: "all",
    title: "照片库",
    section: "browse",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (info) => info?.total,
  },
  {
    id: "live",
    title: "实况照片",
    section: "browse",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (info) => info?.live,
  },
  {
    id: "videos",
    title: "视频",
    section: "browse",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (info) => info?.videos,
  },
  {
    id: "albums",
    title: "相片集",
    section: "browse",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (_info, albumCount) => albumCount,
  },
  {
    id: "automatic",
    title: "照片版本",
    subtitle: "同一照片的原始与编辑版本，或像素完全一致的原件，会在上传时自动组合。",
    section: "curation",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (info) => info?.automatic,
  },
  {
    id: "merged",
    title: "手动归并",
    subtitle: "这里显示你手动归并的照片，所有原件均可在详情中查看或分离。",
    section: "curation",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (info) => info?.merged,
  },
  {
    id: "grouped",
    title: "多版本照片",
    subtitle: "包含自动组合版本与手动归并的全部多版本照片项目。",
    section: "curation",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (info) => info?.grouped,
  },
  {
    id: "similar",
    title: "相似照片",
    section: "curation",
    supportsSearch: false,
    supportsTimelineFilters: false,
    supportsBatchSelection: false,
  },
  {
    id: "similar-videos",
    title: "相似视频",
    section: "curation",
    supportsSearch: false,
    supportsTimelineFilters: false,
    supportsBatchSelection: false,
  },
  {
    id: "jobs",
    title: "任务中心",
    section: "system",
    supportsSearch: false,
    supportsTimelineFilters: false,
    supportsBatchSelection: false,
    badgeCount: (info) => {
      const n = (info?.queued || 0) + (info?.errors || 0);
      return n > 0 ? n : undefined;
    },
  },
  {
    id: "trash",
    title: "最近删除",
    subtitle: "项目在永久删除前可恢复。永久删除会清理全部原件与对应预览。",
    section: "system",
    supportsSearch: true,
    supportsTimelineFilters: true,
    supportsBatchSelection: true,
    badgeCount: (info) => info?.trash,
  },
] as const;

export const VIEW_TITLES: Record<WorkspaceViewId, string> = Object.fromEntries(
  WORKSPACE_MODULES.map((m) => [m.id, m.title]),
) as Record<WorkspaceViewId, string>;

const VALID_VIEWS = new Set<string>(WORKSPACE_MODULES.map((m) => m.id));

// ============================================================================
// 2. Filter Schema & URL Serialization
// ============================================================================

export const FILTER_PARAMETER_KEYS = [
  "kind",
  "format",
  "orientation",
  "status",
  "location",
  "versions",
  "grouping",
  "albumState",
  "camera",
  "lens",
  "cameraMatch",
  "lensMatch",
  "minSize",
  "maxSize",
  "minMP",
  "maxMP",
  "addedFrom",
  "addedTo",
] as const;

export type FilterParameterKey = (typeof FILTER_PARAMETER_KEYS)[number];
export type LibraryFilterValues = Record<FilterParameterKey, string>;
export type LibraryFilterDraft = LibraryFilterValues & { from: string; to: string };

export function createEmptyFilters(): LibraryFilterValues {
  return Object.fromEntries(FILTER_PARAMETER_KEYS.map((k) => [k, ""])) as LibraryFilterValues;
}

export const FILTER_ENUM_OPTIONS = {
  kind: [
    ["photo", "照片"],
    ["live", "实况照片"],
    ["video", "视频"],
  ],
  format: [
    ["jpeg", "JPEG"],
    ["heic", "HEIC / HEIF"],
    ["png", "PNG"],
    ["gif", "GIF"],
    ["webp", "WebP"],
    ["tiff", "TIFF"],
    ["raw", "RAW"],
    ["avif", "AVIF"],
    ["mov", "MOV"],
    ["mp4", "MP4"],
  ],
  orientation: [
    ["landscape", "横向"],
    ["portrait", "纵向"],
    ["square", "正方形"],
    ["panorama", "宽幅（至少 2:1）"],
  ],
  status: [
    ["ready", "预览已就绪"],
    ["queued", "等待处理"],
    ["processing", "正在处理"],
    ["error", "处理失败"],
  ],
  location: [
    ["with", "有定位"],
    ["without", "无定位"],
  ],
  versions: [
    ["single", "单个照片版本"],
    ["multiple", "多个照片版本"],
  ],
  grouping: [
    ["automatic", "自动组合的照片版本"],
    ["manual", "手动归并"],
  ],
  albumState: [
    ["in", "已加入相片集"],
    ["none", "未加入相片集"],
  ],
} as const;

export function parseFiltersFromQuery(params: URLSearchParams): LibraryFilterValues {
  const out = createEmptyFilters();
  for (const key of FILTER_PARAMETER_KEYS) {
    out[key] = params.get(key) || "";
  }
  return out;
}

export function serializeFilterParams(filters: LibraryFilterValues): Record<string, string> {
  return Object.fromEntries(
    FILTER_PARAMETER_KEYS.filter(
      (key) =>
        filters[key] &&
        (key !== "cameraMatch" || filters.camera || filters.cameraMatch === "missing") &&
        (key !== "lensMatch" || filters.lens || filters.lensMatch === "missing"),
    ).map((key) => [key, filters[key]]),
  );
}

export interface ActiveFilterChip {
  keys: FilterParameterKey[];
  text: string;
}

export function buildActiveFilterChips(filters: LibraryFilterValues): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];

  for (const key of Object.keys(FILTER_ENUM_OPTIONS) as (keyof typeof FILTER_ENUM_OPTIONS)[]) {
    if (!filters[key]) continue;
    const match = FILTER_ENUM_OPTIONS[key].find(([val]) => val === filters[key]);
    chips.push({ keys: [key], text: match?.[1] || filters[key] });
  }

  for (const [key, label] of [
    ["camera", "设备"],
    ["lens", "镜头"],
  ] as const) {
    if (filters[`${key}Match`] === "missing") {
      chips.push({ keys: [key, `${key}Match`], text: `无${label}记录` });
    } else if (filters[key]) {
      chips.push({ keys: [key, `${key}Match`], text: `${label} · ${filters[key]}` });
    }
  }

  for (const [low, high, label, unit, divisor] of [
    ["minSize", "maxSize", "原件", "MB", 1048576],
    ["minMP", "maxMP", "像素", "MP", 1],
  ] as const) {
    if (!filters[low] && !filters[high]) continue;
    const fmt = (raw: string) => String(Number((Number(raw) / divisor).toFixed(2)));
    const text =
      filters[low] && filters[high]
        ? `${fmt(filters[low])}–${fmt(filters[high])}`
        : filters[low]
          ? `≥ ${fmt(filters[low])}`
          : `≤ ${fmt(filters[high])}`;
    chips.push({ keys: [low, high], text: `${label} ${text} ${unit}` });
  }

  if (filters.addedFrom || filters.addedTo) {
    chips.push({
      keys: ["addedFrom", "addedTo"],
      text: `导入 ${filters.addedFrom || "不限"} — ${filters.addedTo || "不限"}`,
    });
  }

  return chips;
}

// ============================================================================
// 3. Browser Location Synchronization
// ============================================================================

export interface WorkspaceRouteState {
  view: WorkspaceViewId;
  album: string;
  query: string;
  from: string;
  to: string;
  asset: string;
  hideAlbums?: boolean;
  filters: LibraryFilterValues;
}

const cleanIsoDate = (raw: string | null): string =>
  raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";

export function readRouteFromWindow(): WorkspaceRouteState {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view") || "all";
  const view: WorkspaceViewId = VALID_VIEWS.has(rawView)
    ? (rawView as WorkspaceViewId)
    : "all";
  const filters = parseFiltersFromQuery(params);
  if (!params.has("albumState") && params.get("unfiled") === "1") {
    filters.albumState = "none";
  }
  return {
    view,
    album: view === "albums" ? params.get("album") || "" : "",
    query: params.get("q") || "",
    from: cleanIsoDate(params.get("from")),
    to: cleanIsoDate(params.get("to")),
    asset: params.get("asset") || "",
    hideAlbums: params.has("unfiled") ? params.get("unfiled") === "1" : undefined,
    filters,
  };
}

export function syncRouteToWindow(state: WorkspaceRouteState, mode: "push" | "replace"): void {
  const params = new URLSearchParams(serializeFilterParams(state.filters));
  if (state.view !== "all") params.set("view", state.view);
  if (state.view === "albums" && state.album) params.set("album", state.album);
  if (state.query) params.set("q", state.query);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);
  if (state.asset) params.set("asset", state.asset);

  const search = params.toString();
  const targetUrl = `/aura/${search ? `?${search}` : ""}`;
  if (window.location.pathname + window.location.search !== targetUrl) {
    if (mode === "push") {
      window.history.pushState(state.asset ? { auraViewer: true } : null, "", targetUrl);
    } else {
      window.history.replaceState(state.asset ? window.history.state : null, "", targetUrl);
    }
  }
}

export function resolveMonthBounds(monthKey: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return { from: "", to: "" };
  const [y, m] = monthKey.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    from: `${monthKey}-01`,
    to: `${monthKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

// ============================================================================
// 4. Network-Aware Media Policy & Bounded Preview Preloader
// ============================================================================

export type NetworkMediaMode = "auto" | "save" | "quality";
type BrowserConnectionInfo = EventTarget & {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
};

const navConnection = (navigator as Navigator & { connection?: BrowserConnectionInfo }).connection;
const policyListeners = new Set<() => void>();
let activeMediaMode: NetworkMediaMode = "auto";

try {
  const savedMode = localStorage.getItem("aura-media-mode");
  if (savedMode === "save" || savedMode === "quality") {
    activeMediaMode = savedMode;
  }
} catch {
  /* Storage is optional */
}

const notifyPolicyListeners = () => policyListeners.forEach((fn) => fn());
navConnection?.addEventListener("change", notifyPolicyListeners);
window.addEventListener("online", notifyPolicyListeners);
window.addEventListener("offline", notifyPolicyListeners);
window.addEventListener("storage", (e) => {
  if (e.key !== "aura-media-mode") return;
  activeMediaMode =
    e.newValue === "save" || e.newValue === "quality" ? e.newValue : "auto";
  notifyPolicyListeners();
});

function getPolicySnapshotKey(): string {
  return `${activeMediaMode}:${navigator.onLine}:${!!navConnection?.saveData}:${navConnection?.effectiveType || ""}:${navConnection?.downlink ?? ""}`;
}

function subscribePolicy(cb: () => void): () => void {
  policyListeners.add(cb);
  return () => {
    policyListeners.delete(cb);
  };
}

export function evaluateMediaPolicy() {
  const slowOrConstrained =
    !!navConnection?.saveData ||
    /(^|-)2g$|3g/.test(navConnection?.effectiveType || "") ||
    (navConnection?.downlink !== undefined && navConnection.downlink < 1.5);

  return {
    mode: activeMediaMode,
    economy:
      activeMediaMode === "save" ||
      (activeMediaMode === "auto" &&
        (!!navConnection?.saveData || /(^|-)2g$/.test(navConnection?.effectiveType || ""))),
    prefetch: navigator.onLine && activeMediaMode !== "save" && !slowOrConstrained,
  };
}

export function updateMediaMode(next: NetworkMediaMode): void {
  activeMediaMode = next;
  try {
    localStorage.setItem("aura-media-mode", next);
  } catch {
    /* Optional preference */
  }
  notifyPolicyListeners();
}

export function useNetworkMediaPolicy() {
  useSyncExternalStore(subscribePolicy, getPolicySnapshotKey);
  return evaluateMediaPolicy();
}

const decodedPreviewCache = new Map<string, HTMLImageElement>();
let preloadEpoch = 0;
let activePreloadImage: HTMLImageElement | undefined;
let preloadTimer: ReturnType<typeof setTimeout> | undefined;

export function cacheDecodedPreview(img: HTMLImageElement): void {
  if (!img.complete || !img.naturalWidth) return;
  const normalized = new URL(img.src, window.location.href);
  normalized.searchParams.delete("retry");
  decodedPreviewCache.delete(normalized.href);
  decodedPreviewCache.set(normalized.href, img);
  while (decodedPreviewCache.size > 3) {
    const oldest = decodedPreviewCache.keys().next().value;
    if (oldest) decodedPreviewCache.delete(oldest);
  }
}

export function readCachedPreviewUrl(url: string): string | undefined {
  const normalized = new URL(url, window.location.href);
  normalized.searchParams.delete("retry");
  return decodedPreviewCache.get(normalized.href)?.src;
}

export function isPreviewCached(url: string): boolean {
  return !!readCachedPreviewUrl(url);
}

export function abortSpeculativePreloads(): void {
  ++preloadEpoch;
  clearTimeout(preloadTimer);
  if (activePreloadImage) {
    activePreloadImage.onload = null;
    activePreloadImage.onerror = null;
    activePreloadImage.removeAttribute("src");
    activePreloadImage = undefined;
  }
}

export function schedulePreviewWarmup(candidates: CatalogAsset[], delayMs = 220): void {
  abortSpeculativePreloads();
  if (!evaluateMediaPolicy().prefetch || document.hidden) return;
  const epoch = preloadEpoch;
  const queue = [
    ...new Set(
      candidates
        .filter((a) => a.kind !== "video" && a.status === "ready" && !a.deletionPending)
        .map((a) => buildMediaUrl(a.primary, "preview", a.rotation, a.cover?.revision)),
    ),
  ]
    .filter((u) => !isPreviewCached(u))
    .slice(0, 2);

  function loadNext() {
    if (epoch !== preloadEpoch || !evaluateMediaPolicy().prefetch || document.hidden) return;
    const nextUrl = queue.shift();
    if (!nextUrl) return;
    const img = new Image();
    activePreloadImage = img;
    img.decoding = "async";
    img.fetchPriority = "low";
    img.onload = async () => {
      try {
        await img.decode();
      } catch {
        /* Already decoded */
      }
      if (epoch !== preloadEpoch) return;
      cacheDecodedPreview(img);
      activePreloadImage = undefined;
      loadNext();
    };
    img.onerror = () => {
      if (epoch === preloadEpoch) {
        activePreloadImage = undefined;
        loadNext();
      }
    };
    img.src = nextUrl;
  }

  preloadTimer = setTimeout(loadNext, delayMs);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    abortSpeculativePreloads();
    decodedPreviewCache.clear();
  }
});

subscribePolicy(() => {
  if (!evaluateMediaPolicy().prefetch) {
    abortSpeculativePreloads();
  }
});
