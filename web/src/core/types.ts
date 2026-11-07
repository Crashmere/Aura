export interface CoverChoice {
  motion: string;
  time: number;
  revision: string;
  width: number;
  height: number;
}

export interface CatalogAsset {
  id: string;
  primary: string;
  motion?: string;
  capturedAt: string;
  kind: "photo" | "live" | "video" | string;
  favorite: boolean;
  trashedAt?: string;
  deletionPending?: boolean;
  name: string;
  width: number;
  height: number;
  size: number;
  status: "ready" | "queued" | "processing" | "error" | string;
  variants: number;
  imageVersions: number;
  grouping?: "automatic" | "manual";
  duration?: number;
  frameRate?: number;
  rotation?: number;
  motionRotation?: number;
  motionDuration?: number;
  motionFrameRate?: number;
  cover?: CoverChoice;
  albums?: AlbumReference[];
}

export interface AlbumReference {
  id: string;
  name: string;
}

export interface StoredFile {
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
  rotation?: number;
  cover?: CoverChoice;
}

export interface PlaybackDescriptor {
  source?: {
    url: string;
    mime: string;
    codecs?: string;
  };
  stream: { url: string };
  duration?: number;
  frameRate?: number;
}

export interface AdjustmentEntry {
  identifier?: string;
  enabled?: boolean;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NativeEditRecord {
  hash: string;
  sourceKey?: string;
  editor?: string;
  format?: string;
  version?: string;
  timestamp?: string;
  state: "parsed" | "unsupported" | "unavailable";
  metadata?: Record<string, unknown>;
  adjustments: AdjustmentEntry[];
}

export interface AssetDetailPayload {
  asset: CatalogAsset;
  files: StoredFile[];
  metadata: Record<string, unknown>;
  edits: NativeEditRecord[];
}

export interface AlbumItem {
  id: string;
  name: string;
  groupId: string;
  count: number;
  cover?: CatalogAsset;
  createdAt: string;
  updatedAt: string;
}

export interface AlbumGroup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DinoIndexStatus {
  state: "starting" | "idle" | "waiting" | "processing" | "unavailable" | "disabled";
  total: number;
  ready: number;
  pending: number;
  errors: number;
  engine?: string;
  batchSize: number;
  waitSeconds: number;
}

export interface ConcurrencyLimits {
  workers: number;
  gpuOperations: number;
  cpuOperations: number;
}

export interface LibraryTelemetry {
  name?: string;
  version?: string;
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
  processingConcurrency?: ConcurrencyLimits;
  similarityIndex?: DinoIndexStatus;
  capabilities?: {
    originalPresence?: boolean;
    albumImport?: boolean;
    processingPages?: boolean;
    uploadPages?: boolean;
    similarReview?: boolean;
    dinoSimilarity?: boolean;
    timeline?: boolean;
    permanentDelete?: boolean;
    rotation?: boolean;
    coverFrames?: boolean;
  };
}

export interface CursorPage<T> {
  items: T[];
  next: string;
}

export type PipelineFilterStatus = "all" | "queued" | "processing" | "error" | "ready";

export interface PipelineStep {
  id: string;
  label: string;
  status: "queued" | "processing" | "ready" | "error" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  percent?: number;
  engine?: string;
  error?: string;
  note?: string;
}

export interface PipelineJob {
  hash: string;
  name: string;
  mime: string;
  size: number;
  assetId: string;
  status: Exclude<PipelineFilterStatus, "all">;
  error?: string;
  createdAt: string;
  activityAt: string;
  progress?: {
    startedAt?: string;
    finishedAt?: string;
    steps: PipelineStep[];
  };
}

export interface PipelineJobPage extends CursorPage<PipelineJob> {
  counts: Record<PipelineFilterStatus, number>;
  retentionHours?: number;
}

export interface IncompleteUploadSession {
  id: string;
  name: string;
  size: number;
  offset: number;
  createdAt: string;
  state: string;
  missing?: boolean;
}

export interface CandidatePair {
  left: string;
  right: string;
  distance: number;
  source?: "dhash" | "dino";
  score?: number;
}

export interface SimilarCandidatesPage extends CursorPage<CandidatePair> {
  index?: DinoIndexStatus;
  assets: Record<string, CatalogAsset>;
  total: number;
  counts: Record<"dhash" | "dino", number>;
}

export type CurationHistoryType = "similar" | "split";

export interface CurationHistoryRecord {
  id: string;
  createdAt: string;
  left: string;
  right: string;
  hash?: string;
  name?: string;
  canRestore: boolean;
  reason?: string;
}

export interface CurationHistoryPage extends CursorPage<CurationHistoryRecord> {
  assets: Record<string, CatalogAsset>;
}

export interface TimelineSummary {
  months: { month: string; count: number }[];
}

export interface PurgeRequestReceipt {
  requestId: string;
  state: "pending" | "complete";
  accepted: string[];
}

export interface PurgeTaskStatus {
  id: string;
  state: "pending" | "complete";
  ids: string[];
  bytes: number;
  error?: string;
}

export type WorkspaceViewId =
  | "all"
  | "albums"
  | "live"
  | "videos"
  | "grouped"
  | "automatic"
  | "merged"
  | "similar"
  | "trash"
  | "jobs";
