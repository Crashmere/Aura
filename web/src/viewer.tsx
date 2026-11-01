import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, CalendarDays, ChevronLeft, ChevronRight, FileText, Image as ImageIcon, ImagePlus, Info as InfoIcon, Layers3, LoaderCircle, RefreshCw, ScanLine, Trash2, Video, Wifi, X, Ellipsis, ZoomIn, ZoomOut } from "lucide-react";
import { api, Asset, Detail, base, media, bytes, displayDate, resourceLabel } from "./api";
import { LivePhotoIcon } from "./live-photo-icon";
import { useImageGestures, useWheelNavigation } from "./image-gestures";
import { IconButton } from "./controls";
import { ProgressiveImage } from "./progressive-image";
import { VideoPlayer, VIDEO_SKIP_SECONDS } from "./video-player";
import { cancelPreloads, preloadPreviews, setMediaMode, useMediaPolicy, type MediaMode } from "./media-loading";
import { PhotoEdits, VersionPicker, versionAsset } from "./photo-versions";
import "./viewer.css";

function PhotoSurface({ asset, locked, previous, next, close, toggleChrome, hasPrevious, hasNext, onReady }: {
  asset: Asset; locked: boolean; previous: () => void; next: () => void; close: () => void; toggleChrome: () => void; hasPrevious: boolean; hasNext: boolean; onReady: () => void;
}) {
  const gestures = useImageGestures(`${asset.id}:${asset.primary}`, !locked && !asset.deletionPending, previous, next, close, toggleChrome, hasPrevious, hasNext);
  const { scale, x, y } = gestures.transform;
  return <div ref={gestures.stage} className={`media-stage image-gesture-stage ${gestures.dragging ? "is-dragging" : ""} ${scale > 1 ? "is-zoomed" : ""}`} {...gestures.handlers}>
    <div className="viewer-image-transform" style={{ "--image-transform": `translate3d(${x}px, ${y}px, 0) scale(${scale})` } as React.CSSProperties}>
      <ProgressiveImage key={`${asset.primary}:${asset.status}`} asset={asset} zoomed={scale > 1} onReady={onReady} />
    </div>
    <div className="viewer-zoom-controls">
      <button title={scale > 1 ? "适合屏幕" : "放大（双击照片）"} aria-label={scale > 1 ? "适合屏幕" : "放大照片"} disabled={locked} onClick={() => gestures.toggle()}>{scale > 1 ? <ZoomOut size={19} /> : <ZoomIn size={19} />}</button>
      {scale > 1 && <button onClick={gestures.reset} disabled={locked}>{Math.round(scale * 100)}%</button>}
    </div>
  </div>;
}

function ViewerThumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  return <>
    {failed ? <ImageIcon size={18} aria-hidden="true" /> : <img src={media(asset.primary)} alt="" decoding="async" loading="lazy" draggable={false} onError={() => setFailed(true)} />}
    {asset.kind === "video" && <Video className="viewer-thumbnail-kind" size={12} aria-hidden="true" />}
    {asset.kind === "live" && <span className="viewer-thumbnail-kind"><LivePhotoIcon size={12} /></span>}
  </>;
}

