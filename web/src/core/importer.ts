import exifr from "exifr";
import {
  APP_BASE,
  formatIsoDayLocal,
  HttpServiceError,
  isPurgedOriginalError,
  requestJson,
} from "./client";
import type { CatalogAsset } from "./types";

export type UploadTaskPhase =
  | "waiting"
  | "reading"
  | "uploading"
  | "done"
  | "duplicate"
  | "trashed"
  | "skipped"
  | "error";

export interface UploadQueueEntry {
  id: string;
  file: File;
  name: string;
  state: UploadTaskPhase;
  progress: number;
  error?: string;
  date?: string;
  assetId?: string;
  hash?: string;
  trashedAt?: string;
  restoring?: boolean;
  restoreError?: string;
}

export interface UploadEngineSnapshot {
  items: UploadQueueEntry[];
  running: boolean;
  paused: boolean;
  scanning: boolean;
  watching: boolean;
  sourceName: string;
  from: string;
  to: string;
  error: string;
}

interface ServerUploadSession {
  id: string;
  offset: number;
  complete: boolean;
  duplicate?: boolean;
  filtered?: boolean;
  chunkSize: number;
  assetId?: string;
  trashed?: boolean;
  trashedAt?: string;
  missing?: boolean;
}

type WatchableDirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  requestPermission(opts: { mode: string }): Promise<string>;
};

const SUPPORTED_MEDIA_EXT =
  /\.(jpe?g|heic|heif|png|webp|gif|tiff?|avif|jxl|dng|cr[23]|nef|arw|raf|rw2|orf|pef|srw|mov|mp4|m4v|avi|mkv|mts|3gp|aae|xmp)$/i;

let engineState: UploadEngineSnapshot = {
  items: [],
  running: false,
  paused: false,
  scanning: false,
  watching: false,
  sourceName: "",
  from: "",
  to: "",
  error: "",
};

const stateSubscribers = new Set<() => void>();
let workerLoopActive = false;
let watchedDirHandle: WatchableDirectoryHandle | undefined;
let watchIntervalId: number | undefined;
let throttledTimer: ReturnType<typeof setTimeout> | undefined;

const broadcastState = () => {
  clearTimeout(throttledTimer);
  throttledTimer = undefined;
  engineState = { ...engineState };
  stateSubscribers.forEach((fn) => fn());
};

const broadcastThrottled = () => {
  if (!throttledTimer) {
    throttledTimer = setTimeout(broadcastState, 120);
  }
};

export function subscribeUploadEngine(cb: () => void): () => void {
  stateSubscribers.add(cb);
  return () => {
    stateSubscribers.delete(cb);
  };
}

export function getUploadSnapshot(): UploadEngineSnapshot {
  return engineState;
}

let cachedSummary = {
  running: false,
  scanning: false,
  total: 0,
  completed: 0,
  items: engineState.items,
};

export function getUploadActivitySummary() {
  let doneCount = 0;
  for (const item of engineState.items) {
    if (["done", "duplicate", "trashed", "skipped"].includes(item.state)) {
      doneCount++;
    }
  }
  if (
    cachedSummary.running !== engineState.running ||
    cachedSummary.scanning !== engineState.scanning ||
    cachedSummary.total !== engineState.items.length ||
    cachedSummary.completed !== doneCount
  ) {
    cachedSummary = {
      running: engineState.running,
      scanning: engineState.scanning,
      total: engineState.items.length,
      completed: doneCount,
      items: engineState.items,
    };
  }
  return cachedSummary;
}

export function setUploadDateBounds(from: string, to: string): void {
  engineState.from = from;
  engineState.to = to;
  broadcastState();
}

export function pauseUploads(): void {
  engineState.paused = true;
  broadcastState();
}

export function resumeUploads(): void {
  engineState.paused = false;
  for (const item of engineState.items) {
    if (item.state === "error") {
      item.state = "waiting";
      item.error = undefined;
    }
  }
  broadcastState();
  void driveUploadLoop();
}

export function clearCompletedUploads(): void {
  engineState.items = engineState.items.filter(
    (item) => !["done", "duplicate", "trashed", "skipped"].includes(item.state),
  );
  broadcastState();
}

