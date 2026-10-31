import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Check,
  Image as ImageIcon,
  Layers3,
  Video,
  RefreshCw,
  LoaderCircle,
} from "lucide-react";
import { Asset, media } from "./api";
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
  const source = media(asset.primary) + (attempt ? `?retry=${attempt}` : "");
  useEffect(() => { setBroken(false); }, [asset.primary, asset.status]);
  useEffect(() => { setLoaded(!!image.current?.complete && !!image.current?.naturalWidth); }, [source]);
  useEffect(() => {
    if (!broken) return;
    const retry = () => { setAttempt(n => n + 1); setBroken(false); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [broken]);
  return (
    <div className={`photo ${selected ? "selected" : ""} ${selecting ? "selecting" : ""} ${loaded || broken ? "is-ready" : "is-loading"}`}>
      <button className="photo-open" disabled={disabled} onClick={onClick} aria-label={selecting ? `${selected ? "取消选择" : "选择"} ${asset.name}` : `查看 ${asset.name}`}>
        {!broken ? (
          <img
            ref={image}
            key={source}
            src={source}
            onLoad={() => setLoaded(true)}
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
        {asset.kind === "video" && (
          <span className="photo-kind">
            <Video size={14} />
          </span>
        )}
        {asset.variants > 1 && asset.kind !== "live" && !asset.deletionPending && (
          <span className="photo-versions">
            <Layers3 size={13} />
            {asset.variants}
          </span>
        )}
        {asset.deletionPending && <span className="photo-deletion-pending"><LoaderCircle className="spin" size={13} />清理中</span>}
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
