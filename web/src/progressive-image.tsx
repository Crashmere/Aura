import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { type Asset, media } from "./api";
import { cachedPreviewSource, previewReady, rememberPreview, useMediaPolicy } from "./media-loading";
import { displayDimensions, normalizeRotation, useRotationPreview } from "./rotation-preview";

export function ProgressiveImage({ asset, zoomed = false, rotationPreview = 0, onReady }: { asset: Asset; zoomed?: boolean; rotationPreview?: number; onReady: () => void }) {
  const policy = useMediaPolicy();
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const rotationStyle = useRotationPreview(frame, rotationPreview);
  const dimensions = displayDimensions({ ...asset, rotation: normalizeRotation((asset.rotation || 0) + rotationPreview) });
  const [initialSource] = useState(() => cachedPreviewSource(media(asset.primary, "preview", asset.rotation, asset.cover?.revision)) || media(asset.primary, "preview", asset.rotation, asset.cover?.revision));
  const preview = attempt ? media(asset.primary, "preview", asset.rotation, asset.cover?.revision) + `&retry=${attempt}` : initialSource;
  const [ready, setReady] = useState(() => previewReady(preview));
  useEffect(() => { if (ready) onReady(); }, [ready]);
  const highQuality = !policy.economy || requested || zoomed;
  const [load, setLoad] = useState(ready);
  useEffect(() => {
    if (!highQuality) return;
    // Rapid filmstrip/arrow navigation should not start a full preview for every intermediate item.
    const timer = setTimeout(() => setLoad(true), previewReady(preview) ? 0 : 90);
    return () => clearTimeout(timer);
  }, [highQuality, preview]);
  useEffect(() => {
    if (!failed && !thumbFailed) return;
    const retry = () => { setAttempt(Date.now()); setFailed(false); setThumbFailed(false); setLoad(true); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [failed, thumbFailed]);
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth) { setReady(true); rememberPreview(element); }
  }, [load, preview]);
  return <>
    <div ref={frame} className="viewer-image-frame" role="img" aria-label={asset.name} data-image-width={dimensions.width} data-image-height={dimensions.height}>
      {!thumbFailed && <img className="viewer-image-placeholder" style={rotationStyle} src={media(asset.primary, "thumb", asset.rotation, asset.cover?.revision) + (attempt ? `&retry=${attempt}` : "")} alt="" aria-hidden="true" decoding="async" draggable={false} onError={() => setThumbFailed(true)} />}
      {load && <img ref={image} className={`viewer-image-detail ${ready ? "is-ready" : ""}`} style={rotationStyle} src={preview} alt="" aria-hidden="true" decoding="async" fetchPriority="high" draggable={false}
        onLoad={async event => {
          const element = event.currentTarget;
          try { await element.decode(); } catch { /* A successful load remains displayable. */ }
          if (image.current !== element) return;
          rememberPreview(element); setReady(true); setFailed(false);
        }} onError={() => { setFailed(true); setReady(false); }} />}
    </div>
    {!ready && load && !failed && <div className="viewer-image-loading" role="status"><LoaderCircle size={16} className="spin" /><span>正在加载清晰图</span></div>}
    {!ready && (failed || !highQuality || thumbFailed) && <div className="viewer-quality-action">
      <button disabled={!!asset.deletionPending} onClick={() => { setRequested(true); setLoad(true); if (failed || thumbFailed) setAttempt(Date.now()); setFailed(false); setThumbFailed(false); }}>
        {failed || thumbFailed ? <><RefreshCw size={14} />重新加载</> : "载入清晰图"}
      </button>
    </div>}
  </>;
}