export function markAssetsPurgedInQueue(purgedAssetIds: string[]): void {
  for (const item of engineState.items) {
    if (
      !item.assetId ||
      !purgedAssetIds.includes(item.assetId) ||
      !["done", "duplicate", "trashed"].includes(item.state)
    ) {
      continue;
    }
    item.state = "skipped";
    item.error = "已永久删除，不会重新导入";
    item.assetId = undefined;
    item.trashedAt = undefined;
  }
  broadcastState();
}

export async function resolveUploadedAssetId(entryId: string): Promise<string> {
  const entry = engineState.items.find((x) => x.id === entryId);
  if (!entry) throw new Error("上传记录已清除");
  if (entry.hash) {
    const status = await requestJson<ServerUploadSession>(`uploads/${entry.hash}`);
    entry.assetId = status.assetId || entry.assetId;
  }
  if (!entry.assetId) {
    throw new Error("服务器尚未建立照片项目，请稍后重试");
  }
  return entry.assetId;
}

export async function restoreTrashedUploadEntry(entryId: string): Promise<void> {
  const entry = engineState.items.find((x) => x.id === entryId);
  if (!entry?.assetId || entry.restoring) return;
  entry.restoring = true;
  entry.restoreError = undefined;
  broadcastState();
  try {
    await resolveUploadedAssetId(entryId);
    await requestJson<CatalogAsset>(`assets/${entry.assetId}`, { trash: false }, "PATCH");
    entry.state = "duplicate";
    entry.trashedAt = undefined;
    window.dispatchEvent(new Event("aura-library-changed"));
  } catch (err) {
    entry.restoreError = err instanceof Error ? err.message : String(err);
  } finally {
    entry.restoring = false;
    broadcastState();
  }
}

export function stopDirectoryWatch(): void {
  if (watchIntervalId) clearInterval(watchIntervalId);
  watchIntervalId = undefined;
  engineState.watching = false;
  watchedDirHandle = undefined;
  broadcastState();
}

export function enqueueUploadFiles(files: File[]): void {
  const existingKeys = new Set(
    engineState.items
      .filter((x) => x.state !== "error")
      .map((x) => `${x.name}|${x.file.size}|${x.file.lastModified}`),
  );
  for (const file of files) {
    const relName = file.webkitRelativePath || file.name;
    const key = `${relName}|${file.size}|${file.lastModified}`;
    if (SUPPORTED_MEDIA_EXT.test(relName) && !existingKeys.has(key)) {
      engineState.items.push({
        id: crypto.randomUUID(),
        file,
        name: relName,
        state: "waiting",
        progress: 0,
      });
      existingKeys.add(key);
    }
  }
  broadcastState();
  void driveUploadLoop();
}

function computeFileSha256(file: File, onProgress: (ratio: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sha256.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      if (e.data.hash) {
        worker.terminate();
        resolve(e.data.hash);
      } else if (e.data.error) {
        worker.terminate();
        reject(new Error(e.data.error));
      } else {
        onProgress(e.data.progress);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(file);
  });
}

async function extractCaptureDate(file: File): Promise<Date> {
  try {
    const parsed = await exifr.parse(file, {
      pick: ["DateTimeOriginal", "CreateDate"],
      reviveValues: true,
    });
    const candidate = parsed?.DateTimeOriginal || parsed?.CreateDate;
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
      return candidate;
    }
  } catch {
    /* Non-EXIF or video containers fall back to file modification date */
  }
  return new Date(file.lastModified);
}

async function prepareUploadEntry(entry: UploadQueueEntry): Promise<{ date: Date; hash: string }> {
  entry.state = "reading";
  entry.error = undefined;
  broadcastState();
  const date = await extractCaptureDate(entry.file);
  entry.date = formatIsoDayLocal(date);
  const hash = await computeFileSha256(entry.file, (r) => {
    entry.progress = r * 0.05;
    broadcastThrottled();
  });
  entry.hash = hash;
  return { date, hash };
}

function assertValidSession(session: ServerUploadSession, fileSize: number): void {
  if (typeof session.complete !== "boolean") {
    throw new Error("服务器返回了无效的上传状态");
  }
  if (session.complete) return;
  if (
    !Number.isInteger(session.offset) ||
    session.offset < 0 ||
    session.offset > fileSize ||
    !Number.isInteger(session.chunkSize) ||
    session.chunkSize < 1 ||
    session.chunkSize > 128 * 1024 * 1024
  ) {
    throw new Error("服务器返回了无效的续传参数");
  }
}

