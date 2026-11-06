import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { base, timestamp, type Asset } from "./api";

function FrameThumbnail({ source }: { source: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <ImageIcon size={18} /> : <img src={source} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} />;
}

export function FrameStrip({ asset, time, duration, locked, seek }: { asset: Asset; time: number; duration: number; locked: boolean; seek: (time: number) => void }) {
  const rate = (asset.kind === "live" ? asset.motionFrameRate : asset.frameRate) || 30;
  const end = Math.max(0, duration - .5 / rate);
  const source = asset.kind === "live" ? asset.motion! : asset.primary;
  const frames = Array.from({ length: 7 }, (_, index) => end * index / 6);
  const progress = end ? Math.min(100, time / end * 100) : 0;
  return <div className="frame-strip" role="group" aria-label="缩略帧时间轴">
    {frames.map((value, index) => {
      const query = new URLSearchParams({ hash: asset.primary, motion: source, time: value.toFixed(6), rotation: String(asset.rotation || 0), size: "thumb" });
      return <button key={index} disabled={locked || !duration} aria-label={`选择 ${timestamp(value)} 的帧`} title={`${value.toFixed(3)} 秒`} onClick={() => seek(value)}>
        {duration > 0 && <FrameThumbnail key={query.toString()} source={`${base}api/assets/${asset.id}/frame?${query}`} />}
      </button>;
    })}
    {duration > 0 && <span className="frame-strip-position" style={{ left: `${progress}%` }} aria-hidden="true" />}
  </div>;
}
