import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  Check,
  Image as ImageIcon,
  Layers3,
  Video,
  RefreshCw,
  LoaderCircle,
} from "lucide-react";
import { Asset, media, timestamp } from "./api";
import { preloadPreviews, cancelPreloads } from "./media-loading";
import { LivePhotoIcon } from "./live-photo-icon";

export function Photo({
  asset,
  onClick,
  selected = false,
  selecting = false,
  select,
  disabled = false,
}: {
  asset: Asset;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  selected?: boolean;
  selecting?: boolean;
  select?: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [previewAspect, setPreviewAspect] = useState<{ source: string; ratio: number } | null>(null);
  const source = media(asset.primary) + (attempt ? `?retry=${attempt}` : "");
  // Decoded previews include EXIF rotation; catalog dimensions can precede it.
  const ratio = previewAspect?.source === source ? previewAspect.ratio : asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1;
  const geometry = {
    "--photo-natural-width": `${Math.min(1, ratio) * 100}%`,
    "--photo-natural-height": `${Math.min(1, 1 / ratio) * 100}%`,
    "--photo-crop-scale": Math.max(ratio, 1 / ratio),
  } as CSSProperties;
  useEffect(() => { setBroken(false); }, [asset.primary, asset.status]);
  useEffect(() => { setLoaded(!!image.current?.complete && !!image.current?.naturalWidth); }, [source]);
  useEffect(() => {
    if (!broken) return;
    const retry = () => { setAttempt(n => n + 1); setBroken(false); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [broken]);
  return (
    <div style={geometry} className={`photo ${selected ? "selected" : ""} ${selecting ? "selecting" : ""} ${loaded || broken ? "is-ready" : "is-loading"}`}>
      <button className="photo-open" disabled={disabled} onPointerEnter={event => { if (event.pointerType === "mouse" && !selecting && !disabled) preloadPreviews([asset], 180); }} onPointerLeave={cancelPreloads} onPointerDown={() => { if (!selecting && !disabled) preloadPreviews([asset], 0); }} onClick={onClick} aria-label={selecting ? `${selected ? "取消选择" : "选择"} ${asset.name}` : `查看 ${asset.name}`}>
        <div className="photo-frame">
          {!broken ? (
            <img
              ref={image}
              key={source}
              src={source}
              onLoad={event => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth && naturalHeight) setPreviewAspect({ source, ratio: naturalWidth / naturalHeight });
                setLoaded(true);
              }}
              className={loaded ? "is-loaded" : ""}
              alt={asset.name}
              loading="lazy"
              decoding="async"
              onError={() => setBroken(true)}
            />
          ) : (
            <div className="photo-missing">
              <ImageIcon />
              <span>
                {asset.status === "error" ? "预览处理失败" : ["queued", "processing"].includes(asset.status) ? "正在生成预览" : "预览加载失败"}
              </span>
            </div>
          )}
          <div className="photo-shade" />
          {asset.kind === "live" && (
            <span className="photo-kind">
              <LivePhotoIcon size={13} />
              实况
            </span>
          )}
          {asset.kind === "video" && !asset.duration && (
            <span className="photo-kind">
              <Video size={14} />
            </span>
          )}
          {asset.kind === "video" && !!asset.duration && (
            <span className="photo-duration">{timestamp(asset.duration)}</span>
          )}
          {asset.variants > 1 && asset.kind !== "live" && !asset.deletionPending && (
            <span className="photo-versions">
              <Layers3 size={13} />
              {asset.variants}
            </span>
          )}
          {asset.deletionPending && <span className="photo-deletion-pending"><LoaderCircle className="spin" size={13} />清理中</span>}
        </div>
      </button>
      {broken && (
        <button
          className="photo-retry"
          aria-label="重新加载预览"
          title="重新加载预览"
          onClick={() => { setAttempt(n => n + 1); setBroken(false); }}
        >
          <RefreshCw size={14} />
          重试
        </button>
      )}
      {select && (
        <button
          className={`select-photo ${selected ? "checked" : ""}`}
          aria-label={`${selected ? "取消选择" : "选择照片"} ${asset.name}`}
          aria-pressed={selected}
          disabled={disabled || !!asset.deletionPending}
          onClick={select}
        >
          {selected && <Check size={15} />}
        </button>
      )}
    </div>
  );
}
