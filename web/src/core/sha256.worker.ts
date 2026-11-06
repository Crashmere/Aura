import { createSHA256 } from "hash-wasm";

const SLICE_BYTES = 8 * 1024 * 1024;

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const sourceFile = event.data;
    const hasher = await createSHA256();
    hasher.init();

    for (let offset = 0; offset < sourceFile.size; offset += SLICE_BYTES) {
      const slice = sourceFile.slice(offset, offset + SLICE_BYTES);
      const buffer = await slice.arrayBuffer();
      hasher.update(new Uint8Array(buffer));
      self.postMessage({
        progress: Math.min(1, (offset + SLICE_BYTES) / sourceFile.size),
      });
    }

    self.postMessage({ hash: hasher.digest() });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
