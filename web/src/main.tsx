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
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CloudUpload,
  Copy,
  FolderOpen,
  Grid2X2,
  Heart,
  Image as ImageIcon,
  Info as InfoIcon,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Smartphone,
  Trash2,
  Video,
  Wifi,
  X,
  ScanLine,
  CalendarDays,
  Monitor,
  ExternalLink,
} from "lucide-react";
import {
  api,
  Asset,
  Detail,
  Original,
  Info,
  base,
  media,
  bytes,
  displayDate,
} from "./api";
import * as uploads from "./upload";
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
  favorites: "个人收藏",
  live: "实况照片",
  videos: "视频",
  grouped: "已归并",
  similar: "相似照片",
  trash: "最近删除",
};
function Brand() {
  return (
    <a className="brand" href="/aura/">
      <img src={`${base}favicon.svg`} alt="" />
      <span>Aura</span>
    </a>
  );
}
function Button({
  children,
  onClick,
  className = "",
  title,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`button ${className}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function IconButton({
  children,
  onClick,
  title,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      onClick={onClick}
      aria-label={title}
      title={title}
    >
      {children}
    </button>
  );
}
function Photo({
  asset,
  onClick,
  selected = false,
  select,
}: {
  asset: Asset;
  onClick: () => void;
  selected?: boolean;
  select?: () => void;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [asset.primary, asset.status]);
  return (
    <div className={`photo ${selected ? "selected" : ""}`}>
      <button className="photo-open" onClick={onClick} aria-label={asset.name}>
        {!broken ? (
          <img
            src={media(asset.primary)}
            alt={asset.name}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
          />
        ) : (
          <div className="photo-missing">
            <ImageIcon />
            <span>
              {asset.status === "error" ? "预览待处理" : "正在生成预览"}
            </span>
          </div>
        )}
        <div className="photo-shade" />
        {asset.kind === "live" && (
          <span className="photo-kind">
            <ScanLine size={13} />
            实况
          </span>
        )}
        {asset.kind === "video" && (
          <span className="photo-kind">
            <Video size={14} />
          </span>
        )}
        {asset.favorite && (
          <Heart className="photo-heart" size={17} fill="currentColor" />
        )}
        {asset.variants > 1 && asset.kind !== "live" && (
          <span className="photo-versions">
            <Layers3 size={13} />
            {asset.variants}
          </span>
        )}
      </button>
      {select && (
        <button
          className={`select-photo ${selected ? "checked" : ""}`}
          aria-label={selected ? "取消选择" : "选择照片"}
          onClick={select}
        >
          {selected && <Check size={15} />}
        </button>
      )}
    </div>
  );
}
function App() {
  const [view, setView] = useState("all"),
    [info, setInfo] = useState<Info>(),
    [items, setItems] = useState<Asset[]>([]),
    [next, setNext] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [filters, setFilters] = useState(false),
    [density, setDensity] = useState(4);
  const [uploadOpen, setUploadOpen] = useState(false),
    [uploadTab, setUploadTab] = useState("files"),
    [viewer, setViewer] = useState<Asset | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [toast, setToast] = useState(""),
    [help, setHelp] = useState(false),
    [mobileMenu, setMobileMenu] = useState(false);
  const [similar, setSimilar] = useState<
      { left: string; right: string; distance: number }[]
    >([]),
    [similarAssets, setSimilarAssets] = useState<Record<string, Asset>>({});
  const uploading = useSyncExternalStore(uploads.subscribe, uploads.snapshot);
  const refreshRef = useRef(() => {});
  const queryKey = useRef(0);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(id);
  }, [search]);
  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 4500);
  };
  const params = (cursor = "") =>
    new URLSearchParams({
      view,
      q: query,
      from,
      to,
      ...(cursor ? { cursor } : {}),
    }).toString();
  async function load(append = false) {
    const key = ++queryKey.current;
    setLoading(true);
    setError("");
    try {
      const [data, stats] = await Promise.all([
        api<{ items: Asset[]; next: string }>(
          "assets?" + params(append ? next : ""),
        ),
        api<Info>("info"),
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
    } catch (e) {
      if (key === queryKey.current)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (key === queryKey.current) setLoading(false);
    }
  }
  async function loadSimilar() {
    setLoading(true);
    setError("");
    try {
      const pairs = await api<typeof similar>("similar");
      setSimilar(pairs);
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
      setSimilarAssets(assets);
      setInfo(await api<Info>("info"));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setSelected(new Set());
    if (view === "similar") void loadSimilar();
    else void load();
  }, [view, query, from, to]);
  refreshRef.current = () => {
    if (view === "similar") void loadSimilar();
    else void load();
  };
  useEffect(() => {
    const fn = () => refreshRef.current();
    window.addEventListener("aura-library-changed", fn);
    return () => window.removeEventListener("aura-library-changed", fn);
  }, []);
  useEffect(() => {
    if (!info?.queued && !uploading.running) return;
    const timer = setInterval(() => refreshRef.current(), 4000);
    return () => clearInterval(timer);
  }, [info?.queued, uploading.running]);
  useEffect(() => {
    if (!next || loading || view === "similar") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void load(true);
      },
      { rootMargin: "500px" },
    );
    if (more.current) observer.observe(more.current);
    return () => observer.disconnect();
  }, [next, loading, view]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setViewer(null);
        setUploadOpen(false);
        setHelp(false);
        setMobileMenu(false);
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
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
  async function action(body: unknown) {
    try {
      for (const id of selected) await api("assets/" + id, body, "PATCH");
      setSelected(new Set());
      refreshRef.current();
      notify("已更新");
    } catch (e) {
      notify(String(e));
    }
  }
  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  const completed = uploading.items.filter((i) =>
    ["done", "duplicate", "skipped"].includes(i.state),
  ).length;
  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          uploads.addFiles(Array.from(e.dataTransfer.files));
          setUploadOpen(true);
        }
      }}
    >
      <aside className="sidebar">
        <Brand />
        <nav className="navigation">
          {(
            [
              ["all", Grid2X2, "total"],
              ["favorites", Heart, "favorites"],
              ["live", ScanLine, "live"],
              ["videos", Video, "videos"],
            ] as const
          ).map(([id, Icon, count]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id)}
            >
              <Icon size={19} />
              <span>{titles[id]}</span>
              {!!info?.[count] && <small>{info[count]}</small>}
            </button>
          ))}
          <div className="nav-label">整理</div>
          {(
            [
              ["grouped", Layers3],
              ["similar", Copy],
              ["trash", Trash2],
            ] as const
          ).map(([id, Icon]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id)}
            >
              <Icon size={18} />
              <span>{titles[id]}</span>
              {id === "grouped" && !!info?.grouped && (
                <small>{info.grouped}</small>
              )}
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
            个人照片库 <span>/</span> {titles[view]}
          </span>
          <div className="top-actions">
            <div className="search">
              <Search size={17} />
              <input
                aria-label="搜索照片"
                placeholder="搜索文件名、相机…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button onClick={() => setSearch("")} aria-label="清空搜索">
                  <X size={14} />
                </button>
              )}
            </div>
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
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === "all"
                  ? "LIBRARY"
                  : view === "favorites"
                    ? "FAVORITES"
                    : view === "live"
                      ? "LIVE PHOTOS"
                      : view === "videos"
                        ? "VIDEOS"
                        : "COLLECTION"}
              </div>
              <h1>
                {titles[view]}
                {view === "all" && info ? (
                  <span className="heading-count">
                    {info.total.toLocaleString()}
                  </span>
                ) : null}
              </h1>
            </div>
            <div className="heading-actions">
              <IconButton
                title="日期筛选"
                className={filters || from || to ? "is-active" : ""}
                onClick={() => setFilters(!filters)}
              >
                <CalendarDays size={19} />
              </IconButton>
              <div className="density-control">
                <Grid2X2 size={15} />
                <input
                  type="range"
                  aria-label="缩略图大小"
                  min="3"
                  max="7"
                  value={density}
                  onChange={(e) => setDensity(+e.target.value)}
                />
              </div>
            </div>
          </div>
          {filters && (
            <div className="date-filters">
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
              移出照片库的项目会保留在这里，可随时恢复。
            </p>
          )}
          {selected.size > 0 && (
            <div className="selection-bar">
              <button onClick={() => setSelected(new Set())}>
                <X size={16} />
              </button>
              <strong>已选 {selected.size} 项</strong>
              <Button
                className="subtle"
                onClick={() => void action({ favorite: true })}
              >
                <Heart size={16} />
                收藏
              </Button>
              <Button
                className="subtle"
                onClick={() => void action({ trash: view !== "trash" })}
              >
                {view === "trash" ? (
                  <RefreshCw size={16} />
                ) : (
                  <Trash2 size={16} />
                )}{" "}
                {view === "trash" ? "恢复" : "移入最近删除"}
              </Button>
              <Button
                className="subtle"
                onClick={() => setSelected(new Set(items.map((a) => a.id)))}
              >
                选择当前已加载项目
              </Button>
            </div>
          )}
          {error && (
            <div className="error-banner">
              {error}
              <Button onClick={() => refreshRef.current()}>重试</Button>
            </div>
          )}
          {loading && !items.length && view !== "similar" ? (
            <div className="skeleton-grid">
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} />
              ))}
            </div>
          ) : view === "similar" ? (
            <div className="similar-list">
              {loading ? (
                <div className="loading-inline">
                  <LoaderCircle className="spin" />
                  正在查找相似照片
                </div>
              ) : !similar.length ? (
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
                          onClick={async () => {
                            try {
                              await api(`assets/${a.id}/merge`, {
                                other: b.id,
                              });
                              notify("已归并，所有原件均已保留");
                              void loadSimilar();
                            } catch (e) {
                              notify(String(e));
                            }
                          }}
                        >
                          <Layers3 size={16} />
                          归并为一项
                        </Button>
                      </div>
                    </div>
                  ) : null;
                })
              )}
            </div>
          ) : !items.length && !error ? (
            <Empty
              icon={
                view === "all" && !query && !from && !to ? (
                  <ImageIcon />
                ) : view === "favorites" ? (
                  <Heart />
                ) : (
                  <Search />
                )
              }
              title={
                query || from || to
                  ? "没有符合条件的照片"
                  : view === "all"
                    ? "照片库还是空的"
                    : view === "favorites"
                      ? "收藏喜欢的瞬间"
                      : view === "trash"
                        ? "最近删除为空"
                        : `还没有${titles[view]}`
              }
            >
              {view === "all" && !query && !from && !to ? (
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
            </Empty>
          ) : (
            <div
              className="timeline"
              style={{ "--columns": density } as React.CSSProperties}
            >
              {groups.map((group) => (
                <section className="day-group" key={group.date}>
                  <div className="day-heading">
                    <h2>
                      {displayDate(group.date + "T12:00:00")}
                      <span>{group.date.slice(0, 4)}</span>
                    </h2>
                    <button
                      onClick={() =>
                        setSelected(
                          (s) =>
                            new Set([...s, ...group.items.map((a) => a.id)]),
                        )
                      }
                    >
                      {group.items.length} 项<ChevronDown size={13} />
                    </button>
                  </div>
                  <div className="photo-grid">
                    {group.items.map((a) => (
                      <Photo
                        key={a.id}
                        asset={a}
                        selected={selected.has(a.id)}
                        select={() => toggle(a.id)}
                        onClick={() =>
                          selected.size ? toggle(a.id) : setViewer(a)
                        }
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
                <button onClick={() => void load(true)}>加载更多</button>
              ))}
          </div>
        </div>
      </main>
      <nav className="mobile-nav">
        {(
          [
            ["all", Grid2X2],
            ["favorites", Heart],
            ["live", ScanLine],
          ] as const
        ).map(([id, Icon]) => (
          <button
            key={id}
            className={view === id ? "active" : ""}
            onClick={() => setView(id)}
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
              ] as const
            ).map(([id, Icon]) => (
              <button
                key={id}
                onClick={() => {
                  setView(id);
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
        />
      )}
      {viewer && (
        <Viewer
          asset={viewer}
          close={() => setViewer(null)}
          previous={() => {
            const n = items.findIndex((i) => i.id === viewer.id);
            if (n > 0) setViewer(items[n - 1]);
          }}
          next={() => {
            const n = items.findIndex((i) => i.id === viewer.id);
            if (n >= 0 && n < items.length - 1) setViewer(items[n + 1]);
          }}
          changed={() => refreshRef.current()}
          notify={notify}
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
              字节或完整像素一致的照片会自动归并。仅仅看起来相似的照片需要手动核对。原件始终保留，可在详情中下载或分离。
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
      {toast && (
        <div className="toast">
          <Check size={17} />
          {toast}
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
}: {
  tab: string;
  setTab: (s: string) => void;
  close: () => void;
}) {
  const state = useSyncExternalStore(uploads.subscribe, uploads.snapshot),
    fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Original[]>([]);
  useEffect(() => {
    const refresh = () =>
      api<Original[]>("jobs")
        .then(setJobs)
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);
  const busy = state.running || state.scanning,
    finished = state.items.filter((i) =>
      ["done", "duplicate", "skipped"].includes(i.state),
    ).length,
    errors = state.items.filter((i) => i.state === "error").length;
  const label: Record<string, string> = {
    waiting: "等待上传",
    reading: "读取原件",
    uploading: "上传中",
    done: "已保存",
    duplicate: "原件已存在",
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
              <a className="button" style={{marginLeft:10}} href="https://github.com/Crashmere/Aura/releases/latest/download/Aura-iOS.ipa"><Smartphone size={17}/>下载 iOS 安装包</a>
              <ol>
                <li>打开客户端，输入此服务器地址并完成门户授权。</li>
                <li>允许访问照片，选择日期范围，开始持续上传。</li>
              </ol>
              <div className="platform-note">
                <Smartphone size={18} />
                <p>
                  iOS 安装包使用 AltStore 或 Sideloadly 自签安装。网页无法后台扫描系统照片库。
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
                      {item.state === "done" || item.state === "duplicate" ? (
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
          {tab !== "apple" && jobs.length > 0 && (
            <details className="processing-jobs">
              <summary>服务器处理 · {jobs.length} 项</summary>
              {jobs.map((f) => (
                <div key={f.hash}>
                  <span>
                    {f.name}
                    <small>
                      {f.status === "error"
                        ? "预览处理失败，原件已保存"
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
                        )
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

function Viewer({
  asset,
  close,
  previous,
  next,
  changed,
  notify,
}: {
  asset: Asset;
  close: () => void;
  previous: () => void;
  next: () => void;
  changed: () => void;
  notify: (s: string) => void;
}) {
  const [detail, setDetail] = useState<Detail>(),
    [showInfo, setShowInfo] = useState(false),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState(""),
    [imageError, setImageError] = useState(false),
    [zoom, setZoom] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const refresh = () =>
    api<Detail>("assets/" + asset.id)
      .then(setDetail)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    setDetail(undefined);
    setPlaying(false);
    setImageError(false);
    setError("");
    setZoom(false);
    void refresh();
  }, [asset.id]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,textarea")) return;
      if (e.key === "ArrowLeft") previous();
      if (e.key === "ArrowRight") next();
      if (e.key === "i") setShowInfo((x) => !x);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previous, next]);
  const a = detail?.asset || asset,
    primary = detail?.files.find((f) => f.hash === a.primary);
  const meta = detail?.metadata || {};
  const field = (...names: string[]) => {
    for (const name of names) {
      const key = Object.keys(meta).find(
        (k) => k === name || k.endsWith(":" + name),
      );
      if (key && meta[key] !== undefined) return String(meta[key]);
    }
    return "";
  };
  async function update(p: unknown) {
    try {
      await api("assets/" + a.id, p, "PATCH");
      await refresh();
      changed();
    } catch (e) {
      notify(String(e));
    }
  }
  const start = () => {
    setPlaying(true);
    setTimeout(() => {
      if (video.current) {
        video.current.currentTime = 0;
        void video.current.play().catch(() => {});
      }
    }, 20);
  };
  return (
    <div className={`viewer ${showInfo ? "with-info" : ""}`}>
      <div className="viewer-main">
        <header className="viewer-toolbar">
          <IconButton title="关闭" onClick={close}>
            <X size={23} />
          </IconButton>
          <div className="viewer-date">
            <strong>{displayDate(a.capturedAt, true)}</strong>
            <small>{a.name}</small>
          </div>
          <div className="viewer-actions">
            <IconButton
              title="收藏"
              className={a.favorite ? "favorite" : ""}
              onClick={() => void update({ favorite: !a.favorite })}
            >
              <Heart size={20} fill={a.favorite ? "currentColor" : "none"} />
            </IconButton>
            <a
              className="icon-button"
              title="下载全部原件"
              href={`${base}api/assets/${a.id}/download`}
            >
              <ArrowDownToLine size={21} />
            </a>
            <IconButton
              title="照片信息"
              className={showInfo ? "active" : ""}
              onClick={() => setShowInfo(!showInfo)}
            >
              <InfoIcon size={21} />
            </IconButton>
            <IconButton
              title={a.trashedAt ? "恢复" : "移入最近删除"}
              onClick={async () => {
                await update({ trash: !a.trashedAt });
                notify(a.trashedAt ? "已恢复" : "已移入最近删除");
                close();
              }}
            >
              {a.trashedAt ? <RefreshCw size={20} /> : <Trash2 size={20} />}
            </IconButton>
          </div>
        </header>
        <div className={`viewer-stage ${zoom ? "zoomed" : ""}`}>
          <button
            className="viewer-prev"
            onClick={previous}
            aria-label="上一张"
          >
            <ChevronLeft />
          </button>
          <div className="media-stage">
            {a.kind === "video" ? (
              <video
                key={a.primary}
                src={media(a.primary, "play")}
                controls
                playsInline
                poster={media(a.primary)}
                onError={() => setImageError(true)}
              />
            ) : (
              <>
                <img
                  key={a.primary}
                  src={media(a.primary, "preview")}
                  alt={a.name}
                  style={{ visibility: playing ? "hidden" : "visible" }}
                  onClick={() => setZoom(!zoom)}
                  onError={() => setImageError(true)}
                />
                {a.motion && playing && (
                  <video
                    ref={video}
                    className="live-video"
                    src={media(a.motion, "play")}
                    autoPlay
                    playsInline
                    controls
                    onEnded={() => setPlaying(false)}
                    onError={() => {
                      setPlaying(false);
                      notify("实况预览正在生成，可从详情下载视频原件");
                    }}
                  />
                )}
              </>
            )}
            {imageError && (
              <div className="viewer-fallback">
                <ImageIcon size={40} />
                <p>预览尚未就绪</p>
                <a className="button" href={media(a.primary, "original")}>
                  下载原件
                </a>
              </div>
            )}
          </div>
          <button className="viewer-next" onClick={next} aria-label="下一张">
            <ChevronRight />
          </button>
        </div>
        <footer className="viewer-footer">
          {a.kind === "live" && (
            <button
              className={`live-control ${playing ? "playing" : ""}`}
              onClick={() => (playing ? setPlaying(false) : start())}
            >
              <ScanLine size={18} />
              {playing ? "停止播放" : "播放实况"}
            </button>
          )}
          <span>
            {a.width} × {a.height}
            {primary?.mime
              ? " · " +
                primary.mime
                  .replace("image/", "")
                  .replace("video/", "")
                  .toUpperCase()
              : ""}
          </span>
        </footer>
      </div>
      {showInfo && (
        <aside className="info-panel">
          <div className="info-title">
            <h2>照片信息</h2>
            <IconButton title="关闭信息" onClick={() => setShowInfo(false)}>
              <X size={20} />
            </IconButton>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <div className="metadata-summary">
            <div>
              <CalendarDays size={19} />
              <span>
                <strong>{displayDate(a.capturedAt, true)}</strong>
                <small>
                  {new Date(a.capturedAt).toLocaleTimeString("zh-CN")}
                </small>
              </span>
            </div>
            <div>
              <ImageIcon size={19} />
              <span>
                <strong>{a.name}</strong>
                <small>
                  {a.width} × {a.height} · {bytes(a.size)}
                </small>
              </span>
            </div>
            {field("Model", "Make") && (
              <div>
                <ScanLine size={19} />
                <span>
                  <strong>{field("Model", "Make")}</strong>
                  <small>
                    {[
                      field("LensModel"),
                      field("FNumber") && "ƒ/" + field("FNumber"),
                      field("ISO") && "ISO " + field("ISO"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
              </div>
            )}
            {(field("GPSLatitude") ||
              primary?.hints.latitude !== undefined) && (
              <div>
                <Wifi size={19} />
                <span>
                  <strong>定位已保留</strong>
                  <small>
                    {field("GPSLatitude") || String(primary?.hints.latitude)},{" "}
                    {field("GPSLongitude") || String(primary?.hints.longitude)}
                  </small>
                </span>
              </div>
            )}
          </div>
          <div className="originals">
            <h3>
              原始资源 <span>{detail?.files.length || a.variants}</span>
            </h3>
            {detail?.files.map((f) => (
              <div className="original" key={f.hash}>
                <div className="original-header">
                  <span className="file-type">
                    {f.mime.startsWith("video/") ? (
                      <Video size={19} />
                    ) : (
                      <ImageIcon size={19} />
                    )}
                  </span>
                  <div>
                    <strong>{f.name}</strong>
                    <small>
                      {bytes(f.size)}
                      {f.hash === a.primary
                        ? " · 主版本"
                        : f.hash === a.motion
                          ? " · 实况视频"
                          : ""}
                    </small>
                  </div>
                  <a
                    title="下载此原件"
                    className="icon-button"
                    href={media(f.hash, "original")}
                  >
                    <ArrowDownToLine size={16} />
                  </a>
                </div>
                <div className="original-actions">
                  {f.hash !== a.primary && f.mime.startsWith("image/") && (
                    <button onClick={() => void update({ primary: f.hash })}>
                      设为主版本
                    </button>
                  )}
                  {detail.files.length > 1 && (
                    <button
                      onClick={async () => {
                        try {
                          await api(`assets/${a.id}/split`, { hash: f.hash });
                          notify("已分离为独立项目");
                          await refresh();
                          changed();
                        } catch (e) {
                          notify(String(e));
                        }
                      }}
                    >
                      分离
                    </button>
                  )}
                </div>
                <details>
                  <summary>SHA-256</summary>
                  <code>{f.hash}</code>
                </details>
              </div>
            ))}
          </div>
          <details className="all-metadata">
            <summary>
              全部元数据 <span>{Object.keys(meta).length}</span>
            </summary>
            <dl>
              {Object.entries(meta).map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt>{key}</dt>
                  <dd>
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </details>
        </aside>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