async function transferEntry(
  entry: UploadQueueEntry,
  preparation: Promise<{ date: Date; hash: string }>,
): Promise<void> {
  const { date, hash } = await preparation;
  if (engineState.paused) {
    entry.state = "waiting";
    broadcastState();
    return;
  }

  let session = await requestJson<ServerUploadSession>("uploads", {
    hash,
    name: entry.file.name,
    size: entry.file.size,
    capturedAt: date.toISOString(),
    modifiedAt: new Date(entry.file.lastModified).toISOString(),
    from: engineState.from,
    to: engineState.to,
  });

  assertValidSession(session, entry.file.size);
  entry.assetId = session.assetId;
  entry.trashedAt = session.trashedAt;

  if (session.complete) {
    entry.state = session.filtered
      ? "skipped"
      : session.trashed || session.trashedAt
        ? "trashed"
        : "duplicate";
    entry.progress = 1;
    broadcastState();
    return;
  }

  entry.state = "uploading";
  broadcastState();

  let offset = session.offset;
  let retryCount = 0;

  while (offset < entry.file.size) {
    if (engineState.paused) {
      entry.state = "waiting";
      broadcastState();
      return;
    }
    try {
      const res = await fetch(`${APP_BASE}api/uploads/${hash}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/octet-stream",
          "Upload-Offset": String(offset),
        },
        body: entry.file.slice(offset, offset + session.chunkSize),
        signal: AbortSignal.timeout(660000),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 409 && typeof payload.offset === "number") {
        if (
          !Number.isInteger(payload.offset) ||
          payload.offset < 0 ||
          payload.offset > entry.file.size
        ) {
          throw new Error("服务器返回了无效的续传位置");
        }
        offset = payload.offset;
        continue;
      }
      if (!res.ok) {
        throw new HttpServiceError(
          payload.error ||
            (res.status === 401 ? "请返回门户重新登录" : `上传失败 (${res.status})`),
          res.status,
          payload,
        );
      }
      if (
        !Number.isInteger(payload.offset) ||
        payload.offset <= offset ||
        payload.offset > entry.file.size
      ) {
        throw new Error("服务器未确认已接收的分片");
      }
      offset = payload.offset;
      retryCount = 0;
      entry.progress = 0.05 + (0.95 * offset) / entry.file.size;
      broadcastThrottled();
    } catch (err) {
      if (isPurgedOriginalError(err)) throw err;
      if (++retryCount > 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** retryCount));
      session = await requestJson<ServerUploadSession>(`uploads/${hash}`);
      assertValidSession(session, entry.file.size);
      offset = session.offset;
      if (session.complete) break;
    }
  }

  const commitResult = await requestJson<{
    filtered?: boolean;
    assetId?: string;
    trashed?: boolean;
    trashedAt?: string;
  }>(`uploads/${hash}/complete`, {});

  entry.assetId = commitResult.assetId || entry.assetId;
  entry.trashedAt = commitResult.trashedAt || entry.trashedAt;
  entry.state = commitResult.filtered
    ? "skipped"
    : commitResult.trashed || commitResult.trashedAt
      ? "trashed"
      : "done";
  entry.progress = 1;
  broadcastState();
  window.dispatchEvent(new Event("aura-library-changed"));
}

async function driveUploadLoop(): Promise<void> {
  if (workerLoopActive || engineState.paused) return;
  workerLoopActive = true;
  engineState.running = true;
  broadcastState();

  let wakeSentinel: WakeLockSentinel | undefined;
  try {
    wakeSentinel = await navigator.wakeLock?.request("screen");
  } catch {
    /* Optional browser wake lock */
  }

  const prefetchedMap = new Map<string, Promise<{ date: Date; hash: string }>>();
  const startPrep = (entry: UploadQueueEntry) => {
    const task = prepareUploadEntry(entry);
    task.catch(() => {});
    prefetchedMap.set(entry.id, task);
    return task;
  };

  try {
    while (!engineState.paused) {
      const current = engineState.items.find(
        (x) => x.state === "waiting" || prefetchedMap.has(x.id),
      );
      if (!current) break;
      try {
        const currentPrep = prefetchedMap.get(current.id) || startPrep(current);
        await currentPrep;
        const following = engineState.items.find(
          (candidate) => candidate !== current && candidate.state === "waiting",
        );
        if (following && !engineState.paused) {
          startPrep(following);
        }
        await transferEntry(current, currentPrep);
      } catch (err) {
        const purged = isPurgedOriginalError(err);
        current.state = purged ? "skipped" : "error";
        current.error = purged
          ? "已永久删除，不会重新导入"
          : err instanceof Error
            ? err.message
            : String(err);
        if (purged) current.progress = 1;
        broadcastState();
      } finally {
        prefetchedMap.delete(current.id);
      }
    }
  } finally {
    await Promise.allSettled(prefetchedMap.values());
    for (const id of prefetchedMap.keys()) {
      const item = engineState.items.find((x) => x.id === id);
      if (item?.state === "reading") item.state = "waiting";
    }
    workerLoopActive = false;
    engineState.running = false;
    await wakeSentinel?.release();
    broadcastState();
  }
}

async function walkDirectory(dir: WatchableDirectoryHandle, prefix = ""): Promise<File[]> {
  const collected: File[] = [];
  for await (const handle of dir.values()) {
    if (handle.kind === "file") {
      const file = await (handle as FileSystemFileHandle).getFile();
      Object.defineProperty(file, "webkitRelativePath", {
        value: prefix + handle.name,
      });
      if (SUPPORTED_MEDIA_EXT.test(file.name)) {
        collected.push(file);
      }
    } else {
      collected.push(
        ...(await walkDirectory(handle as WatchableDirectoryHandle, `${prefix}${handle.name}/`)),
      );
    }
  }
  return collected;
}

async function scanWatchedDirectory(): Promise<void> {
  if (!watchedDirHandle || engineState.scanning) return;
  engineState.scanning = true;
  engineState.error = "";
  broadcastState();
  try {
    enqueueUploadFiles(await walkDirectory(watchedDirHandle));
  } catch (err) {
    engineState.error = err instanceof Error ? err.message : String(err);
    stopDirectoryWatch();
  } finally {
    engineState.scanning = false;
    broadcastState();
  }
}

function openSourceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("aura-upload-sources", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("sources");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistDirectoryHandle(dir: WatchableDirectoryHandle): Promise<void> {
  const database = await openSourceDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("sources", "readwrite");
    tx.objectStore("sources").put(dir, "directory");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  database.close();
}

export async function startDirectoryWatch(reconnectSaved = false): Promise<void> {
  try {
    let targetDir: WatchableDirectoryHandle | undefined;
    if (reconnectSaved) {
      const database = await openSourceDatabase();
      targetDir = await new Promise<WatchableDirectoryHandle>((resolve, reject) => {
        const getReq = database.transaction("sources").objectStore("sources").get("directory");
        getReq.onsuccess = () => resolve(getReq.result);
        getReq.onerror = () => reject(getReq.error);
      });
      database.close();
      if (!targetDir) throw new Error("还没有保存的文件夹");
      if ((await targetDir.requestPermission({ mode: "read" })) !== "granted") {
        throw new Error("需要允许读取此文件夹");
      }
    } else {
      const picker = (
        window as unknown as { showDirectoryPicker?: () => Promise<WatchableDirectoryHandle> }
      ).showDirectoryPicker;
      if (!picker) {
        throw new Error("此浏览器不支持持续读取文件夹，请使用 Chrome 或 Apple 客户端");
      }
      targetDir = await picker();
      await persistDirectoryHandle(targetDir);
    }

    stopDirectoryWatch();
    watchedDirHandle = targetDir;
    engineState.sourceName = targetDir.name;
    engineState.watching = true;
    broadcastState();
    await scanWatchedDirectory();
    watchIntervalId = window.setInterval(scanWatchedDirectory, 30000);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    engineState.error = err instanceof Error ? err.message : String(err);
    broadcastState();
  }
}

window.addEventListener("online", () => {
  if (engineState.items.some((x) => x.state === "error")) {
    resumeUploads();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (workerLoopActive) {
    e.preventDefault();
  }
});
