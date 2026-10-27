import exifr from "exifr";
import { api, base, localDay } from "./api";

export type UploadItem = {
  id: string;
  file: File;
  name: string;
  state:
    | "waiting"
    | "reading"
    | "uploading"
    | "done"
    | "duplicate"
    | "skipped"
    | "error";
  progress: number;
  error?: string;
  date?: string;
};
export type UploadState = {
  items: UploadItem[];
  running: boolean;
  paused: boolean;
  scanning: boolean;
  watching: boolean;
  sourceName: string;
  from: string;
  to: string;
  error: string;
};
type Session = {
  id: string;
  offset: number;
  complete: boolean;
  duplicate?: boolean;
  filtered?: boolean;
  chunkSize: number;
};
type Directory = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  requestPermission(o: { mode: string }): Promise<string>;
};
const supported =
  /\.(jpe?g|heic|heif|png|webp|gif|tiff?|avif|jxl|dng|cr[23]|nef|arw|raf|rw2|orf|pef|srw|mov|mp4|m4v|avi|mkv|mts|3gp|aae|xmp)$/i;
let state: UploadState = {
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
const listeners = new Set<() => void>();
let active = false;
let directory: Directory | undefined;
let timer: number | undefined;
const emit = () => {
  state = { ...state, items: [...state.items] };
  listeners.forEach((fn) => fn());
};
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const snapshot = () => state;
export function configure(from: string, to: string) {
  state.from = from;
  state.to = to;
  emit();
}
export function pause() {
  state.paused = true;
  emit();
}
export function resume() {
  state.paused = false;
  for (const item of state.items) {
    if (item.state === "error") {
      item.state = "waiting";
      item.error = undefined;
    }
  }
  emit();
  void run();
}
export function clearFinished() {
  state.items = state.items.filter(
    (i) => !["done", "duplicate", "skipped"].includes(i.state),
  );
  emit();
}
export function stopWatch() {
  if (timer) clearInterval(timer);
  timer = undefined;
  state.watching = false;
  directory = undefined;
  emit();
}
export function addFiles(files: File[]) {
  const seen = new Set(
    state.items
      .filter((x) => x.state !== "error")
      .map((x) => `${x.name}|${x.file.size}|${x.file.lastModified}`),
  );
  for (const file of files) {
    const name = file.webkitRelativePath || file.name,
      key = `${name}|${file.size}|${file.lastModified}`;
    if (supported.test(name) && !seen.has(key)) {
      state.items.push({
        id: crypto.randomUUID(),
        file,
        name,
        state: "waiting",
        progress: 0,
      });
      seen.add(key);
    }
  }
  emit();
  void run();
}
function hashFile(file: File, progress: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      if (e.data.hash) {
        worker.terminate();
        resolve(e.data.hash);
      } else if (e.data.error) {
        worker.terminate();
        reject(new Error(e.data.error));
      } else progress(e.data.progress);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(file);
  });
}
async function fileDate(file: File): Promise<Date> {
  try {
    const m = await exifr.parse(file, {
      pick: ["DateTimeOriginal", "CreateDate"],
      reviveValues: true,
    });
    const date = m?.DateTimeOriginal || m?.CreateDate;
    if (date instanceof Date && !isNaN(+date)) return date;
  } catch {
    /* Containers without EXIF are checked by the server. */
  }
  return new Date(file.lastModified);
}
async function upload(item: UploadItem) {
  item.state = "reading";
  emit();
  const date = await fileDate(item.file);
  item.date = localDay(date);
  // The server makes the final range decision from original metadata; QuickTime/HEIC browser parsing is not authoritative.
  const hash = await hashFile(item.file, (n) => {
    item.progress = n * 0.05;
    emit();
  });
  let session = await api<Session>("uploads", {
    hash,
    name: item.file.name,
    size: item.file.size,
    capturedAt: date.toISOString(),
    modifiedAt: new Date(item.file.lastModified).toISOString(),
    from: state.from,
    to: state.to,
  });
  if (session.complete) {
    item.state = session.filtered ? "skipped" : "duplicate";
    item.progress = 1;
    emit();
    return;
  }
  item.state = "uploading";
  emit();
  let offset = session.offset,
    failures = 0;
  while (offset < item.file.size) {
    if (state.paused) {
      item.state = "waiting";
      emit();
      return;
    }
    try {
      const response = await fetch(`${base}api/uploads/${hash}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/octet-stream",
          "Upload-Offset": String(offset),
        },
        body: item.file.slice(offset, offset + session.chunkSize),
        signal: AbortSignal.timeout(120000),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && typeof data.offset === "number") {
        offset = data.offset;
        continue;
      }
      if (!response.ok)
        throw new Error(
          data.error ||
            (response.status === 401
              ? "请返回门户重新登录"
              : `上传失败 (${response.status})`),
        );
      offset = data.offset;
      failures = 0;
      item.progress = 0.05 + (0.95 * offset) / item.file.size;
      emit();
    } catch (e) {
      if (++failures > 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
      session = await api<Session>(`uploads/${hash}`);
      offset = session.offset;
      if (session.complete) break;
    }
  }
  const result = await api<{ filtered?: boolean }>(
    `uploads/${hash}/complete`,
    {},
  );
  item.state = result.filtered ? "skipped" : "done";
  item.progress = 1;
  emit();
  window.dispatchEvent(new Event("aura-library-changed"));
}
async function run() {
  if (active || state.paused) return;
  active = true;
  state.running = true;
  emit();
  let wake: WakeLockSentinel | undefined;
  try {
    wake = await navigator.wakeLock?.request("screen");
  } catch {
    /* The upload also works when wake lock is unavailable. */
  }
  try {
    while (!state.paused) {
      const item = state.items.find((i) => i.state === "waiting");
      if (!item) break;
      try {
        await upload(item);
      } catch (e) {
        item.state = "error";
        item.error = e instanceof Error ? e.message : String(e);
        emit();
      }
    }
  } finally {
    active = false;
    state.running = false;
    await wake?.release();
    emit();
  }
}
async function scan(dir: Directory, prefix = ""): Promise<File[]> {
  const result: File[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === "file") {
      const file = await (entry as FileSystemFileHandle).getFile();
      Object.defineProperty(file, "webkitRelativePath", {
        value: prefix + entry.name,
      });
      if (supported.test(file.name)) result.push(file);
    } else
      result.push(
        ...(await scan(entry as Directory, prefix + entry.name + "/")),
      );
  }
  return result;
}
async function rescan() {
  if (!directory || state.scanning) return;
  state.scanning = true;
  state.error = "";
  emit();
  try {
    addFiles(await scan(directory));
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    stopWatch();
  } finally {
    state.scanning = false;
    emit();
  }
}
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("aura-upload-sources", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sources");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function saveDir(dir: Directory) {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction("sources", "readwrite");
    t.objectStore("sources").put(dir, "directory");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  d.close();
}
export async function watchDirectory(reconnect = false) {
  try {
    let chosen: Directory | undefined;
    if (reconnect) {
      const d = await db();
      chosen = await new Promise<Directory>((resolve, reject) => {
        const q = d
          .transaction("sources")
          .objectStore("sources")
          .get("directory");
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      d.close();
      if (!chosen) throw new Error("还没有保存的文件夹");
      if ((await chosen.requestPermission({ mode: "read" })) !== "granted")
        throw new Error("需要允许读取此文件夹");
    } else {
      const picker = (
        window as unknown as { showDirectoryPicker(): Promise<Directory> }
      ).showDirectoryPicker;
      if (!picker)
        throw new Error(
          "此浏览器不支持持续读取文件夹，请使用 Chrome 或 Apple 客户端",
        );
      chosen = await picker();
      await saveDir(chosen);
    }
    stopWatch();
    directory = chosen;
    state.sourceName = chosen.name;
    state.watching = true;
    emit();
    await rescan();
    timer = window.setInterval(rescan, 30000);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    state.error = e instanceof Error ? e.message : String(e);
    emit();
  }
}
window.addEventListener("online", () => {
  if (state.items.some((i) => i.state === "error")) resume();
});
window.addEventListener("beforeunload", (e) => {
  if (active) {
    e.preventDefault();
  }
});