export function Viewer({
  asset,
  close,
  previous,
  next,
  changed,
  notify,
  addToAlbum,
  modalOpen,
  permanentDeleteEnabled,
  permanentlyDelete,
  items,
  openAsset,
}: {
  asset: Asset;
  close: () => void;
  previous: () => void;
  next: () => void;
  changed: () => Promise<void>;
  notify: (s: string, failed?: boolean) => void;
  addToAlbum: () => void;
  modalOpen: boolean;
  permanentDeleteEnabled: boolean;
  permanentlyDelete: (targets: Asset[]) => void;
  items?: Asset[];
  openAsset?: (asset: Asset) => void;
}) {
  const [detail, setDetail] = useState<Detail>(),
    [showInfo, setShowInfo] = useState(false),
    [playingAsset, setPlayingAsset] = useState<string>(),
    [error, setError] = useState(""),
    [updating, setUpdating] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [readyAsset, setReadyAsset] = useState("");
  const [activityTick, setActivityTick] = useState(0);
  const policy = useMediaPolicy();
  const detailAbort = useRef<AbortController | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const filmstrip = useRef<HTMLElement>(null);
  const [stripCount, setStripCount] = useState(15);
  const infoId = useId();
  const currentAsset = useRef(asset.id);
  currentAsset.current = asset.id;
  const request = useRef(0);
  const updateLock = useRef(false);
  function refresh() {
    const key = ++request.current;
    const id = asset.id;
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    return api<Detail>("assets/" + id, undefined, undefined, controller.signal)
      .then(data => { if (currentAsset.current === id && request.current === key) setDetail(data); })
      .catch(e => { if (!controller.signal.aborted && currentAsset.current === id && request.current === key) setError(e instanceof Error ? e.message : String(e)); });
  }
  useEffect(() => {
    setDetail(undefined);
    setPlayingAsset(undefined);
    setError("");
    setShowActions(false);
    setShowVersions(false);
    setControlsHidden(false);
    setVideoPlaying(false);
    return () => { ++request.current; detailAbort.current?.abort(); };
  }, [asset.id]);
  useEffect(() => {
    if (showInfo || asset.imageVersions > 1 || (asset.kind === "video" && asset.variants > 1)) void refresh();
    return () => detailAbort.current?.abort();
  }, [asset.id, asset.imageVersions, asset.kind, asset.variants, showInfo]);
  function activity() { setControlsHidden(false); setActivityTick(value => value + 1); }
  useEffect(() => {
    if (!videoPlaying || showInfo || showActions || showVersions || modalOpen) return;
    const timer = setTimeout(() => setControlsHidden(true), 3200);
    return () => clearTimeout(timer);
  }, [videoPlaying, showInfo, showActions, showVersions, modalOpen, activityTick]);
  useEffect(() => {
    if (!showActions && !showVersions) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest(".viewer-actions")) { setShowActions(false); setShowVersions(false); } };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [showActions, showVersions]);
  const scopedDetail = detail?.asset.id === asset.id ? detail : undefined;
  const catalog = scopedDetail?.asset || items?.find(item => item.id === asset.id) || asset;
  const primary = scopedDetail?.files.find(file => file.hash === selectedVersions[asset.id]) || scopedDetail?.files.find(file => file.hash === catalog.primary);
  const a = primary ? versionAsset(catalog, primary, scopedDetail!.files) : catalog;
  const versions = scopedDetail?.files.filter(file => file.mime.startsWith(catalog.kind === "video" ? "video/" : "image/")) || [];
  function selectVersion(hash: string) {
    if (modalOpen || updateLock.current || catalog.deletionPending) return;
    setSelectedVersions(previous => ({ ...previous, [catalog.id]: hash }));
    setPlayingAsset(undefined);
    setVideoPlaying(false);
    setShowVersions(false);
    activity();
  }
  const playing = playingAsset === a.id;
  const index = items?.findIndex(item => item.id === a.id) ?? -1;
  const before = index > 0 ? items?.[index - 1] : undefined;
  const after = index >= 0 ? items?.[index + 1] : undefined;
  const hasPrevious = items === undefined || !!before;
  const hasNext = items === undefined || !!after;
  const locked = updating || modalOpen;
  const stripStart = Math.max(0, Math.min(index - Math.floor(stripCount / 2), (items?.length ?? 0) - stripCount));
  const nearby = index >= 0 && openAsset ? items?.slice(stripStart, stripStart + stripCount) ?? [] : [];
  function goPrevious() {
    if (modalOpen || updateLock.current || !hasPrevious) return;
    if (before && openAsset) openAsset(before); else previous();
  }
  function goNext() {
    if (modalOpen || updateLock.current || !hasNext) return;
    if (after && openAsset) openAsset(after); else next();
  }
  useWheelNavigation(root, !locked && !a.deletionPending, goPrevious, goNext);
  useEffect(() => {
    if (videoPlaying || (a.kind !== "video" && readyAsset !== `${a.id}:${a.primary}`)) return;
    preloadPreviews([after, before].filter((item): item is Asset => !!item), 400);
    return cancelPreloads;
  }, [a.id, a.primary, readyAsset, videoPlaying, before?.primary, after?.primary, policy.prefetch]);
  useEffect(() => {
    const strip = filmstrip.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !selected) return;
    const center = () => {
      setStripCount(Math.max(9, Math.floor((strip.clientWidth - 28) / 43)));
      const offset = selected.getBoundingClientRect().left - strip.getBoundingClientRect().left;
      strip.scrollLeft += offset - (strip.clientWidth - selected.offsetWidth) / 2;
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [a.id, index, nearby.length]);
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const element = root.current;
    element?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected &&
        (document.activeElement === document.body || element?.contains(document.activeElement))) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || modalOpen || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Tab") { e.preventDefault(); return; }
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (e.shiftKey || target?.isContentEditable || target?.closest('input, textarea, select, video, audio, [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="tree"]')) return;
      if (!["Escape", "ArrowLeft", "ArrowRight", "i", " ", "f", "m", "j", "l", ",", "."].includes(e.key)) return;
      e.preventDefault();
      if (updateLock.current) return;
      if (e.key === "ArrowLeft") goPrevious();
      if (e.key === "ArrowRight") goNext();
      if (!e.repeat && e.key === "Escape") { if (showVersions) setShowVersions(false); else if (showActions) setShowActions(false); else if (showInfo) setShowInfo(false); else close(); }
      if (!e.repeat && e.key === "i") { setShowInfo(value => !value); activity(); }
      const action = e.key === " " ? "toggle" : e.key === "f" ? "fullscreen" : e.key === "m" ? "mute" : "";
      if (action && !e.repeat) root.current?.querySelector<HTMLButtonElement>(`[data-player-${action}]`)?.click();
      if (e.key === "," || e.key === ".") root.current?.querySelector<HTMLButtonElement>(`[data-player-${e.key === "," ? "previous" : "next"}-frame]`)?.click();
      if (e.key === "j" || e.key === "l") {
        const video = root.current?.querySelector("video");
        if (video && Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + (e.key === "j" ? -VIDEO_SKIP_SECONDS : VIDEO_SKIP_SECONDS)));
        activity();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previous, next, openAsset, before, after, hasPrevious, hasNext, modalOpen, close, showInfo, showActions, showVersions]);
  const meta = primary?.metadata || scopedDetail?.metadata || {};
  const field = (...names: string[]) => {
    for (const name of names) {
      const key = Object.keys(meta).find(
        (k) => k === name || k.endsWith(":" + name),
      );
      if (key && meta[key] !== undefined) return String(meta[key]);
    }
    return "";
  };
  async function mutate(path: string, p: unknown, method = "PATCH") {
    if (updateLock.current || a.deletionPending) return false;
    updateLock.current = true;
    setUpdating(true);
    setError("");
    try {
      await api(path, p, method);
      await refresh();
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
      await refresh();
      return false;
    } finally {
      await changed();
      updateLock.current = false;
      setUpdating(false);
    }
  }
  const update = (p: unknown) => mutate("assets/" + a.id, p);
  const start = () => {
    if (modalOpen || updateLock.current || a.deletionPending || !a.motion) return;
    setPlayingAsset(a.id);
  };
  return (
    <div ref={root} className={`viewer aura-viewer ${showInfo ? "with-info" : ""} ${controlsHidden && !showInfo && !showActions && !showVersions ? "controls-hidden" : ""} ${a.kind === "video" || playing ? "has-video" : ""}`} onPointerMove={event => { if (event.pointerType === "mouse" && videoPlaying) activity(); }} role="dialog" aria-modal={!modalOpen} aria-label={`媒体查看器 · ${a.name}`} tabIndex={-1} inert={modalOpen}>
      <div className="viewer-main">
        <header className="viewer-toolbar">
          <IconButton title="关闭查看器（Esc）" disabled={locked} onClick={close}>
            <X size={23} />
          </IconButton>
          <div className="viewer-date">
            <strong>{displayDate(a.capturedAt, true)}</strong>
            <small>{a.name}</small>
          </div>
          <div className="viewer-actions">
            {(catalog.imageVersions > 1 || versions.length > 1) && <button title="切换版本" aria-label="切换版本" aria-expanded={showVersions} className={`icon-button version-toggle ${showVersions ? "active" : ""}`} disabled={locked || !!a.deletionPending} onClick={() => { setShowVersions(!showVersions); setShowActions(false); if (!scopedDetail) void refresh(); activity(); }}>
              <Layers3 size={20} /><small>{versions.length && !versions.some(file => file.hash === a.primary) ? "视频" : `${Math.max(0, versions.findIndex(file => file.hash === a.primary)) + 1}/${versions.length || catalog.imageVersions}`}</small>
            </button>}
            {showVersions && (versions.length ? <VersionPicker files={versions} selected={a.primary} primary={catalog.primary} select={selectVersion} locked={locked} /> : <div className="viewer-version-menu version-pending">{error ? <><p>{error}</p><button onClick={() => void refresh()}>重新加载版本</button></> : <p><LoaderCircle size={16} className="spin" />正在读取版本</p>}</div>)}
            <button title="照片信息（I）" aria-label="照片信息" aria-expanded={showInfo} aria-controls={infoId} className={`icon-button ${showInfo ? "active" : ""}`} disabled={locked} onClick={() => { setShowInfo(!showInfo); setShowActions(false); activity(); }}><InfoIcon size={21} /></button>
            <button title="更多操作" aria-label="更多操作" aria-expanded={showActions} className={`icon-button ${showActions ? "active" : ""}`} disabled={locked} onClick={() => { setShowActions(!showActions); setShowVersions(false); activity(); }}><Ellipsis size={23} /></button>
            {showActions && <div className="viewer-action-menu">
              <button disabled={locked || !!a.trashedAt || !!a.deletionPending} onClick={() => { setShowActions(false); addToAlbum(); }}><ImagePlus size={18} />添加到相片集</button>
              {!a.deletionPending && <a href={`${base}api/assets/${a.id}/download`}><ArrowDownToLine size={18} />下载全部原件</a>}
              <label className="viewer-network-mode"><span>画质与流量</span><select aria-label="画质与流量" value={policy.mode} onChange={event => setMediaMode(event.target.value as MediaMode)}><option value="auto">自动</option><option value="save">节省流量</option><option value="quality">优先清晰</option></select></label>
              <button className="viewer-menu-delete" disabled={locked || !!a.deletionPending} onClick={async () => {
                if (await update({ trash: !a.trashedAt })) { notify(a.trashedAt ? "已恢复" : "已移入最近删除"); close(); }
              }}>{a.deletionPending ? <LoaderCircle className="spin" size={18} /> : a.trashedAt ? <RefreshCw size={18} /> : <Trash2 size={18} />}{a.deletionPending ? "正在永久删除" : a.trashedAt ? "恢复" : "移入最近删除"}</button>
              {a.trashedAt && permanentDeleteEnabled && !a.deletionPending && <button className="viewer-menu-delete" disabled={locked} onClick={() => { setShowActions(false); permanentlyDelete([a]); }}><Trash2 size={18} />永久删除</button>}
            </div>}
          </div>
        </header>
        <div className="viewer-stage">
          <button
            className="viewer-prev"
            onClick={goPrevious}
            disabled={locked || !hasPrevious}
            aria-label="上一张"
            title="上一张（←）"
          >
            <ChevronLeft />
          </button>
          {a.kind === "video" || playing ? <div className="media-stage">
            <VideoPlayer key={`${a.id}:${playing ? a.motion : a.primary}`} asset={a} live={playing} locked={locked} previous={goPrevious} next={goNext} close={close} toggleChrome={() => setControlsHidden(value => !value)} activity={activity} onPlayback={value => { setVideoPlaying(value); if (!value) setControlsHidden(false); }} onEnded={playing ? () => setPlayingAsset(undefined) : undefined} />
          </div> : <PhotoSurface key={`${a.id}:${a.primary}`} asset={a} locked={locked} previous={goPrevious} next={goNext} close={() => { if (showInfo) setShowInfo(false); else close(); }} toggleChrome={() => setControlsHidden(value => !value)} hasPrevious={hasPrevious} hasNext={hasNext} onReady={() => setReadyAsset(`${a.id}:${a.primary}`)} />}
          <button className="viewer-next" onClick={goNext} disabled={locked || !hasNext} aria-label="下一张" title="下一张（→）">
            <ChevronRight />
          </button>
        </div>
        <footer className="viewer-footer">
          <div className="viewer-status-row">
            {items && index >= 0 && <span className="viewer-position" role="status" aria-live="polite" aria-atomic="true" aria-label={`已加载 ${items.length} 项，第 ${index + 1} 项`} title="当前已加载的照片">
              <strong>{index + 1}</strong><span aria-hidden="true">/</span><span>{items.length}</span>
            </span>}
            {a.deletionPending && <span className="viewer-deletion-pending"><LoaderCircle className="spin" size={14} />正在永久删除，清理完成后会从图库移除</span>}
            {a.kind === "live" && (
              <button
                className={`live-control ${playing ? "playing" : ""}`}
                disabled={locked || !!a.deletionPending || !a.motion}
                aria-pressed={playing}
                onClick={() => (playing ? setPlayingAsset(undefined) : start())}
              >
                <LivePhotoIcon size={18} />
                {playing ? "停止播放" : "播放实况"}
              </button>
            )}
          </div>
          {nearby.length > 1 && <nav ref={filmstrip} className="viewer-filmstrip" aria-label="附近照片">
            {nearby.map((item, offset) => <button
              key={item.id}
              className={`viewer-thumbnail ${item.id === a.id ? "is-active" : ""}`}
              aria-label={`第 ${stripStart + offset + 1} 项：${item.name}`}
              aria-current={item.id === a.id ? "true" : undefined}
              title={item.name}
              disabled={locked}
              onClick={() => { if (!modalOpen && !updateLock.current && item.id !== a.id) openAsset?.(item); }}
            >
              <ViewerThumbnail key={item.primary} asset={item} />
            </button>)}
          </nav>}
        </footer>
      </div>
      {showInfo && (
        <aside id={infoId} className="info-panel" aria-label="照片信息">
          <div className="info-title">
            <h2>照片信息</h2>
            <IconButton title="关闭信息（Esc）" disabled={locked} onClick={() => setShowInfo(false)}>
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
          {a.grouping && <div className="metadata-summary">
            <div><Layers3 size={19} /><span>
              <strong>{a.grouping === "manual" ? "手动归并" : "自动组合的照片版本"}</strong>
              <small>{a.imageVersions} 个照片版本</small>
            </span></div>
          </div>}
          <PhotoEdits records={scopedDetail?.edits || []} file={primary} />
          <div className="originals">
            <h3>
              原始资源 <span>{scopedDetail?.files.length || a.variants}</span>
            </h3>
            {scopedDetail?.files.map((f) => (
              <div className="original" key={f.hash}>
                <div className="original-header">
                  <span className="file-type">
                    {f.mime.startsWith("video/") ? (
                      <Video size={19} />
                    ) : f.mime.startsWith("image/") ? (
                      <ImageIcon size={19} />
                    ) : (
                      <FileText size={19} />
                    )}
                  </span>
                  <div>
                    <strong>{f.name}</strong>
                    <small>
                      {resourceLabel(f)} · {bytes(f.size)}
                      {f.hash === a.primary ? " · 当前查看" : ""}
                      {f.hash === catalog.primary
                        ? " · 主版本"
                        : f.hash === a.motion
                          ? " · 实况视频"
                          : ""}
                    </small>
                  </div>
                  {!a.deletionPending && <a
                    title="下载此原件"
                    aria-label={`下载原件：${f.name}`}
                    className="icon-button"
                    href={media(f.hash, "original")}
                  >
                    <ArrowDownToLine size={16} />
                  </a>}
                </div>
                <div className="original-actions">
                  {(f.mime.startsWith("image/") || f.mime.startsWith("video/")) && f.hash !== a.primary && <button disabled={locked || !!a.deletionPending} onClick={() => selectVersion(f.hash)}>查看此版本</button>}
                  {f.hash !== catalog.primary && f.mime.startsWith("image/") && (
                    <button disabled={locked || !!a.deletionPending} onClick={() => void update({ primary: f.hash })}>
                      设为主版本
                    </button>
                  )}
                  {scopedDetail.files.length > 1 && (
                    <button
                      disabled={locked || !!a.deletionPending}
                      onClick={async () => {
                        if (await mutate(`assets/${a.id}/split`, { hash: f.hash }, "POST")) notify("已分离为独立项目");
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
