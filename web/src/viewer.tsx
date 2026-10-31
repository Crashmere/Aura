import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, CalendarDays, ChevronLeft, ChevronRight, Image as ImageIcon, ImagePlus, Info as InfoIcon, LoaderCircle, RefreshCw, ScanLine, Trash2, Video, Wifi, X } from "lucide-react";
import { api, Asset, Detail, base, media, bytes, displayDate } from "./api";
import { LivePhotoIcon } from "./live-photo-icon";
import { useImageGestures } from "./image-gestures";
import { IconButton } from "./controls";
import "./viewer.css";

function ViewerMedia({ asset, attempt, motionAttempt, playing, transform, locked, retry, stopMotion, motionFailed }: {
  asset: Asset;
  attempt: number;
  motionAttempt: number;
  playing: boolean;
  transform: { x: number; y: number; scale: number };
  locked: boolean;
  retry: () => void;
  stopMotion: () => void;
  motionFailed: () => void;
}) {
  // The parent keys this component by asset, resource and retry, isolating late media events.
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [motionReady, setMotionReady] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const motionVideo = useRef<HTMLVideoElement>(null);
  const motionFailureReported = useRef(false);
  const source = media(asset.primary, asset.kind === "video" ? "play" : "preview") + (attempt ? `?retry=${attempt}` : "");
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth) setReady(true);
  }, []);
  useEffect(() => { setMotionReady(false); }, [playing, motionAttempt]);
  function failMotion() {
    if (motionFailureReported.current) return;
    motionFailureReported.current = true;
    motionFailed();
  }
  useEffect(() => {
    let active = true;
    motionFailureReported.current = false;
    const element = motionVideo.current;
    if (playing && element) {
      void element.play().catch(() => { if (active) failMotion(); });
    }
    return () => { active = false; element?.pause(); };
  }, [playing, motionAttempt, asset.motion]);
  useEffect(() => {
    if (!failed) return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [failed, retry]);
  const loading = !failed && (!ready || (playing && !motionReady));
  return <>
    {asset.kind === "video" ? <video
      className={`viewer-media ${ready && !failed ? "is-ready" : ""}`}
      src={source}
      controls
      playsInline
      preload="metadata"
      poster={media(asset.primary)}
      aria-label={asset.name}
      onLoadedMetadata={() => setReady(true)}
      onError={() => setFailed(true)}
    /> : <>
      <img
        ref={image}
        className={`viewer-media ${ready && !failed ? "is-ready" : ""}`}
        src={source}
        alt={asset.name}
        decoding="async"
        draggable={false}
        style={{
          visibility: playing && motionReady ? "hidden" : "visible",
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          cursor: transform.scale > 1 ? "grab" : "zoom-in",
        }}
        onLoad={() => setReady(true)}
        onError={() => setFailed(true)}
      />
      {asset.motion && playing && <video
        key={motionAttempt}
        ref={motionVideo}
        className={`live-video viewer-media ${motionReady ? "is-ready" : ""}`}
        src={media(asset.motion, "play") + `?retry=${motionAttempt}`}
        aria-label={`${asset.name} · 实况视频`}
        playsInline
        controls
        onLoadedData={() => setMotionReady(true)}
        onEnded={stopMotion}
        onError={failMotion}
      />}
    </>}
    {loading && <div className="viewer-loading" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
      <span>{playing ? "正在加载实况" : ["queued", "processing"].includes(asset.status) ? "正在生成预览" : "正在加载"}</span>
    </div>}
    {failed && <div className="viewer-fallback" role="status">
      <ImageIcon size={36} strokeWidth={1.4} aria-hidden="true" />
      <p>{asset.deletionPending ? "正在永久删除，预览暂不可用" : asset.status === "error" ? "预览处理失败" : ["queued", "processing"].includes(asset.status) ? "正在生成预览" : "预览加载失败"}</p>
      <div className="viewer-retry-actions">
        <button className="button" disabled={locked || !!asset.deletionPending} onClick={retry}>重新加载预览</button>
        {!asset.deletionPending && <a className="button" href={media(asset.primary, "original")}>下载原件</a>}
      </div>
    </div>}
  </>;
}

function ViewerThumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  return <>
    {failed ? <ImageIcon size={18} aria-hidden="true" /> : <img src={media(asset.primary)} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} />}
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
    [previewAttempt, setPreviewAttempt] = useState(0),
    [motionAttempt, setMotionAttempt] = useState(0),
    [updating, setUpdating] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const filmstrip = useRef<HTMLElement>(null);
  const infoId = useId();
  const currentAsset = useRef(asset.id);
  currentAsset.current = asset.id;
  const request = useRef(0);
  const updateLock = useRef(false);
  function refresh() {
    const key = ++request.current;
    const id = asset.id;
    return api<Detail>("assets/" + id)
      .then(data => { if (currentAsset.current === id && request.current === key) setDetail(data); })
      .catch(e => { if (currentAsset.current === id && request.current === key) setError(e instanceof Error ? e.message : String(e)); });
  }
  useEffect(() => {
    setDetail(undefined);
    setPlayingAsset(undefined);
    setError("");
    setPreviewAttempt(0);
    void refresh();
    return () => { ++request.current; };
  }, [asset.id]);
  const scopedDetail = detail?.asset.id === asset.id ? detail : undefined;
  const a = scopedDetail?.asset || asset,
    primary = scopedDetail?.files.find((f) => f.hash === a.primary);
  const playing = playingAsset === a.id;
  const index = items?.findIndex(item => item.id === a.id) ?? -1;
  const before = index > 0 ? items?.[index - 1] : undefined;
  const after = index >= 0 ? items?.[index + 1] : undefined;
  const hasPrevious = items === undefined || !!before;
  const hasNext = items === undefined || !!after;
  const locked = updating || modalOpen;
  const stripStart = Math.max(0, Math.min(index - 3, (items?.length ?? 0) - 7));
  const nearby = index >= 0 && openAsset ? items?.slice(stripStart, stripStart + 7) ?? [] : [];
  function goPrevious() {
    if (modalOpen || updateLock.current || !hasPrevious) return;
    if (before && openAsset) openAsset(before); else previous();
  }
  function goNext() {
    if (modalOpen || updateLock.current || !hasNext) return;
    if (after && openAsset) openAsset(after); else next();
  }
  const gestures = useImageGestures(`${a.id}:${a.primary}`, a.kind !== "video" && !playing && !locked && !a.deletionPending, goPrevious, goNext);
  const beforePreview = before && !before.deletionPending ? media(before.primary, before.kind === "video" ? "thumb" : "preview") : undefined;
  const afterPreview = after && !after.deletionPending ? media(after.primary, after.kind === "video" ? "thumb" : "preview") : undefined;
  useEffect(() => {
    const previews = [...new Set([beforePreview, afterPreview].filter((src): src is string => !!src))].map(src => {
      const image = new Image();
      image.decoding = "async";
      image.fetchPriority = "low";
      image.src = src;
      return image;
    });
    return () => previews.forEach(image => image.removeAttribute("src"));
  }, [beforePreview, afterPreview]);
  useEffect(() => {
    const strip = filmstrip.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !selected) return;
    const center = () => {
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
      if (!["Escape", "ArrowLeft", "ArrowRight", "i"].includes(e.key)) return;
      e.preventDefault();
      if (updateLock.current) return;
      if (e.key === "ArrowLeft") goPrevious();
      if (e.key === "ArrowRight") goNext();
      if (!e.repeat && e.key === "Escape") { if (showInfo) setShowInfo(false); else close(); }
      if (!e.repeat && e.key === "i") setShowInfo(value => !value);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previous, next, openAsset, before, after, hasPrevious, hasNext, modalOpen, close, showInfo]);
  const meta = scopedDetail?.metadata || {};
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
    setMotionAttempt(n => n + 1);
    setPlayingAsset(a.id);
  };
  return (
    <div ref={root} className={`viewer aura-viewer ${showInfo ? "with-info" : ""}`} role="dialog" aria-modal={!modalOpen} aria-label={`照片查看器 · ${a.name}`} tabIndex={-1} inert={modalOpen}>
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
            <IconButton title="添加到相片集" disabled={locked || !!a.trashedAt || !!a.deletionPending} onClick={addToAlbum}>
              <ImagePlus size={20} />
            </IconButton>
            {!a.deletionPending && <a
              className="icon-button"
              title="下载全部原件"
              aria-label="下载全部原件"
              href={`${base}api/assets/${a.id}/download`}
            >
              <ArrowDownToLine size={21} />
            </a>}
            <button
              title="照片信息（I）"
              aria-label="照片信息"
              aria-expanded={showInfo}
              aria-controls={infoId}
              className={`icon-button ${showInfo ? "active" : ""}`}
              disabled={locked}
              onClick={() => setShowInfo(!showInfo)}
            >
              <InfoIcon size={21} />
            </button>
            <IconButton
              title={a.deletionPending ? "正在永久删除" : a.trashedAt ? "恢复" : "移入最近删除"}
              disabled={locked || !!a.deletionPending}
              onClick={async () => {
                if (await update({ trash: !a.trashedAt })) {
                  notify(a.trashedAt ? "已恢复" : "已移入最近删除");
                  close();
                }
              }}
            >
              {a.deletionPending ? <LoaderCircle className="spin" size={20} /> : a.trashedAt ? <RefreshCw size={20} /> : <Trash2 size={20} />}
            </IconButton>
            {a.trashedAt && permanentDeleteEnabled && !a.deletionPending && <IconButton title="永久删除" className="permanent-delete-action" disabled={locked} onClick={() => permanentlyDelete([a])}><Trash2 size={20} /></IconButton>}
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
          <div className={`media-stage ${a.kind !== "video" && !playing ? "image-gesture-stage" : ""}`} {...gestures.handlers}>
            <ViewerMedia
              key={`${a.id}:${a.primary}:${a.status}:${previewAttempt}`}
              asset={a}
              attempt={previewAttempt}
              motionAttempt={motionAttempt}
              playing={playing}
              transform={gestures.transform}
              locked={locked}
              retry={() => {
                if (modalOpen || updateLock.current || a.deletionPending) return;
                setPreviewAttempt(n => n + 1);
                void refresh();
              }}
              stopMotion={() => { if (currentAsset.current === a.id) setPlayingAsset(undefined); }}
              motionFailed={() => {
                if (currentAsset.current !== a.id) return;
                setPlayingAsset(undefined);
                notify("实况预览加载失败，请重试或下载视频原件", true);
              }}
            />
          </div>
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
            {gestures.transform.scale > 1 && <button className="live-control" disabled={locked} onClick={gestures.reset}>还原大小</button>}
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
            {a.width > 0 && a.height > 0 && <span className="viewer-dimensions">
              {a.width} × {a.height}
              {primary?.mime
                ? " · " + primary.mime.replace("image/", "").replace("video/", "").toUpperCase()
                : ""}
            </span>}
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
                  {f.hash !== a.primary && f.mime.startsWith("image/") && (
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
