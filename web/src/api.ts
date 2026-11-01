export type Asset = {
  id: string;
  primary: string;
  motion?: string;
  capturedAt: string;
  kind: string;
  favorite: boolean;
  trashedAt?: string;
  deletionPending?: boolean;
  name: string;
  width: number;
  height: number;
  size: number;
  status: string;
  variants: number;
  imageVersions: number;
  grouping?: "automatic" | "manual";
  duration?: number;
  frameRate?: number;
};
export type Original = {
  hash: string;
  assetId: string;
  name: string;
  size: number;
  mime: string;
  width: number;
  height: number;
  capturedAt: string;
  contentId?: string;
  metadata: Record<string, unknown>;
  score: number;
  status: string;
  error?: string;
  hints: Record<string, unknown>;
};
export type Detail = {
  asset: Asset;
  files: Original[];
  metadata: Record<string, unknown>;
  edits: EditRecord[];
};
export type EditRecord = {
  hash: string;
  sourceKey?: string;
  editor?: string;
  format?: string;
  version?: string;
  timestamp?: string;
  state: "parsed" | "unsupported" | "unavailable";
  metadata?: Record<string, unknown>;
  adjustments: { identifier?: string; enabled?: boolean; settings?: Record<string, unknown>; [key: string]: unknown }[];
};
export type Album = {
  id: string;
  name: string;
  count: number;
  cover?: Asset;
  createdAt: string;
  updatedAt: string;
};
export type Info = {
  revision: number;
  total: number;
  favorites: number;
  live: number;
  videos: number;
  trash: number;
  originals: number;
  bytes: number;
  queued: number;
  errors: number;
  grouped: number;
  automatic: number;
  merged: number;
  pendingDeletions?: number;
  similarityIndex?: SimilarityIndex;
  capabilities?: { permanentDelete?: boolean };
};
export type PurgeResponse = {
  requestId: string;
  state: "pending" | "complete";
  accepted: string[];
};
export type DeletionOperation = {
  id: string;
  state: "pending" | "complete";
  ids: string[];
  bytes: number;
  error?: string;
};
export type Page<T> = { items: T[]; next: string };
export type JobStatus = "all" | "queued" | "processing" | "error" | "ready";
export type JobStep = {
  id: string;
  label: string;
  status: "queued" | "processing" | "ready" | "error" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  percent?: number;
  engine?: string;
  error?: string;
  note?: string;
};
export type Job = {
  hash: string;
  name: string;
  mime: string;
  size: number;
  assetId: string;
  status: Exclude<JobStatus, "all">;
  error?: string;
  createdAt: string;
  activityAt: string;
  progress?: { startedAt?: string; finishedAt?: string; steps: JobStep[] };
};
export type JobPage = Page<Job> & {
  counts: Record<JobStatus, number>;
};
export type PendingUpload = {
  id: string;
  name: string;
  size: number;
  offset: number;
  createdAt: string;
  state: string;
  missing?: boolean;
};
export type SimilarPair = { left: string; right: string; distance: number; source?: "dhash" | "dino"; score?: number };
export type SimilarityIndex = {
  state: "starting" | "idle" | "waiting" | "processing" | "unavailable" | "disabled";
  total: number;
  ready: number;
  pending: number;
  errors: number;
  engine?: string;
  batchSize: number;
  waitSeconds: number;
};
export type SimilarPage = Page<SimilarPair> & { index?: SimilarityIndex; assets: Record<string, Asset> };
export type Timeline = { months: { month: string; count: number }[] };
export const base = "/aura/";
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(message: string, status: number, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = typeof detail?.code === "string" ? detail.code : undefined;
    this.requestId = typeof detail?.requestId === "string" ? detail.requestId : undefined;
  }
}
export function isOriginalDeleted(error: unknown) {
  return error instanceof ApiError && error.status === 410 && error.code === "original_deleted";
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(base + "api/" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    signal,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) {
    throw new ApiError("设备授权已失效，请返回门户重新登录", r.status);
  }
  if (!r.ok) {
    const v = await r.json().catch(() => null);
    throw new ApiError(v?.error || `请求失败 (${r.status})`, r.status, v || undefined);
  }
  return r.json();
}
export const media = (hash: string, kind = "thumb") =>
  `${base}media/${hash}/${kind}`;
export function resourceLabel(file: Original) {
  const labels: Record<string, string> = {
    originalPhoto: "原始照片", photo: "原始照片", fullSizePhoto: "编辑后照片",
    originalVideo: "原始视频", fullSizeVideo: "编辑后视频",
    originalPairedVideo: "原始实况视频", fullSizePairedVideo: "编辑后实况视频",
    adjustmentData: "编辑记录", alternatePhoto: "备用照片",
  };
  return labels[String(file.hints.resourceType)] || (file.mime.startsWith("image/") ? "照片原件" : file.mime.startsWith("video/") ? "视频原件" : "附加资源");
}
export function timestamp(value: number) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function bytes(n: number) {
  if (!n) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return (
    (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + ["B", "KB", "MB", "GB", "TB"][i]
  );
}
export function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function displayDate(s: string, long = false) {
  return new Date(s).toLocaleDateString(
    "zh-CN",
    long
      ? { year: "numeric", month: "long", day: "numeric", weekday: "long" }
      : { month: "long", day: "numeric" },
  );
}
