import { createSHA256 } from "hash-wasm";
self.onmessage = async (e: MessageEvent<File>) => {
  try {
    const file = e.data,
      h = await createSHA256();
    h.init();
    for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
      h.update(
        new Uint8Array(
          await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer(),
        ),
      );
      self.postMessage({
        progress: Math.min(1, (offset + 8 * 1024 * 1024) / file.size),
      });
    }
    self.postMessage({ hash: h.digest() });
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
