import { useEffect, useState } from "react";
import {
  Check,
  Image as ImageIcon,
  Layers3,
  Video,
  RefreshCw,
} from "lucide-react";
import { Asset, media } from "./api";
import { LivePhotoIcon } from "./live-photo-icon";

export function Photo({
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
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setBroken(false), [asset]);
  useEffect(() => {
    if (!broken) return;
    const retry = () => { setAttempt(n => n + 1); setBroken(false); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [broken]);
  return (
    <div className={`photo ${selected ? "selected" : ""}`}>
      <button className="photo-open" onClick={onClick} aria-label={asset.name}>
        {!broken ? (
          <img
            src={media(asset.primary) + (attempt ? `?retry=${attempt}` : "")}
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
        {asset.variants > 1 && asset.kind !== "live" && (
          <span className="photo-versions">
            <Layers3 size={13} />
            {asset.variants}
          </span>
        )}
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
          aria-label={selected ? "取消选择" : "选择照片"}
          aria-pressed={selected}
          onClick={select}
        >
          {selected && <Check size={15} />}
        </button>
      )}
    </div>
  );
}
