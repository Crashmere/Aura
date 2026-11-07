import type {
  CatalogAsset,
  NativeEditRecord,
  StoredFile,
} from "./types";

export const APP_BASE = "/aura/";

export class HttpServiceError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(message: string, status: number, payload?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = typeof payload?.code === "string" ? payload.code : undefined;
    this.requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
  }
}

export function isPurgedOriginalError(err: unknown): boolean {
  return err instanceof HttpServiceError && err.status === 410 && err.code === "original_deleted";
}

export async function requestJson<T>(
  endpoint: string,
  payload?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${APP_BASE}api/${endpoint}`, {
    method: method ?? (payload === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    signal,
    headers: payload === undefined ? {} : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  if (res.status === 401) {
    throw new HttpServiceError("设备授权已失效，请返回门户重新登录", res.status);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new HttpServiceError(
      body?.error || `请求失败 (${res.status})`,
      res.status,
      body || undefined,
    );
  }

  return res.json() as Promise<T>;
}

export function buildMediaUrl(
  hash: string,
  kind: "thumb" | "preview" | "play" | "original" = "thumb",
  rotation = 0,
  coverRevision?: string,
): string {
  const basePath = `${APP_BASE}media/${hash}/${kind}`;
  if (kind === "original") return basePath;
  const search = new URLSearchParams({ rotation: String(rotation || 0) });
  if (kind === "thumb" || kind === "preview") {
    search.set("v", "3");
    search.set("cover", coverRevision || "original");
  }
  return `${basePath}?${search.toString()}`;
}

export function buildFramePreviewUrl(
  assetId: string,
  hash: string,
  motionHash: string,
  timeSeconds: number,
  rotation = 0,
  size: "thumb" | "preview" = "thumb",
): string {
  const search = new URLSearchParams({
    hash,
    motion: motionHash,
    time: timeSeconds.toFixed(6),
    rotation: String(rotation || 0),
    size,
  });
  return `${APP_BASE}api/assets/${assetId}/frame?${search.toString()}`;
}

export function formatByteSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatDurationClock(sec: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor(total / 60) % 60;
  const rem = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

export function formatIsoDayLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatHumanDate(iso: string, includeYearAndWeekday = false): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(
    "zh-CN",
    includeYearAndWeekday
      ? { year: "numeric", month: "long", day: "numeric", weekday: "long" }
      : { month: "long", day: "numeric", weekday: "short" },
  );
}

export function describeOriginalRole(file: StoredFile): string {
  const mapping: Record<string, string> = {
    originalPhoto: "原始照片",
    photo: "原始照片",
    fullSizePhoto: "编辑后照片",
    originalVideo: "原始视频",
    fullSizeVideo: "编辑后视频",
    originalPairedVideo: "原始实况视频",
    fullSizePairedVideo: "编辑后实况视频",
    adjustmentData: "编辑记录",
    alternatePhoto: "备用照片",
  };
  const roleKey = String(file.hints?.resourceType || "");
  if (mapping[roleKey]) return mapping[roleKey];
  if (file.mime.startsWith("image/")) return "照片原件";
  if (file.mime.startsWith("video/")) return "视频原件";
  return "附加资源";
}

export function normalizeQuarterAngle(angle = 0): number {
  return ((angle % 360) + 360) % 360;
}

export function orientedDimensions(item: {
  width: number;
  height: number;
  rotation?: number;
  cover?: { width: number; height: number };
}): { width: number; height: number } {
  const baseWidth = item.cover?.width ?? item.width;
  const baseHeight = item.cover?.height ?? item.height;
  return normalizeQuarterAngle(item.rotation) % 180 !== 0
    ? { width: baseHeight, height: baseWidth }
    : { width: baseWidth, height: baseHeight };
}

export function projectVersionAsAsset(
  catalogAsset: CatalogAsset,
  selectedFile: StoredFile,
  allFiles: StoredFile[],
): CatalogAsset {
  const videoFiles = allFiles.filter((f) => f.mime.startsWith("video/"));
  let pairedVideos = selectedFile.contentId
    ? videoFiles.filter((f) => f.contentId === selectedFile.contentId)
    : [];

  if (!selectedFile.contentId && selectedFile.hints?.sourceKey) {
    const rt = selectedFile.hints.resourceType;
    const expectedVideoRole =
      rt === "originalPhoto"
        ? "originalPairedVideo"
        : rt === "fullSizePhoto"
          ? "fullSizePairedVideo"
          : "";
    if (expectedVideoRole) {
      pairedVideos = videoFiles.filter(
        (f) =>
          f.hints?.sourceKey === selectedFile.hints?.sourceKey &&
          f.hints?.resourceType === expectedVideoRole,
      );
    }
  }

  const matchedMotion = pairedVideos.length === 1 ? pairedVideos[0] : undefined;
  const isVideoFile = selectedFile.mime.startsWith("video/");

  const readPositiveMeta = (tagSuffix: string, target: StoredFile = selectedFile): number | undefined => {
    const matchedKey = Object.keys(target.metadata || {}).find(
      (k) => k === tagSuffix || k.endsWith(`:${tagSuffix}`),
    );
    const val = matchedKey ? parseFloat(String(target.metadata[matchedKey])) : NaN;
    return Number.isFinite(val) && val > 0 ? val : undefined;
  };

  return {
    ...catalogAsset,
    primary: selectedFile.hash,
    motion: isVideoFile ? undefined : matchedMotion?.hash,
    rotation: selectedFile.rotation || 0,
    motionRotation: isVideoFile ? undefined : matchedMotion ? matchedMotion.rotation || 0 : undefined,
    kind: isVideoFile ? "video" : matchedMotion ? "live" : "photo",
    name: selectedFile.name,
    width: selectedFile.width,
    height: selectedFile.height,
    size: selectedFile.size,
    capturedAt: selectedFile.capturedAt || catalogAsset.capturedAt,
    status: selectedFile.status,
    cover: selectedFile.cover,
    duration: isVideoFile ? readPositiveMeta("Duration") : undefined,
    frameRate: isVideoFile ? readPositiveMeta("VideoFrameRate") : undefined,
    motionDuration: matchedMotion ? readPositiveMeta("Duration", matchedMotion) : undefined,
    motionFrameRate: matchedMotion ? readPositiveMeta("VideoFrameRate", matchedMotion) : undefined,
  };
}

export function summarizeNativeAdjustments(
  record: NativeEditRecord,
): { label: string; value: string }[] {
  const toNum = (v: unknown): number =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  const fmtNum = (v: unknown): string =>
    Number.isFinite(toNum(v)) ? String(Number(toNum(v).toFixed(3))) : "";
  const asMap = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const fmtRationalTime = (v: unknown): string => {
    const obj = asMap(v);
    const sec = toNum(obj.value) / toNum(obj.timescale);
    return Number.isFinite(sec) && sec >= 0 ? `${Number(sec.toFixed(3))} 秒` : "";
  };

  return record.adjustments
    .filter((adj) => adj.enabled !== false)
    .map((adj) => {
      const settings = adj.settings || {};
      const inputKeys = asMap(settings.inputKeys);
      const id = adj.identifier || "未知调整";
      const joinFields = (pairs: [string, string][], src: Record<string, unknown> = settings) =>
        pairs
          .map(([k, title]) => (fmtNum(src[k]) ? `${title} ${fmtNum(src[k])}` : ""))
          .filter(Boolean)
          .join(" · ");

      switch (id) {
        case "Crop": {
          const w = toNum(settings.width);
          const h = toNum(settings.height);
          const mw = toNum(record.metadata?.masterWidth);
          const mh = toNum(record.metadata?.masterHeight);
          const areaText =
            w > 0 && h > 0 && mw > 0 && mh > 0
              ? `保留 ${fmtNum((w / mw) * 100)}% × ${fmtNum((h / mh) * 100)}% 的区域`
              : "";
          const activeAngles = (
            [
              ["straightenAngle", "倾斜校正"],
              ["pitch", "垂直透视"],
              ["yaw", "水平透视"],
            ] as [string, string][]
          ).filter(([k]) => toNum(settings[k]) !== 0);
          return {
            label: "裁剪与校正",
            value:
              [
                areaText,
                joinFields([
                  ["xOrigin", "左边距"],
                  ["yOrigin", "上边距"],
                ]),
                joinFields(activeAngles),
              ]
                .filter(Boolean)
                .join(" · ") || "已启用",
          };
        }
        case "Trim":
          return {
            label: "视频截取",
            value:
              [fmtRationalTime(settings.startTime), fmtRationalTime(settings.endTime)]
                .filter(Boolean)
                .join(" — ") || "已启用",
          };
        case "LivePhotoKeyFrame":
          return {
            label: "实况封面帧",
            value: fmtRationalTime(settings.time) || "已设置",
          };
        case "DepthEffect":
          return {
            label: "人像景深",
            value: fmtNum(settings.aperture) ? `光圈 ƒ/${fmtNum(settings.aperture)}` : "已启用",
          };
        case "PortraitEffect":
          return {
            label: "人像光效",
            value:
              [
                settings.portraitEffectFilterName === "StudioV2"
                  ? "摄影室灯光"
                  : typeof settings.portraitEffectFilterName === "string"
                    ? settings.portraitEffectFilterName
                    : "",
                joinFields([["strength", "强度"]]),
              ]
                .filter(Boolean)
                .join(" · ") || "已启用",
          };
        case "DGDefinition2Operation":
          return {
            label: "清晰度",
            value: joinFields([["inputIntensity", "强度"]], inputKeys) || "已启用",
          };
        case "RKProSharpenOperation":
          return {
            label: "锐化",
            value: joinFields([["inputSharpness", "强度"]], inputKeys) || "已启用",
          };
        case "SmartTone":
          return {
            label: "光线调整",
            value:
              joinFields([
                ["inputLight", "光线"],
                ["offsetExposure", "曝光"],
                ["offsetBrightness", "亮度"],
                ["offsetContrast", "对比度"],
                ["offsetHighlights", "高光"],
                ["offsetShadows", "阴影"],
                ["offsetBlackPoint", "黑点"],
              ]) || "已启用",
          };
        case "SmartColor":
          return {
            label: "色彩调整",
            value:
              joinFields([
                ["inputColor", "色彩"],
                ["inputSaturation", "饱和度"],
                ["inputVibrance", "自然饱和度"],
              ]) || "已启用",
          };
        default:
          return { label: id, value: "已启用，具体参数见原始记录" };
      }
    });
}
