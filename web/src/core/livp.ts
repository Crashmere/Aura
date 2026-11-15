import type { FileEntry } from "@zip.js/zip.js/lib/zip-core-native.js";

const MAX_LIVP_BYTES = 512 * 1024 * 1024;
const MAX_LIVP_ENTRIES = 64;
const STILL_EXT = /\.(jpe?g|heic|heif)$/i;
const MOTION_EXT = /\.mov$/i;
const SIDECAR_EXT = /\.(aae|xmp)$/i;

export const isLivpFile = (file: File): boolean => /\.livp$/i.test(file.name);

export interface LivpResource {
  file: File;
  path: string;
  resourceType: "originalPhoto" | "originalPairedVideo" | "sidecar";
}

export async function readLivp(file: File, onProgress: (ratio: number) => void): Promise<LivpResource[]> {
  if (file.size > MAX_LIVP_BYTES) throw new Error("LIVP 超过 512 MiB，请解压后分别上传原件");
  const { BlobReader, ZipReader } = await import("@zip.js/zip.js/lib/zip-core-native.js");
  const reader = new ZipReader(new BlobReader(file), {
    useWebWorkers: false,
    strictness: "strict",
    checkCrc32: true,
    checkOverlappingEntry: true,
  });
  try {
    const entries: FileEntry[] = [];
    let count = 0;
    let total = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > MAX_LIVP_ENTRIES) throw new Error("LIVP 内文件过多，无法确定实况资源");
      const path = entry.filename.replaceAll("\\", "/");
      if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) {
        throw new Error("LIVP 内含无效文件路径");
      }
      const name = path.split("/").pop() || "";
      if (entry.directory || path.split("/").includes("__MACOSX") || name.startsWith(".") || name === "Thumbs.db") continue;
      if (entry.encrypted) throw new Error("不支持加密的 LIVP，请解密后上传");
      if (!STILL_EXT.test(name) && !MOTION_EXT.test(name) && !SIDECAR_EXT.test(name)) {
        throw new Error(`LIVP 内含不支持的资源：${name}`);
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize <= 0) {
        throw new Error("LIVP 内含空文件或无效文件大小");
      }
      total += entry.uncompressedSize;
      if (total > MAX_LIVP_BYTES) throw new Error("LIVP 解包后超过 512 MiB，请解压后分别上传原件");
      entries.push(entry);
    }
    if (entries.filter((entry) => STILL_EXT.test(entry.filename)).length !== 1 ||
        entries.filter((entry) => MOTION_EXT.test(entry.filename)).length !== 1) {
      throw new Error("LIVP 必须包含一张 JPG/HEIC 照片和一段 MOV 视频，无法确定配对");
    }
    // Validate every resource before enqueueing any of them, including actual output size and CRC.
    const resources: LivpResource[] = [];
    let completed = 0;
    for (const entry of entries) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.byteLength;
          if (size > entry.uncompressedSize) throw new Error("LIVP 解包大小与记录不符");
          chunks.push(new Uint8Array(chunk));
          onProgress((completed + size) / total);
        },
      }));
      if (size !== entry.uncompressedSize) throw new Error("LIVP 资源不完整");
      const path = entry.filename.replaceAll("\\", "/");
      const name = path.split("/").pop()!;
      const resourceType = STILL_EXT.test(name) ? "originalPhoto" : MOTION_EXT.test(name) ? "originalPairedVideo" : "sidecar";
      resources.push({
        file: new File(chunks, name, { lastModified: entry.lastModDate?.getTime() || file.lastModified }),
        path,
        resourceType,
      });
      completed += size;
    }
    return resources;
  } catch (error) {
    throw new Error(`LIVP 解包失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await reader.close();
  }
}
