import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleCheck,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CloudUpload,
  Copy,
  FolderOpen,
  Grid2X2,
  Images,
  ImagePlus,
  Pencil,
  Minus,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
  Video,
  X,
  CalendarDays,
  Monitor,
  ExternalLink,
  ListChecks,
} from "lucide-react";
import {
  api,
  Asset,
  Album,
  Detail,
  Original,
  Info,
  base,
  bytes,
  displayDate,
  Page,
  SimilarPair,
  Timeline,
  ApiError,
  PurgeResponse,
} from "./api";
import * as uploads from "./upload";
import { Photo } from "./photo";
import { LivePhotoIcon } from "./live-photo-icon";
import { AlbumDialog, AlbumDialogState, AlbumGrid } from "./albums";
import { readLocation, writeLocation, monthRange } from "./library-location";
import { TaskCenter } from "./task-center";
import { Viewer } from "./viewer";
import { Button, IconButton } from "./controls";
import { DeletionProgress, PermanentDeleteDialog, useDeletionOperations } from "./permanent-delete";
import "./style.css";

document.addEventListener(
  "keydown",
  (e) => {
    if (
      e.key === "Tab" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.isComposing
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);
const titles: Record<string, string> = {
  all: "照片库",
  albums: "相片集",
  live: "实况照片",
  videos: "视频",
  grouped: "已归并",
  similar: "相似照片",
  trash: "最近删除",
  jobs: "任务中心",
};
function Brand() {
  return (
    <a className="brand" href="/aura/">
      <img src={`${base}favicon.svg`} alt="" />
      <span>Aura</span>
    </a>
  );
}
function App() {
  const [initial] = useState(readLocation);
  const urlMode = useRef<"push" | "replace">("replace");
  const [view, setView] = useState(initial.view),
    [info, setInfo] = useState<Info>(),
    [items, setItems] = useState<Asset[]>([]),
    [next, setNext] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [albums, setAlbums] = useState<Album[]>([]),
    [albumId, setAlbumId] = useState(initial.album),
    [albumDialog, setAlbumDialog] = useState<AlbumDialogState | null>(null),
    [removing, setRemoving] = useState(false);
  const album = albums.find((a) => a.id === albumId);
  const albumGallery = view === "albums" && !albumId;
  const specialView = view === "similar" || view === "jobs";
  const pageTitle =
    view === "albums" && albumId ? album?.name || "相片集" : titles[view];
  const [search, setSearch] = useState(initial.query),
    [query, setQuery] = useState(initial.query),
    [from, setFrom] = useState(initial.from),
    [to, setTo] = useState(initial.to),
    [filters, setFilters] = useState(false),
    [density, setDensity] = useState(() => {
      try {
        const saved = Number(localStorage.getItem("aura-grid-density"));
        return saved >= 3 && saved <= 7 ? saved : 4;
      } catch { return 4; }
    });
  const [hideAlbumAssets, setHideAlbumAssets] = useState(() => {
    if (initial.hideAlbums !== undefined) return initial.hideAlbums;
    try {
      return localStorage.getItem("aura-hide-album-assets") === "true";
    } catch {
      return false;
    }
  });
  const excludeAlbums = view === "all" && hideAlbumAssets;
  const [uploadOpen, setUploadOpen] = useState(false),
    [uploadTab, setUploadTab] = useState("files"),
    [viewer, setViewerState] = useState<Asset | null>(null),
    [viewerId, setViewerId] = useState(initial.asset),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [toast, setToast] = useState(""),
    [toastError, setToastError] = useState(false),
    [help, setHelp] = useState(false),
    [mobileMenu, setMobileMenu] = useState(false);
  const [similar, setSimilar] = useState<SimilarPair[]>([]),
    [similarNext, setSimilarNext] = useState(""),
    [ignoredPair, setIgnoredPair] = useState<SimilarPair | null>(null),
    [ignoring, setIgnoring] = useState(""),
    [similarAssets, setSimilarAssets] = useState<Record<string, Asset>>({});
  const [months, setMonths] = useState<Timeline["months"]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const selectionAnchor = useRef("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [composingSearch, setComposingSearch] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [deletionTargets, setDeletionTargets] = useState<Asset[] | null>(null);
  const mutationLock = useRef(false);
  const uploading = useSyncExternalStore(uploads.subscribe, uploads.snapshot);
  const refreshRef = useRef<(reconcile?: boolean) => Promise<void>>(() => Promise.resolve());
  const queryKey = useRef(0);
  const queryLoading = useRef(false);
  const failedLoad = useRef<"append" | "refresh">("refresh");
  const viewerKey = useRef(viewerId);
  viewerKey.current = viewerId;
  const more = useRef<HTMLDivElement>(null);
  const permanentDeleteEnabled = info?.capabilities?.permanentDelete === true;
  const deletions = useDeletionOperations(permanentDeleteEnabled, () => { void refreshRef.current(true); }, operation => {
    if (operation.ids.includes(viewerKey.current)) setViewer(null);
    uploads.markDeleted(operation.ids);
    notify(`永久删除已完成${operation.ids.length ? ` · ${operation.ids.length} 项` : ""}`);
  }, info?.pendingDeletions);
  function setViewer(asset: Asset | null) {
    if (asset && !viewerKey.current) urlMode.current = "push";
    setViewerState(asset);
    setViewerId(asset?.id || "");
  }
  function closeViewer() {
    if (history.state?.auraViewer) history.back();
    else setViewer(null);
  }
  useEffect(() => {
    writeLocation({ view, album: albumId, query, from, to, asset: viewerId, hideAlbums: hideAlbumAssets }, urlMode.current);
    urlMode.current = "replace";
  }, [view, albumId, query, from, to, viewerId, hideAlbumAssets]);
  useEffect(() => {
    const change = () => {
      const state = readLocation();
      setView(state.view);
      setAlbumId(state.album);
      setSearch(state.query);
      setQuery(state.query);
      setFrom(state.from);
      setTo(state.to);
      setViewerState(null);
      setViewerId(state.asset);
      if (state.hideAlbums !== undefined) setHideAlbumAssets(state.hideAlbums);
      setSelected(new Set());
      setSelectionMode(false);
      selectionAnchor.current = "";
      setUploadOpen(false);
      setAlbumDialog(null);
      setDeletionTargets(null);
      setActionError("");
    };
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useEffect(() => {
    if (!viewerId) { setViewerState(null); return; }
    if (viewer?.id === viewerId) return;
    let active = true;
    api<Detail>(`assets/${viewerId}`).then(detail => {
      if (active) setViewerState(detail.asset);
    }).catch(e => {
      if (active) { setViewerId(""); notify(e instanceof Error ? e.message : String(e), true); }
    });
    return () => { active = false; };
  }, [viewerId]);
  useEffect(() => {
    try {
      localStorage.setItem("aura-hide-album-assets", String(hideAlbumAssets));
    } catch {
      // Browsing still works when storage is unavailable.
    }
  }, [hideAlbumAssets]);
  useEffect(() => {
    if (composingSearch) return;
    const id = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(id);
  }, [search, composingSearch]);
  const overlayOpen = !!viewer || uploadOpen || help || !!albumDialog || !!deletionTargets || mobileMenu;
  useEffect(() => {
    if (!overlayOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [overlayOpen]);
  useEffect(() => {
    try { localStorage.setItem("aura-grid-density", String(density)); } catch { /* Optional preference. */ }
  }, [density]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const notify = (text: string, failed = false) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    setToastError(failed);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };
  const params = (cursor = "") =>
    new URLSearchParams({
      view,
      q: query,
      from,
      to,
      ...(view === "albums" && albumId ? { album: albumId } : {}),
      ...(excludeAlbums ? { excludeAlbums: "true" } : {}),
      ...(cursor ? { cursor } : {}),
    }).toString();
  async function load(append = false, reconcile = false, preserveRange = false) {
    if (append && queryLoading.current) return;
    const key = ++queryKey.current;
    queryLoading.current = true;
    setLoading(true);
    setError("");
    try {
      const targetCount = preserveRange ? items.length : 0;
      const readPage = async () => {
        const data = await api<Page<Asset>>("assets?" + params(append ? next : ""));
        // Refresh the visible range so processing updates do not discard later pages.
        while (!append && data.next && data.items.length < targetCount) {
          if (key !== queryKey.current) return data;
          const page = await api<Page<Asset>>("assets?" + params(data.next));
          data.items.push(...page.items.filter(a => !data.items.some(b => b.id === a.id)));
          if (page.next === data.next) break;
          data.next = page.next;
        }
        return data;
      };
      const [data, stats, collections, timeline] = await Promise.all([
        albumGallery || view === "jobs"
          ? Promise.resolve({ items: [] as Asset[], next: "" })
          : readPage(),
        api<Info>("info"),
        api<Album[]>("albums"),
        albumGallery || specialView ? Promise.resolve({ months: [] } as Timeline) : api<Timeline>("timeline?" + new URLSearchParams({ view, q: query, ...(view === "albums" && albumId ? { album: albumId } : {}), ...(excludeAlbums ? { excludeAlbums: "true" } : {}) })),
      ]);
      if (key !== queryKey.current) return;
      setItems((old) =>
        append
          ? [
              ...old,
              ...data.items.filter((a) => !old.some((b) => a.id === b.id)),
            ]
          : data.items,
      );
      setNext(data.next);
      setInfo(stats);
      setAlbums(collections);
      setMonths(timeline.months);
      if (reconcile) setSelected(old => new Set([...old].filter(id => data.items.some(asset => asset.id === id && !asset.deletionPending))));
    } catch (e) {
      if (key === queryKey.current) {
        failedLoad.current = append ? "append" : "refresh";
        setError(String(e instanceof Error ? e.message : e));
      }
    } finally {
      if (key === queryKey.current) { queryLoading.current = false; setLoading(false); }
    }
  }
  function retryLoad() {
    if (view === "similar") void loadSimilar();
    else if (failedLoad.current === "append") void load(true);
    else void load(false, true, true);
  }
  async function loadSimilar(append = false) {
    const key = ++queryKey.current;
    queryLoading.current = true;
    setLoading(true);
    setError("");
    setMonths([]);
    try {
      const data = await api<Page<SimilarPair>>("similar?" + new URLSearchParams({ paged: "true", limit: "50", ...(append && similarNext ? { cursor: similarNext } : {}) }));
      if (key !== queryKey.current) return;
      const pairs = data.items;
      setSimilar(old => append ? [...old, ...pairs.filter(pair => !old.some(previous => previous.left === pair.left && previous.right === pair.right))] : pairs);
      setSimilarNext(data.next);
      const ids = [...new Set(pairs.flatMap((p) => [p.left, p.right]))];
      const assets: Record<string, Asset> = {};
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(
          ids.slice(i, i + 8).map(async (id) => {
            try {
              const d = await api<Detail>("assets/" + id);
              assets[id] = d.asset;
            } catch {
              /* A concurrent merge can remove a candidate. */
            }
          }),
        );
      }
      if (key !== queryKey.current) return;
      setSimilarAssets(old => append ? { ...old, ...assets } : assets);
      const stats = await api<Info>("info");
      if (key === queryKey.current) setInfo(stats);
    } catch (e) {
      if (key === queryKey.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (key === queryKey.current) { queryLoading.current = false; setLoading(false); }
    }
  }
  useEffect(() => {
    ++queryKey.current;
    setItems([]);
    setNext("");
    setSelected(new Set());
    setSelectionMode(false);
    selectionAnchor.current = "";
    setActionError("");
    if (view === "similar") { setSimilar([]); setSimilarNext(""); setIgnoredPair(null); void loadSimilar(); }
    else void load();
  }, [view, albumId, albumGallery ? "" : query, from, to, excludeAlbums]);
  refreshRef.current = async (reconcile = false) => {
    if (view === "similar") await loadSimilar();
    else await load(false, true, true);
  };
  useEffect(() => {
    const fn = () => refreshRef.current();
    window.addEventListener("aura-library-changed", fn);
    return () => window.removeEventListener("aura-library-changed", fn);
  }, []);
  useEffect(() => {
    if (error || (!info?.queued && !info?.pendingDeletions && !uploading.running)) return;
    const timer = setInterval(() => { if (!queryLoading.current) void refreshRef.current(); }, 4000);
    return () => clearInterval(timer);
  }, [info?.queued, info?.pendingDeletions, uploading.running, error]);
  useEffect(() => {
    if (!next || loading || error || view === "similar") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void load(true);
      },
      { rootMargin: "500px" },
    );
    if (more.current) observer.observe(more.current);
    return () => observer.disconnect();
  }, [next, loading, view, error]);
  useEffect(() => {
    if (!viewerId || !next || loading || error || specialView) return;
    const index = items.findIndex(a => a.id === viewerId);
    if (index >= 0 && index >= items.length - 3) void load(true);
  }, [viewerId, items.length, next, loading, error, specialView]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const editing = (e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]");
      if (!overlayOpen && !editing && !e.altKey) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && (selectionMode || selected.size > 0)) {
          e.preventDefault();
          if (!mutationLock.current) setSelected(new Set(items.filter(a => !a.deletionPending).map(a => a.id)));
        }
        if (!e.metaKey && !e.ctrlKey && e.key === "/") {
          e.preventDefault();
          searchInput.current?.focus();
        }
      }
      if (e.key === "Escape") {
        if (albumDialog || deletionTargets || viewer || mutationLock.current) {
          // Dialogs and viewers own Escape and their mutation locks.
          return;
        }
        setViewer(null);
        setUploadOpen(false);
        setHelp(false);
        setMobileMenu(false);
        setSelected(new Set());
        setSelectionMode(false);
        setFilters(false);
        setDragging(false);
        dragDepth.current = 0;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [albumDialog, deletionTargets, viewer, overlayOpen, selectionMode, selected.size, items]);
  const groups = useMemo(() => {
    const result: { date: string; items: Asset[] }[] = [];
    for (const asset of items) {
      const day = asset.capturedAt.slice(0, 10);
      const last = result.at(-1);
      if (last?.date === day) last.items.push(asset);
      else result.push({ date: day, items: [asset] });
    }
    return result;
  }, [items]);
  async function action(trash: boolean) {
    if (mutationLock.current || !selected.size) return;
    const ids = [...selected];
    if (ids.length > 1000) { setActionError("每次最多操作 1000 项，请减少选择"); return; }
    mutationLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      const result = await api<{ updated: string[] }>("assets", { ids, trash }, "PATCH");
      setSelected(old => new Set([...old].filter(id => !result.updated.includes(id))));
      notify(trash ? `已移入最近删除 · ${result.updated.length} 项` : `已恢复 · ${result.updated.length} 项`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.requestId) deletions.track(e.requestId);
    } finally {
      await refreshRef.current(true);
      mutationLock.current = false;
      setActionBusy(false);
    }
  }
  function openPermanentDelete(targets: Asset[]) {
    if (mutationLock.current || !permanentDeleteEnabled) return;
    if (!targets.length || targets.length > 1000 || targets.some(asset => !asset.trashedAt || asset.deletionPending)) {
      setActionError("请选择 1-1000 项尚未开始永久删除的最近删除照片");
      return;
    }
    setDeletionTargets(targets.map(asset => ({ ...asset })));
  }
  function deleteSelected() {
    const targets = items.filter(asset => selected.has(asset.id));
    if (targets.length !== selected.size) {
      setActionError("部分已选照片状态发生变化，请刷新后重新选择");
      void refreshRef.current(true);
      return;
    }
    openPermanentDelete(targets);
  }
  async function permanentDelete(ids: string[], confirmation: string) {
    if (mutationLock.current) throw new Error("正在处理上一项操作");
    mutationLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      const result = await api<PurgeResponse>("assets/purge", { ids, confirmation });
      deletions.track(result.requestId, result.accepted, result.state);
      setDeletionTargets(null);
      setSelected(old => new Set([...old].filter(id => !result.accepted.includes(id))));
      if (result.accepted.includes(viewerKey.current)) setViewer(null);
      if (result.state === "pending") notify("已确认，正在永久删除；清理完成后会更新状态");
    } catch (error) {
      if (error instanceof ApiError && error.requestId) deletions.track(error.requestId);
      throw error;
    } finally {
      await refreshRef.current(true);
      mutationLock.current = false;
      setActionBusy(false);
    }
  }
  const selecting = selectionMode || selected.size > 0;
  function clearSelection() {
    if (mutationLock.current) return;
    setSelected(new Set());
    setSelectionMode(false);
    selectionAnchor.current = "";
  }
  function toggle(id: string, range = false) {
    if (mutationLock.current || items.find(asset => asset.id === id)?.deletionPending) return;
    const start = items.findIndex(a => a.id === selectionAnchor.current);
    const end = items.findIndex(a => a.id === id);
    setSelectionMode(true);
    setSelected(current => {
      const result = new Set(current);
      if (range && start >= 0 && end >= 0) {
        for (const asset of items.slice(Math.min(start, end), Math.max(start, end) + 1)) {
          if (!asset.deletionPending) result.add(asset.id);
        }
      } else if (result.has(id)) result.delete(id);
      else result.add(id);
      return result;
    });
    selectionAnchor.current = id;
  }
  function toggleGroup(assets: Asset[]) {
    if (mutationLock.current) return;
    const ids = assets.filter(a => !a.deletionPending).map(a => a.id);
    setSelectionMode(true);
    setSelected(current => {
      const result = new Set(current);
      const all = ids.every(id => current.has(id));
      for (const id of ids) { if (all) result.delete(id); else result.add(id); }
      return result;
    });
  }
  function clearFilters() { setSearch(""); setQuery(""); setFrom(""); setTo(""); }
  function navigate(id: string) {
    urlMode.current = "push";
    setViewer(null);
    setAlbumId("");
    setView(id);
    clearFilters();
    setFilters(false);
    clearSelection();
    window.scrollTo({ top: 0 });
  }
  function openAlbum(id: string) {
    urlMode.current = "push";
    setSearch(""); setQuery(""); setFrom(""); setTo("");
    setView("albums");
    setAlbumId(id);
    window.scrollTo({ top: 0 });
  }
  async function locateAsset(id: string) {
    try {
      const detail = await api<Detail>(`assets/${id}`);
      urlMode.current = "push";
      setView(detail.asset.trashedAt ? "trash" : "all");
      setAlbumId("");
      setSearch(""); setQuery(""); setFrom(""); setTo("");
      setUploadOpen(false);
      setViewer(detail.asset);
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  }
  async function ignore(pair: SimilarPair, undo = false) {
    if (ignoring) return;
    setIgnoring(pair.left + pair.right);
    try {
      await api("similar/ignore", { left: pair.left, right: pair.right }, undo ? "DELETE" : "POST");
      if (undo) { setIgnoredPair(null); await loadSimilar(); }
      else { setSimilar(old => old.filter(candidate => candidate.left !== pair.left || candidate.right !== pair.right)); setIgnoredPair(pair); }
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
    finally { setIgnoring(""); }
  }
  function addSelected() {
    if (selected.size > 1000) {
      notify("每次最多添加 1000 项，请减少选择");
      return;
    }
    setAlbumDialog({ kind: "add", assets: [...selected] });
  }
  async function removeSelected() {
    if (mutationLock.current || removing || !albumId) return;
    if (selected.size > 1000) {
      notify("每次最多移除 1000 项，请减少选择");
      return;
    }
    setRemoving(true);
    mutationLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      await api(
        `albums/${albumId}/assets`,
        { assets: [...selected] },
        "DELETE",
      );
      const removed = new Set(selected);
      setSelected(old => new Set([...old].filter(id => !removed.has(id))));
      notify("已从相片集移除，照片仍在照片库中");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      await refreshRef.current(true);
      setRemoving(false);
      setActionBusy(false);
      mutationLock.current = false;
    }
  }
  const completed = uploading.items.filter((i) =>
    ["done", "duplicate", "trashed", "skipped"].includes(i.state),
  ).length;
  const month = from.slice(0, 7);
  const range = monthRange(month);
  const selectedMonth = from === range.from && to === range.to ? month : from || to ? "custom" : "";
  return (
    <div
      className={`app ${selecting ? "is-selecting" : ""}`}
      onDragEnter={e => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        if (!viewer && !albumDialog && !deletionTargets && !help) setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragEnd={() => { dragDepth.current = 0; setDragging(false); }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          if (viewer || albumDialog || deletionTargets || help) return;
          setUploadTab("files");
          uploads.addFiles(Array.from(e.dataTransfer.files));
          setUploadOpen(true);
        }
      }}
    >
      <aside className="sidebar">
        <Brand />
        <nav className="navigation" aria-label="照片库导航">
          {(
            [
              ["all", Grid2X2, "total"],
              ["live", LivePhotoIcon, "live"],
              ["videos", Video, "videos"],
            ] as const
          ).map(([id, Icon, count]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{titles[id]}</span>
              {!!info?.[count] && <small>{info[count]}</small>}
            </button>
          ))}
          <button
            className={view === "albums" ? "active" : ""}
            aria-current={view === "albums" ? "page" : undefined}
            onClick={() => navigate("albums")}
          >
            <Images size={19} />
            <span>相片集</span>
            {albums.length > 0 && <small>{albums.length}</small>}
          </button>
          <div className="nav-label">整理</div>
          {(
            [
              ["grouped", Layers3],
              ["similar", Copy],
              ["trash", Trash2],
              ["jobs", ListChecks],
            ] as const
          ).map(([id, Icon]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              <span>{titles[id]}</span>
              {id === "grouped" && !!info?.grouped && (
                <small>{info.grouped}</small>
              )}
              {id === "jobs" && !!(info?.queued || info?.errors) && <small>{(info?.queued || 0) + (info?.errors || 0)}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {uploading.items.length > 0 || info?.queued ? (
            <button
              className="transfer-mini"
              onClick={() => setUploadOpen(true)}
            >
              <span className="transfer-icon">
                {uploading.running || info?.queued ? (
                  <LoaderCircle className="spin" size={19} />
                ) : (
                  <CheckCheck size={19} />
                )}
              </span>
              <div>
                <strong>
                  {uploading.running
                    ? "正在上传"
                    : info?.queued
                      ? "正在整理"
                      : "上传记录"}
                </strong>
                <small>
                  {uploading.items.length
                    ? `${completed} / ${uploading.items.length} 个文件`
                    : `${info?.queued} 个文件`}
                </small>
              </div>
              <ChevronRight size={15} />
            </button>
          ) : null}
          <div className="library-size">
            <span className="status-dot" />
            <span>
              {info
                ? `${info.originals.toLocaleString()} 份原件 · ${bytes(info.bytes)}`
                : "正在连接"}
            </span>
          </div>
          <div className="sidebar-links">
            <a href="/portal/">
              <ArrowLeft size={14} />
              门户
            </a>
            <button onClick={() => setHelp(true)} aria-label="关于 Aura">
              <CircleHelp size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <span className="desktop-breadcrumb">
            个人照片库 <span>/</span> {pageTitle}
          </span>
          <div className="top-actions">
            {!specialView && <div className="search">
              <Search size={17} />
              <input
                ref={searchInput}
                type="search"
                aria-label={albumGallery ? "搜索相片集" : "搜索照片"}
                placeholder={albumGallery ? "搜索相片集…" : "搜索文件名、相机…"}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onCompositionStart={() => setComposingSearch(true)}
                onCompositionEnd={() => setComposingSearch(false)}
              />
              {search && (
                <button onClick={() => setSearch("")} aria-label="清空搜索">
                  <X size={14} />
                </button>
              )}
            </div>}
            <Button
              className="primary upload-trigger"
              title="上传照片"
              onClick={() => {
                setUploadTab("files");
                setUploadOpen(true);
              }}
            >
              <Plus size={18} />
              <span>上传</span>
            </Button>
          </div>
        </header>
        <div className="page">
          {view === "albums" && albumId && (
            <button className="album-back" onClick={() => { urlMode.current = "push"; clearFilters(); setAlbumId(""); clearSelection(); }}>
              <ArrowLeft size={16} />
              全部相片集
            </button>
          )}
          <div className="page-heading">
            <div>
              <h1>
                {pageTitle}
                {view === "albums" && (
                  <span className="heading-count">
                    {albumId ? album?.count || 0 : albums.length}
                  </span>
                )}
                {view === "all" && info ? (
                  <span className="heading-count" title="照片库总数">
                    {info.total.toLocaleString()}
                  </span>
                ) : null}
              </h1>
            </div>
            <div className="heading-actions">
              {view === "albums" &&
                (albumGallery ? (
                  <Button
                    className="primary"
                    onClick={() => setAlbumDialog({ kind: "create" })}
                  >
                    <Plus size={17} />
                    新建相片集
                  </Button>
                ) : (
                  album && (
                    <>
                      <Button
                        className="primary"
                        onClick={() => setAlbumDialog({ kind: "pick", album })}
                      >
                        <ImagePlus size={17} />
                        添加照片
                      </Button>
                      <IconButton
                        title="重命名相片集"
                        onClick={() =>
                          setAlbumDialog({ kind: "rename", album })
                        }
                      >
                        <Pencil size={17} />
                      </IconButton>
                      <IconButton
                        title="删除相片集"
                        onClick={() =>
                          setAlbumDialog({ kind: "delete", album })
                        }
                      >
                        <Trash2 size={17} />
                      </IconButton>
                    </>
                  )
                ))}
              {!albumGallery && !specialView && (
                <Button className={selecting ? "selection-toggle is-active" : "selection-toggle"} disabled={actionBusy || !items.length} onClick={() => selecting ? clearSelection() : setSelectionMode(true)}>
                  {selecting ? <Check size={16} /> : <CircleCheck size={16} />}
                  {selecting ? "完成选择" : "选择"}
                </Button>
              )}
            </div>
          </div>
          <DeletionProgress state={deletions} otherPending={!!info?.pendingDeletions} />
          {!albumGallery && !specialView && (
            <div className="library-toolbar">
            <div className="timeline-jump">
              <CalendarDays size={16} />
              <label>按月浏览<select aria-label="按月浏览" value={selectedMonth} onChange={event => {
                if (event.target.value === "custom") return;
                const next = monthRange(event.target.value);
                setFrom(next.from); setTo(next.to);
              }}>
                <option value="">全部日期</option>
                {selectedMonth === "custom" && <option value="custom" disabled>自定义日期范围</option>}
                {selectedMonth && selectedMonth !== "custom" && !months.some(item => item.month === selectedMonth) && <option value={selectedMonth}>{selectedMonth} · 0项</option>}
                {[...new Set(months.map(item => item.month.slice(0, 4)))].map(year => <optgroup label={`${year}年`} key={year}>{months.filter(item => item.month.startsWith(year)).map(item => <option value={item.month} key={item.month}>{Number(item.month.slice(5))}月 · {item.count}项</option>)}</optgroup>)}
              </select></label>
            </div>
            <button className={`filter-toggle ${filters || from || to ? "is-active" : ""}`} aria-expanded={filters} aria-controls="date-filters" onClick={() => setFilters(!filters)}>
              <SlidersHorizontal size={16} />筛选{(from || to) && <span className="filter-dot" />}
            </button>
              {view === "all" && (
                <button
                  className="album-filter-toggle"
                  type="button"
                  role="switch"
                  aria-checked={hideAlbumAssets}
                  title="隐藏已加入任意相片集的照片"
                  onClick={() => setHideAlbumAssets(!hideAlbumAssets)}
                >
                  <span>隐藏已入相片集</span>
                  <span className="switch-track" aria-hidden="true" />
                </button>
              )}
            <div className="density-control">
              <button className="icon-button density-cycle" title="切换缩略图大小" aria-label="切换缩略图大小" onClick={() => setDensity(density >= 5 ? 3 : density + 1)}><Grid2X2 size={17} /></button>
              <input type="range" aria-label="缩略图大小" min="3" max="7" value={density} onChange={e => setDensity(+e.target.value)} />
            </div>
            </div>
          )}
          {(query || from || to) && !specialView && (
            <div className="active-filters" aria-label="当前筛选条件">
              {query && <button onClick={() => { setSearch(""); setQuery(""); }} aria-label="清除搜索条件"><Search size={13} /><span>{query}</span><X size={13} /></button>}
              {(from || to) && !albumGallery && <button onClick={() => { setFrom(""); setTo(""); }} aria-label="清除日期条件"><CalendarDays size={13} /><span>{from || "不限"} — {to || "不限"}</span><X size={13} /></button>}
              <button className="clear-filters" onClick={clearFilters}>清除筛选</button>
            </div>
          )}
          {filters && !albumGallery && !specialView && (
            <div className="date-filters" id="date-filters">
              <label>
                拍摄日期
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <span>至</span>
              <input
                aria-label="结束日期"
                type="date"
                min={from || undefined}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              {(from || to) && (
                <Button
                  className="subtle"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                  }}
                >
                  清除
                </Button>
              )}
            </div>
          )}
          {view === "grouped" && (
            <p className="view-note">
              相同照片只展示一个主版本，所有原件与来源信息均可在详情中查看。
            </p>
          )}
          {view === "trash" && (
            <p className="view-note">
              项目在永久删除前可恢复。永久删除会清理全部原件与对应预览。
            </p>
          )}
          {selecting && !albumGallery && !specialView && (
            <div className="selection-bar" role="region" aria-label="批量操作">
              <button className="icon-button" disabled={actionBusy} aria-label="取消选择" onClick={clearSelection}>
                <X size={16} />
              </button>
              <strong aria-live="polite">{selected.size ? `已选 ${selected.size} 项` : "点击照片开始选择"}</strong>
              {view !== "trash" && (
                <Button className="subtle" disabled={actionBusy || !selected.size} onClick={addSelected}>
                  <ImagePlus size={16} />
                  添加到相片集
                </Button>
              )}
              {view === "albums" && albumId && (
                <Button
                  className="subtle"
                  disabled={actionBusy || !selected.size}
                  onClick={() => void removeSelected()}
                >
                  <Minus size={16} />
                  {removing ? "正在移除" : "从相片集移除"}
                </Button>
              )}
              <Button
                className="subtle"
                disabled={actionBusy || !selected.size || items.some(asset => selected.has(asset.id) && asset.deletionPending)}
                onClick={() => void action(view !== "trash")}
              >
                {view === "trash" ? (
                  <RefreshCw size={16} />
                ) : (
                  <Trash2 size={16} />
                )}{" "}
                {actionBusy ? "正在处理" : view === "trash" ? "恢复" : "移入最近删除"}
              </Button>
              {view === "trash" && permanentDeleteEnabled && <Button className="danger" disabled={actionBusy || !selected.size || items.some(asset => selected.has(asset.id) && asset.deletionPending)} onClick={deleteSelected}><Trash2 size={16} />永久删除已选</Button>}
              <Button
                className="subtle select-loaded"
                disabled={actionBusy}
                onClick={() => toggleGroup(items)}
              >
                {items.filter(a => !a.deletionPending).every(a => selected.has(a.id)) ? "取消全选" : "全选已加载"}
              </Button>
            </div>
          )}
          {actionError && <div className="error-banner" role="alert">{actionError}<Button disabled={actionBusy} onClick={() => { setActionError(""); void refreshRef.current(true); }}>刷新状态</Button></div>}
          {error && (
            <div className="error-banner">
              {error}
              <Button onClick={retryLoad}>重试</Button>
            </div>
          )}
          {view === "jobs" ? (
            <TaskCenter openUpload={() => { setUploadTab("files"); setUploadOpen(true); }} openAsset={id => void locateAsset(id)} changed={() => refreshRef.current()} />
          ) : albumGallery ? (
            loading ? (
              <div className="loading-inline">
                <LoaderCircle className="spin" size={20} />
                正在加载相片集
              </div>
            ) : albums.length ? (
              albums.some((a) =>
                a.name
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase()),
              ) ? (
                <AlbumGrid
                  albums={albums.filter((a) =>
                    a.name
                      .toLocaleLowerCase()
                      .includes(query.trim().toLocaleLowerCase()),
                  )}
                  open={a => openAlbum(a.id)}
                />
              ) : (
                <Empty icon={<Search />} title="没有符合条件的相片集"><Button onClick={clearFilters}>清除筛选</Button></Empty>
              )
            ) : (
              !error && (
                <Empty icon={<Images />} title="还没有相片集">
                  <Button
                    className="primary"
                    onClick={() => setAlbumDialog({ kind: "create" })}
                  >
                    <Plus size={17} />
                    新建相片集
                  </Button>
                </Empty>
              )
            )
          ) : loading && !items.length && view !== "similar" ? (
            <div className="skeleton-grid" aria-label="正在加载照片" style={{ "--columns": density, "--mobile-columns": density >= 5 ? 4 : density <= 3 ? 2 : 3 } as React.CSSProperties}>
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} />
              ))}
            </div>
          ) : view === "similar" ? (
            <div className="similar-list">
              {ignoredPair && <div className="similar-undo">已确认一组候选不同，后续不再提示。<button disabled={!!ignoring} onClick={() => void ignore(ignoredPair, true)}>撤销</button></div>}
              {loading && !similar.length ? (
                <div className="loading-inline">
                  <LoaderCircle className="spin" />
                  正在查找相似照片
                </div>
              ) : !similar.length && !similarNext ? (
                <Empty icon={<Copy />} title="没有需要核对的相似照片" />
              ) : (
                similar.map((pair) => {
                  const a = similarAssets[pair.left],
                    b = similarAssets[pair.right];
                  return a && b ? (
                    <div className="similar-pair" key={pair.left + pair.right}>
                      <Photo asset={a} onClick={() => setViewer(a)} />
                      <Photo asset={b} onClick={() => setViewer(b)} />
                      <div className="pair-actions">
                        <span>可能是同一张照片</span>
                        <small>
                          {a.width} × {a.height} · {b.width} × {b.height}
                        </small>
                        <Button
                          disabled={!!ignoring}
                          onClick={async () => {
                            try {
                              await api(`assets/${a.id}/merge`, {
                                other: b.id,
                              });
                              notify("已归并，所有原件均已保留");
                              void loadSimilar();
                            } catch (e) {
                              notify(String(e), true);
                            }
                          }}
                        >
                          <Layers3 size={16} />
                          归并为一项
                        </Button>
                        <Button className="similar-ignore" disabled={!!ignoring} onClick={() => void ignore(pair)}>确认不同</Button>
                      </div>
                    </div>
                  ) : null;
                })
              )}
              {similarNext && <Button className="similar-more" disabled={loading} onClick={() => void loadSimilar(true)}>{loading ? "正在加载" : "加载更多候选"}</Button>}
            </div>
          ) : !items.length && !error ? (
            <Empty
              icon={
                view === "all" && !query && !from && !to && !excludeAlbums ? (
                  <ImageIcon />
                ) : view === "albums" ? (
                  <Images />
                ) : (
                  <Search />
                )
              }
              title={
                query || from || to
                  ? "没有符合条件的照片"
                  : excludeAlbums
                    ? "没有未加入相片集的照片"
                    : view === "all"
                      ? "照片库还是空的"
                      : view === "albums"
                        ? "相片集还是空的"
                        : view === "trash"
                          ? "最近删除为空"
                          : `还没有${titles[view]}`
              }
            >
              {view === "all" && !query && !from && !to && !excludeAlbums ? (
                <>
                  <Button
                    className="primary"
                    onClick={() => {
                      setUploadTab("files");
                      setUploadOpen(true);
                    }}
                  >
                    <CloudUpload size={18} />
                    上传照片
                  </Button>
                  <button
                    className="text-link"
                    onClick={() => {
                      setUploadTab("apple");
                      setUploadOpen(true);
                    }}
                  >
                    连接 Apple 照片库
                    <ArrowUpRight size={15} />
                  </button>
                </>
              ) : null}
              {(query || from || to) && <Button onClick={clearFilters}>清除筛选</Button>}
              {excludeAlbums && (
                <Button onClick={() => setHideAlbumAssets(false)}>
                  显示全部照片
                </Button>
              )}
              {view === "albums" && album && !query && !from && !to && (
                <Button
                  className="primary"
                  onClick={() => setAlbumDialog({ kind: "pick", album })}
                >
                  <ImagePlus size={17} />
                  添加照片
                </Button>
              )}
            </Empty>
          ) : (
            <div
              className="timeline"
              style={{ "--columns": density, "--mobile-columns": density >= 5 ? 4 : density <= 3 ? 2 : 3 } as React.CSSProperties}
            >
              {groups.map((group) => (
                <section className="day-group" key={group.date}>
                  <div className="day-heading">
                    <h2>
                      {displayDate(group.date + "T12:00:00")}
                      <span>{group.date.slice(0, 4)}</span>
                    </h2>
                    <button className="day-select" disabled={actionBusy || group.items.every(a => a.deletionPending)} aria-pressed={group.items.filter(a => !a.deletionPending).every(a => selected.has(a.id))} onClick={() => toggleGroup(group.items)} title="选择或取消选择当天照片">
                      <span>{group.items.length} 项</span>
                      <span className="day-select-label">{group.items.filter(a => !a.deletionPending).every(a => selected.has(a.id)) ? "取消选择" : "选择当天"}</span>
                      <CircleCheck size={16} />
                    </button>
                  </div>
                  <div className="photo-grid">
                    {group.items.map((a) => (
                      <Photo
                        key={a.id}
                        asset={a}
                        selected={selected.has(a.id)}
                        disabled={actionBusy}
                        select={event => toggle(a.id, event.shiftKey)}
                        selecting={selecting}
                        onClick={event => selecting || event.shiftKey ? toggle(a.id, event.shiftKey) : setViewer(a)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          <div ref={more} className="load-more">
            {next &&
              (loading ? (
                <LoaderCircle className="spin" size={20} />
              ) : (
                <button onClick={() => error ? retryLoad() : void load(true)}>{error ? "重试加载" : "加载更多"}</button>
              ))}
          </div>
        </div>
      </main>
      <nav className="mobile-nav" aria-label="照片库导航">
        {(
          [
            ["all", Grid2X2],
            ["albums", Images],
            ["live", LivePhotoIcon],
          ] as const
        ).map(([id, Icon]) => (
          <button
            key={id}
            className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <Icon size={21} />
            <span>{titles[id]}</span>
          </button>
        ))}
        <button
          className={mobileMenu ? "active" : ""}
          onClick={() => setMobileMenu(!mobileMenu)}
        >
          <Layers3 size={21} />
          <span>整理</span>
        </button>
        <button
          onClick={() => {
            setUploadTab("sources");
            setUploadOpen(true);
          }}
        >
          <CloudUpload size={21} />
          <span>导入</span>
        </button>
      </nav>
      {mobileMenu && (
        <div
          className="mobile-menu-backdrop"
          onClick={() => setMobileMenu(false)}
        >
          <div className="mobile-menu" onClick={(e) => e.stopPropagation()}>
            {(
              [
                ["videos", Video],
                ["grouped", Layers3],
                ["similar", Copy],
                ["trash", Trash2],
                ["jobs", ListChecks],
              ] as const
            ).map(([id, Icon]) => (
              <button
                key={id}
                onClick={() => {
                  navigate(id);
                  setMobileMenu(false);
                }}
              >
                <Icon size={19} />
                <span>{titles[id]}</span>
                <ChevronRight size={15} />
              </button>
            ))}
            <a href="/portal/">
              <ArrowLeft size={19} />
              <span>返回门户</span>
            </a>
          </div>
        </div>
      )}
      {uploadOpen && (
        <UploadDialog
          tab={uploadTab}
          setTab={setUploadTab}
          close={() => setUploadOpen(false)}
          locate={id => void locateAsset(id)}
          openJobs={() => { setUploadOpen(false); navigate("jobs"); }}
        />
      )}
      {viewer && (
        <Viewer
          asset={viewer}
          items={items}
          openAsset={setViewer}
          close={() => { if (viewerKey.current === viewer.id) closeViewer(); }}
          previous={() => {
            const n = items.findIndex((i) => i.id === viewer.id);
            if (n > 0) setViewer(items[n - 1]);
          }}
          next={() => {
            const n = items.findIndex((i) => i.id === viewer.id);
            if (n >= 0 && n < items.length - 1) setViewer(items[n + 1]);
          }}
          changed={() => refreshRef.current(true)}
          notify={notify}
          addToAlbum={() =>
            setAlbumDialog({ kind: "add", assets: [viewer.id] })
          }
          modalOpen={!!albumDialog || !!deletionTargets}
          permanentDeleteEnabled={permanentDeleteEnabled}
          permanentlyDelete={openPermanentDelete}
        />
      )}
      {deletionTargets && <PermanentDeleteDialog targets={deletionTargets} close={() => setDeletionTargets(null)} submit={permanentDelete} />}
      {albumDialog && (
        <AlbumDialog
          state={albumDialog}
          close={() => setAlbumDialog(null)}
          saved={(saved) => {
            const kind = albumDialog.kind;
            setAlbumDialog(null);
            setSelected(new Set());
            if (kind === "delete") setAlbumId("");
            if (kind === "create" && saved) {
              setAlbums((old) => [saved, ...old]);
              openAlbum(saved.id);
            } else refreshRef.current();
            notify(
              kind === "delete"
                ? "已删除相片集，照片仍在照片库中"
                : kind === "rename"
                  ? "已重命名相片集"
                  : kind === "create"
                    ? "已创建相片集"
                    : `已添加到“${saved?.name}”`,
            );
          }}
        />
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="dialog about"
            onClick={(e) => e.stopPropagation()}
          >
            <IconButton title="关闭" onClick={() => setHelp(false)}>
              <X />
            </IconButton>
            <Brand />
            <p>
              Aura 保存上传的原始文件，包括
              EXIF、定位、色彩配置和实况资源。预览与播放文件独立生成。
            </p>
            <p>
              字节或完整像素一致的照片会自动归并。仅仅看起来相似的照片需要手动核对。原件可在详情中下载或分离；只有在“最近删除”中确认永久删除才会清理原件。
            </p>
            <a
              href="https://github.com/Crashmere/Aura"
              target="_blank"
              rel="noreferrer"
            >
              项目与使用文档 <ExternalLink size={15} />
            </a>
          </section>
        </div>
      )}
      {dragging && <div className="file-drop-overlay" aria-hidden="true"><div><CloudUpload size={44} strokeWidth={1.4} /><strong>松开即可导入照片与视频</strong></div></div>}
      {toast && (
        <div className={`toast ${toastError ? "is-error" : ""}`} role={toastError ? "alert" : "status"}>
          {toastError ? <X size={17} /> : <Check size={17} />}
          <span>{toast}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => { clearTimeout(toastTimer.current); setToast(""); }}><X size={15} /></button>
        </div>
      )}
    </div>
  );
}
function Empty({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-art">
        <div className="empty-frame one" />
        <div className="empty-frame two" />
        <div className="empty-frame three">{icon}</div>
        <span className="empty-orbit" />
      </div>
      <h2>{title}</h2>
      <div className="empty-actions">{children}</div>
    </div>
  );
}

function UploadDialog({
  tab,
  setTab,
  close,
  locate,
  openJobs,
}: {
  tab: string;
  setTab: (s: string) => void;
  close: () => void;
  locate: (id: string) => void;
  openJobs: () => void;
}) {
  const state = useSyncExternalStore(uploads.subscribe, uploads.snapshot),
    fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Original[]>([]);
  const [jobError, setJobError] = useState("");
  const [queueError, setQueueError] = useState("");
  useEffect(() => {
    const refresh = () =>
      api<Original[]>("jobs")
        .then(data => { setJobs(data); setJobError(""); })
        .catch(e => setJobError(e instanceof Error ? e.message : String(e)));
    void refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);
  const busy = state.running || state.scanning,
    finished = state.items.filter((i) =>
      ["done", "duplicate", "trashed", "skipped"].includes(i.state),
    ).length,
    errors = state.items.filter((i) => i.state === "error").length;
  const label: Record<string, string> = {
    waiting: "等待上传",
    reading: "读取原件",
    uploading: "上传中",
    done: "已保存",
    duplicate: "原件已存在",
    trashed: "已在最近删除中",
    skipped: "不在日期范围",
    error: "上传失败",
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="dialog upload-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          <div>
            <span className="eyebrow">IMPORT</span>
            <h2>添加到 Aura</h2>
          </div>
          <IconButton title="关闭" onClick={close}>
            <X size={21} />
          </IconButton>
        </div>
        <div className="tabs">
          {[
            ["files", "文件上传"],
            ["sources", "持续导入"],
            ["apple", "Apple 照片库"],
          ].map(([id, name]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={tab === id ? "active" : ""}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="dialog-content">
          {tab !== "apple" && (
            <div className="upload-dates">
              <label>
                拍摄日期
                <input
                  type="date"
                  disabled={busy}
                  value={state.from}
                  max={state.to || undefined}
                  onChange={(e) => uploads.configure(e.target.value, state.to)}
                />
              </label>
              <span>—</span>
              <label>
                结束日期
                <input
                  type="date"
                  disabled={busy}
                  min={state.from || undefined}
                  value={state.to}
                  onChange={(e) =>
                    uploads.configure(state.from, e.target.value)
                  }
                />
              </label>
              {(state.from || state.to) && (
                <button
                  disabled={busy}
                  onClick={() => uploads.configure("", "")}
                >
                  不限日期
                </button>
              )}
            </div>
          )}
          {tab === "files" && (
            <>
              <button
                className="dropzone"
                onClick={() => fileInput.current?.click()}
              >
                <div className="upload-symbol">
                  <CloudUpload size={30} strokeWidth={1.4} />
                </div>
                <strong>选择照片与视频</strong>
                <span>也可以拖入文件</span>
              </button>
              <div className="upload-options">
                <button onClick={() => folderInput.current?.click()}>
                  <FolderOpen size={16} />
                  选择整个文件夹
                </button>
                <span>HEIC · RAW · JPEG · MOV · MP4</span>
              </div>
              <p className="upload-note">
                iPhone 实况原件请使用 Apple 客户端，或从「文件」选择照片与
                MOV。系统选图器可能只提供静态照片。
              </p>
            </>
          )}
          {tab === "sources" && (
            <div className="source-panel">
              <div className="source-icon">
                <FolderOpen size={30} />
              </div>
              <h3>
                {state.watching ? state.sourceName : "持续读取一个文件夹"}
              </h3>
              <p>
                页面保持打开时，每 30
                秒检查新增文件，按上方拍摄日期范围上传。中断后可继续。
              </p>
              <div className="source-actions">
                {state.watching ? (
                  <Button onClick={uploads.stopWatch}>
                    <Pause size={16} />
                    停止监测
                  </Button>
                ) : (
                  <>
                    <Button
                      className="primary"
                      onClick={() => void uploads.watchDirectory()}
                    >
                      <FolderOpen size={16} />
                      选择文件夹
                    </Button>
                    <Button onClick={() => void uploads.watchDirectory(true)}>
                      <RefreshCw size={16} />
                      重新连接
                    </Button>
                  </>
                )}
              </div>
              <small>
                Chrome 支持文件夹持续读取；Apple 照片库请使用客户端。
              </small>
            </div>
          )}
          {tab === "apple" && (
            <div className="apple-panel">
              <div className="apple-illustration">
                <Monitor size={64} strokeWidth={1} />
                <Smartphone size={35} strokeWidth={1.3} />
                <span className="connection-line" />
                <img src={`${base}favicon.svg`} alt="Aura" />
              </div>
              <h3>原样上传你的 Apple 照片库</h3>
              <p>
                按拍摄日期持续导入，直接读取原始照片、实况视频、RAW
                和编辑资源。客户端沿用门户设备授权。
              </p>
              <a
                className="button primary"
                href="https://github.com/Crashmere/Aura/releases/latest/download/Aura-macOS.dmg"
              >
                <ArrowDownToLine size={17} />
                下载 Mac 客户端
              </a>
              <a
                className="button"
                style={{ marginLeft: 10 }}
                href="https://github.com/Crashmere/Aura/releases/latest/download/Aura-iOS.ipa"
              >
                <Smartphone size={17} />
                下载 iOS 安装包
              </a>
              <ol>
                <li>打开客户端，输入此服务器地址并完成门户授权。</li>
                <li>允许访问照片，选择日期范围，开始持续上传。</li>
              </ol>
              <div className="platform-note">
                <Smartphone size={18} />
                <p>
                  iOS 安装包使用 AltStore 或 Sideloadly
                  自签安装。网页无法后台扫描系统照片库。
                </p>
              </div>
              <a
                className="text-link"
                href="https://github.com/Crashmere/Aura/blob/main/docs/APPLE.md"
                target="_blank"
                rel="noreferrer"
              >
                客户端说明
                <ArrowUpRight size={14} />
              </a>
            </div>
          )}
          {state.error && <div className="error-banner">{state.error}</div>}
          {queueError && <div className="error-banner" role="alert">{queueError}</div>}
          {tab !== "apple" && state.items.length > 0 && (
            <div className="upload-queue">
              <div className="queue-header">
                <strong>
                  {finished} / {state.items.length} 个文件
                </strong>
                <div>
                  {busy ? (
                    <button onClick={uploads.pause}>
                      <Pause size={15} />
                      暂停
                    </button>
                  ) : state.paused || errors ? (
                    <button onClick={uploads.resume}>
                      <Play size={15} />
                      继续{errors ? " / 重试" : ""}
                    </button>
                  ) : null}
                  <button onClick={uploads.clearFinished}>清除已完成</button>
                </div>
              </div>
              <div className="queue-items">
                {state.items.slice(-150).map((item) => (
                  <div className="queue-item" key={item.id}>
                    <span className={`queue-state ${item.state}`}>
                      {item.state === "trashed" ? <Trash2 size={17} /> : item.state === "done" || item.state === "duplicate" ? (
                        <Check size={17} />
                      ) : item.state === "error" ? (
                        <X size={17} />
                      ) : item.state === "uploading" ||
                        item.state === "reading" ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <ImageIcon size={17} />
                      )}
                    </span>
                    <div className="queue-info">
                      <strong>{item.file.name}</strong>
                      <small>
                        {item.error || label[item.state]} ·{" "}
                        {bytes(item.file.size)}
                      </small>
                      {item.restoreError && <small className="queue-restore-error">{item.restoreError}</small>}
                      {item.assetId && ["done", "duplicate", "trashed"].includes(item.state) && <div className="queue-actions">
                        <button onClick={() => void uploads.locate(item.id).then(locate).catch(e => setQueueError(e instanceof Error ? e.message : String(e)))}>定位照片</button>
                        {item.state === "trashed" && <button disabled={item.restoring} onClick={() => void uploads.restore(item.id)}>{item.restoring ? "正在恢复" : "恢复照片"}</button>}
                      </div>}
                      {["reading", "uploading"].includes(item.state) && (
                        <div className="progress-track">
                          <i style={{ width: `${item.progress * 100}%` }} />
                        </div>
                      )}
                    </div>
                    <small>{Math.round(item.progress * 100)}%</small>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab !== "apple" && jobError && <div className="error-banner" role="alert">{jobError}</div>}
          {tab !== "apple" && <button className="text-link processing-link" onClick={openJobs}><ListChecks size={15} />查看全部导入与处理任务</button>}
          {tab !== "apple" && jobs.length > 0 && (
            <details className="processing-jobs">
              <summary>服务器处理 · {jobs.length} 项</summary>
              {jobs.map((f) => (
                <div key={f.hash}>
                  <span>
                    {f.name}
                    <small>
                      {f.status === "error"
                        ? f.error || "预览处理失败，原件已保存"
                        : f.status === "queued"
                          ? "等待整理"
                          : "正在生成预览"}
                    </small>
                  </span>
                  {f.status === "error" && (
                    <button
                      onClick={() =>
                        void api(`files/${f.hash}/retry`, {}).then(() =>
                          api<Original[]>("jobs").then(setJobs),
                        ).catch(e => setJobError(e instanceof Error ? e.message : String(e)))
                      }
                    >
                      重试
                    </button>
                  )}
                </div>
              ))}
            </details>
          )}
        </div>
        <footer className="dialog-footer">
          <span>
            <CheckCheck size={15} />
            原件校验 · 自动去重 · 断点续传
          </span>
          <Button onClick={close}>{busy ? "收起" : "完成"}</Button>
        </footer>
        <input
          ref={fileInput}
          hidden
          type="file"
          multiple
          onChange={(e) => {
            uploads.addFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          hidden
          type="file"
          multiple
          {...({
            webkitdirectory: "",
          } as React.InputHTMLAttributes<HTMLInputElement>)}
          onChange={(e) => {
            uploads.addFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
