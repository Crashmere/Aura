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
  pendingDeletions?: number;
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
export type Job = {
  hash: string;
  name: string;
  mime: string;
  size: number;
  assetId: string;
  status: Exclude<JobStatus, "all">;
  error?: string;
  createdAt: string;
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
export type SimilarPair = { left: string; right: string; distance: number };
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
): Promise<T> {
  const r = await fetch(base + "api/" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
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
