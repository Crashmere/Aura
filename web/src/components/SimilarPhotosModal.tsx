import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Columns2, Copy, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import { buildMediaUrl, requestJson } from "../core/client";
import { useIsPresent, useSlidingIndicator } from "../core/motion";
import { usePageScrollLock } from "../core/photo-view";
import type { AssetSimilarPage, CandidatePair, CatalogAsset, SimilarityScoreRange } from "../core/types";
import { PhotoTile } from "./TimelineCanvas";
import { SimilarityScoreFilter } from "./SimilarityScoreFilter";
import { CurrentAlbumContext } from "./AssetAlbumBadges";

function SimilarPhotoSection({
  asset, source, active, album, outsideAlbums, refreshSeq, onOpenAsset, onCompare,
}: {
  asset: CatalogAsset;
  source: "dhash" | "dino";
  active: boolean;
  album: string;
  outsideAlbums: boolean;
  refreshSeq: number;
  onOpenAsset: (target: CatalogAsset) => void;
  onCompare: (target: CatalogAsset, evidence?: CandidatePair) => void;
}) {
  const isPresent = useIsPresent();
  const video = asset.kind === "video";
  const mediaName = video ? "视频" : "照片";
  const [scoreRange, setScoreRange] = useState<SimilarityScoreRange>([.7, 1]);
  const scope = `${asset.id}:${asset.primary}:${source}:${album}:${outsideAlbums}:${refreshSeq}:${scoreRange.join(":")}`;
  const [page, setPage] = useState<(AssetSimilarPage & { scope: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const stale = page?.scope !== scope;

  async function fetchPage(cursor = "") {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ source, limit: "24" });
    if (outsideAlbums) query.set("outsideAlbums", "true");
    if (album) query.set("album", album);
    if (cursor) query.set("cursor", cursor);
    if (source === "dino") {
      query.set("minScore", String(scoreRange[0]));
      query.set("maxScore", String(scoreRange[1]));
    }
    try {
      const result = await requestJson<AssetSimilarPage>(
        `assets/${asset.id}/similar?${query}`, undefined, undefined, controller.signal,
      );
      if (controller.signal.aborted) return;
      setPage(previous => {
        if (!cursor || previous?.scope !== scope) return { ...result, scope };
        const seen = new Set(previous.items.map(pair => pair.left === asset.id ? pair.right : pair.left));
        return {
          ...result,
          scope,
          items: [...previous.items, ...result.items.filter(pair => !seen.has(pair.left === asset.id ? pair.right : pair.left))],
          assets: { ...previous.assets, ...result.assets },
        };
      });
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }
    if (page?.scope !== scope) void fetchPage();
    return () => requestRef.current?.abort();
  }, [active, asset.id, asset.primary, source, album, outsideAlbums, refreshSeq, scoreRange]);

  const dinoState = page?.index?.state;
  const indexNote = source !== "dino" && !video ? "" :
    dinoState === "disabled" ? "智能推荐已暂停" :
    dinoState === "unavailable" ? "智能推荐暂不可用" :
    dinoState && dinoState !== "idle" ? "智能推荐索引更新中，可刷新查看新结果" : "";

  return (
    <section className="asset-similar-section" role="tabpanel" id={`asset-similar-panel-${source}`}
      aria-labelledby={`asset-similar-tab-${source}`} hidden={!active} aria-busy={loading}>
      <header>
        <p className="asset-similar-method">{source === "dhash" ? (video ? "dHash · 多帧时序" : "dHash · 图像指纹") : (video ? "DINO · 多帧视觉特征" : "DINO · 视觉特征")}</p>
        {!stale && <span className="asset-similar-count">{page.total} {video ? "条" : "张"}</span>}
      </header>
      {source === "dino" && <SimilarityScoreFilter range={scoreRange} disabled={!isPresent}
        onChange={setScoreRange} />}
      {indexNote && !stale && <p className="asset-similar-status">{indexNote}</p>}
      {loading && <p className="loading-inline" role="status"><LoaderCircle size={16} className="spin" />正在查找相似{mediaName}</p>}
      {error && <div className="asset-similar-error" role="alert">
        <span>{error}</span>
        <button className="btn" type="button" disabled={loading || !isPresent}
          onClick={() => void fetchPage(stale ? "" : page?.next)}>重试</button>
      </div>}
      {page && <div className={`asset-similar-grid ${stale ? "is-stale" : ""}`}>
        {page.items.map(pair => {
          const target = page.assets[pair.left === asset.id ? pair.right : pair.left];
          if (!target) return null;
          return <article className="asset-similar-card" key={target.id}>
            <PhotoTile asset={target} originalAspect disabled={stale || !isPresent}
              onClick={() => onOpenAsset(target)} />
            <div className="asset-similar-card-actions">
              <span>{video ? `抽样帧匹配率 ${((pair.coverage || 0) * 100).toFixed(0)}%` :
                source === "dhash" ? `指纹距离 ${pair.distance}` : `特征相似度 ${(100 * Math.min(1, pair.score || 0)).toFixed(1)}%`}</span>
              <button className="icon-btn" type="button" title={`与当前${mediaName}对比`} aria-label={`与 ${target.name} 对比`}
                disabled={stale || !isPresent} onClick={() => onCompare(target, pair)}><Columns2 size={16} /></button>
            </div>
          </article>;
        })}
      </div>}
      {!stale && !loading && !error && !page.items.length && <p className="asset-similar-empty">
        {source === "dino" && (scoreRange[0] > .7 || scoreRange[1] < 1) ? `未找到符合相似度范围的${mediaName}` :
          outsideAlbums ? `未找到所在相片集之外的相似${mediaName}` : `未找到相似${mediaName}`}
      </p>}
      {!stale && page.next && !error && <button className="btn asset-similar-more" type="button"
        disabled={loading || !isPresent} onClick={() => void fetchPage(page.next)}>
        {loading ? "正在加载" : "加载更多"}
      </button>}
    </section>
  );
}

