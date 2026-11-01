import { FileText, Layers3 } from "lucide-react";
import { type Asset, type EditRecord, type Original, media, resourceLabel } from "./api";

export function versionAsset(asset: Asset, file: Original, files: Original[]): Asset {
  const videos = files.filter(candidate => candidate.mime.startsWith("video/"));
  let paired = file.contentId ? videos.filter(candidate => candidate.contentId === file.contentId) : [];
  if (!file.contentId && file.hints.sourceKey) {
    const role = file.hints.resourceType === "originalPhoto" ? "originalPairedVideo" : file.hints.resourceType === "fullSizePhoto" ? "fullSizePairedVideo" : "";
    if (role) paired = videos.filter(candidate => candidate.hints.sourceKey === file.hints.sourceKey && candidate.hints.resourceType === role);
  }
  const motion = paired.length === 1 ? paired[0].hash : undefined;
  const video = file.mime.startsWith("video/");
  const number = (name: string) => {
    const key = Object.keys(file.metadata).find(key => key === name || key.endsWith(":" + name));
    const value = key ? parseFloat(String(file.metadata[key])) : NaN;
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return { ...asset, primary: file.hash, motion: video ? undefined : motion, kind: video ? "video" : motion ? "live" : "photo", name: file.name, width: file.width, height: file.height, size: file.size, capturedAt: file.capturedAt || asset.capturedAt, status: file.status, duration: video ? number("Duration") : undefined, frameRate: video ? number("VideoFrameRate") : undefined };
}

export function VersionPicker({ files, selected, primary, select, locked }: { files: Original[]; selected: string; primary: string; select: (hash: string) => void; locked: boolean }) {
  return <div className="viewer-version-menu" role="group" aria-label="照片版本">
    {files.map((file, index) => <button key={file.hash} className={file.hash === selected ? "is-selected" : ""} aria-pressed={file.hash === selected} disabled={locked} onClick={() => select(file.hash)} title={file.name}>
      <img src={media(file.hash)} alt="" loading="lazy" decoding="async" />
      <span><strong>{resourceLabel(file)}{files.filter(candidate => candidate.hints.resourceType === file.hints.resourceType).length > 1 ? ` ${index + 1}` : ""}</strong><small>{file.name}{file.hash === primary ? " · 主版本" : ""}</small></span>
      {file.hash === selected && <Layers3 size={15} />}
    </button>)}
  </div>;
}

const numeric = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
const format = (value: unknown) => Number.isFinite(numeric(value)) ? String(Number(numeric(value).toFixed(3))) : "";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function time(value: unknown) {
  const t = object(value), seconds = numeric(t.value) / numeric(t.timescale);
  return Number.isFinite(seconds) && seconds >= 0 ? `${Number(seconds.toFixed(3))} 秒` : "";
}
export function adjustmentSummary(edit: EditRecord): { label: string; value: string }[] {
  return edit.adjustments.filter(adjustment => adjustment.enabled !== false).map(adjustment => {
    const s = adjustment.settings || {}, input = object(s.inputKeys), id = adjustment.identifier || "未知调整";
    const parameters = (fields: [string, string][], source = s) => fields.map(([key, label]) => format(source[key]) ? `${label} ${format(source[key])}` : "").filter(Boolean).join(" · ");
    switch (id) {
      case "Crop": {
        const w = numeric(s.width), h = numeric(s.height), mw = numeric(edit.metadata?.masterWidth), mh = numeric(edit.metadata?.masterHeight);
        const area = w > 0 && h > 0 && mw > 0 && mh > 0 ? `保留 ${format(w / mw * 100)}% × ${format(h / mh * 100)}% 的区域` : "";
        const angles = parameters([["straightenAngle", "倾斜校正"], ["pitch", "垂直透视"], ["yaw", "水平透视"]].filter(([key]) => numeric(s[key]) !== 0) as [string, string][]);
        return { label: "裁剪与校正", value: [area, parameters([["xOrigin", "左边距"], ["yOrigin", "上边距"]]), angles].filter(Boolean).join(" · ") || "已启用" };
      }
      case "Trim": return { label: "视频截取", value: [time(s.startTime), time(s.endTime)].filter(Boolean).join(" — ") || "已启用" };
      case "LivePhotoKeyFrame": return { label: "实况封面帧", value: time(s.time) || "已设置" };
      case "DepthEffect": return { label: "人像景深", value: format(s.aperture) ? `光圈 ƒ/${format(s.aperture)}` : "已启用" };
      case "PortraitEffect": return { label: "人像光效", value: [s.portraitEffectFilterName === "StudioV2" ? "摄影室灯光" : typeof s.portraitEffectFilterName === "string" ? s.portraitEffectFilterName : "", parameters([["strength", "强度"]])].filter(Boolean).join(" · ") || "已启用" };
      case "DGDefinition2Operation": return { label: "清晰度", value: parameters([["inputIntensity", "强度"]], input) || "已启用" };
      case "RKProSharpenOperation": return { label: "锐化", value: parameters([["inputSharpness", "强度"]], input) || "已启用" };
      case "SmartTone": return { label: "光线调整", value: parameters([["inputLight", "光线"], ["offsetExposure", "曝光"], ["offsetBrightness", "亮度"], ["offsetContrast", "对比度"], ["offsetHighlights", "高光"], ["offsetShadows", "阴影"], ["offsetBlackPoint", "黑点"]]) || "已启用" };
      case "SmartColor": return { label: "色彩调整", value: parameters([["inputColor", "色彩"], ["inputSaturation", "饱和度"], ["inputVibrance", "自然饱和度"]]) || "已启用" };
      default: return { label: id, value: "已启用，具体参数见原始记录" };
    }
  });
}

export function PhotoEdits({ records, file }: { records: EditRecord[]; file?: Original }) {
  const matching = file?.hints.sourceKey ? records.filter(record => record.sourceKey === file.hints.sourceKey) : [];
  if (!matching.length) return null;
  const editors: Record<string, string> = { "com.apple.mobileslideshow": "Apple 照片", "com.apple.camera": "Apple 相机", "com.apple.ScreenshotServicesService": "Apple 截图" };
  return <section className="photo-edits"><h3><FileText size={15} />处理与修改</h3>
    {matching.map(record => {
      const changes = adjustmentSummary(record);
      return <div className="photo-edit-record" key={record.hash}>
        <p>{editors[record.editor || ""] || record.editor || record.format || "编辑记录"}{file?.hints.resourceType === "originalPhoto" && record.editor !== "com.apple.camera" ? " · 对应编辑后版本" : ""}</p>
        {record.state === "parsed" ? changes.length ? <dl>{changes.map((change, index) => <div key={index}><dt>{change.label}</dt><dd>{change.value}</dd></div>)}</dl> : <p className="photo-edit-note">记录中没有启用的调整。</p> : <p className="photo-edit-note">{record.state === "unavailable" ? "编辑记录暂时无法读取。" : "已保留编辑记录，此格式暂时无法解析具体内容。"}</p>}
        {record.timestamp && <p className="photo-edit-note">记录时间：{record.timestamp.includes("T") ? new Date(record.timestamp).toLocaleString("zh-CN") : record.timestamp}</p>}
        {record.state === "parsed" && <details><summary>原始调整参数</summary><pre>{JSON.stringify(record.adjustments, null, 2)}</pre></details>}
      </div>;
    })}
  </section>;
}