export function SimilarPhotosModal({ asset, currentAlbumId, initialSource = "dhash", onClose, onOpenAsset, onCompare }: {
  asset: CatalogAsset;
  currentAlbumId?: string;
  initialSource?: "dhash" | "dino";
  onClose: () => void;
  onOpenAsset: (target: CatalogAsset) => void;
  onCompare: (target: CatalogAsset, evidence?: CandidatePair) => void;
}) {
  const isPresent = useIsPresent();
  const video = asset.kind === "video";
  const mediaName = video ? "视频" : "照片";
  const rootRef = useRef<HTMLElement>(null);
  const [source, setSource] = useState(initialSource);
  const tabsIndicator = useSlidingIndicator(source, '[aria-selected="true"]');
  const [outsideAlbums, setOutsideAlbums] = useState(false);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const currentAlbum = asset.albums?.find(item => item.id === currentAlbumId);
  const albums = asset.albums || [];
  const filterAlbums = currentAlbum ? [currentAlbum] : albums;

  usePageScrollLock();

  useEffect(() => {
    const previous = document.activeElement;
    const root = rootRef.current;
    root?.focus({ preventScroll: true });
    return () => {
      if ((document.activeElement === document.body || root?.contains(document.activeElement)) &&
        previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPresent || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return createPortal(
    <CurrentAlbumContext value="">
    <div className="modal-scrim asset-similar-scrim" inert={!isPresent} aria-hidden={!isPresent || undefined}
      onClick={onClose}>
      <section className="modal-card asset-similar-modal" role="dialog" aria-modal="true"
        aria-labelledby="asset-similar-title" ref={rootRef} tabIndex={-1} onClick={event => event.stopPropagation()}>
        <header className="modal-header">
          <h2 id="asset-similar-title"><Sparkles size={18} />相似{mediaName}</h2>
          <div className="asset-similar-header-actions">
            <button className="icon-btn" type="button" title={`刷新相似${mediaName}`} aria-label={`刷新相似${mediaName}`}
              onClick={() => setRefreshSeq(value => value + 1)}><RefreshCw size={17} /></button>
            <button className="icon-btn" type="button" aria-label={`关闭相似${mediaName}`} onClick={onClose}><X size={19} /></button>
          </div>
        </header>
        <div className="asset-similar-reference">
          <img src={buildMediaUrl(asset.primary, "thumb", asset.rotation, asset.cover?.revision)} alt="" />
          <div><strong>{asset.name}</strong><span title={albums.map(item => item.name).join("、")}>
            {albums.length ? albums.map(item => item.name).join("、") : "不属于任何相片集"}
          </span></div>
          <label className="asset-similar-filter">
            <span>排除所在相片集{mediaName}</span>
            <input type="checkbox" role="switch" checked={outsideAlbums} disabled={!filterAlbums.length}
              onChange={event => setOutsideAlbums(event.target.checked)} />
            <span className="asset-similar-switch" aria-hidden="true" />
          </label>
        </div>
        <div className="similar-tabs asset-similar-tabs motion-tabs" role="tablist" aria-label="相似类型"
          ref={tabsIndicator.ref} style={tabsIndicator.style}>
          {(["dhash", "dino"] as const).map(item => <button key={item} type="button" role="tab"
            id={`asset-similar-tab-${item}`} aria-controls={`asset-similar-panel-${item}`}
            aria-selected={source === item} className={source === item ? "active" : ""}
            onClick={() => setSource(item)}>
            {item === "dhash" ? <Copy size={16} /> : <Sparkles size={16} />}
            {item === "dhash" ? (video ? "近似版本" : "算法判定") : (video ? "内容相似" : "智能推荐")}
          </button>)}
        </div>
        <div className="modal-body asset-similar-results">
          {(["dhash", "dino"] as const).map(item => <SimilarPhotoSection key={item}
            asset={asset} source={item} active={source === item} album={currentAlbum?.id || ""} outsideAlbums={outsideAlbums}
            refreshSeq={refreshSeq} onOpenAsset={onOpenAsset} onCompare={onCompare} />)}
        </div>
      </section>
    </div>
    </CurrentAlbumContext>, document.body,
  );
}
