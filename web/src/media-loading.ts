import { useSyncExternalStore } from "react";
import { type Asset, media } from "./api";

export type MediaMode = "auto" | "save" | "quality";
type Connection = EventTarget & { saveData?: boolean; effectiveType?: string; downlink?: number };
const connection = (navigator as Navigator & { connection?: Connection }).connection;
const listeners = new Set<() => void>();
let mode: MediaMode = "auto";
try {
  const saved = localStorage.getItem("aura-media-mode");
  if (saved === "save" || saved === "quality") mode = saved;
} catch { /* Browsing also works with storage disabled. */ }
const emit = () => listeners.forEach(listener => listener());
connection?.addEventListener("change", emit);
window.addEventListener("online", emit);
window.addEventListener("offline", emit);
window.addEventListener("storage", event => {
  if (event.key !== "aura-media-mode") return;
  mode = event.newValue === "save" || event.newValue === "quality" ? event.newValue : "auto";
  emit();
});
function snapshot() {
  return `${mode}:${navigator.onLine}:${!!connection?.saveData}:${connection?.effectiveType || ""}:${connection?.downlink ?? ""}`;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function mediaPolicy() {
  const constrained = !!connection?.saveData || /(^|-)2g$|3g/.test(connection?.effectiveType || "") || (connection?.downlink !== undefined && connection.downlink < 1.5);
  return {
    mode,
    economy: mode === "save" || (mode === "auto" && (!!connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || ""))),
    prefetch: navigator.onLine && mode !== "save" && !constrained,
  };
}
export function setMediaMode(value: MediaMode) {
  mode = value;
  try { localStorage.setItem("aura-media-mode", value); } catch { /* Optional preference. */ }
  emit();
}
export function useMediaPolicy() {
  useSyncExternalStore(subscribe, snapshot);
  return mediaPolicy();
}

// Keep only a few decoded previews; compressed bytes remain in the browser's HTTP cache.
const previews = new Map<string, HTMLImageElement>();
let generation = 0;
let active: HTMLImageElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
export function rememberPreview(image: HTMLImageElement) {
  if (!image.complete || !image.naturalWidth) return;
  const key = new URL(image.src);
  key.search = "";
  previews.delete(key.href);
  previews.set(key.href, image);
  while (previews.size > 3) previews.delete(previews.keys().next().value!);
}
export function cachedPreviewSource(source: string) {
  const key = new URL(source, location.href);
  key.search = "";
  return previews.get(key.href)?.src;
}
export function previewReady(source: string) {
  return !!cachedPreviewSource(source);
}
export function cancelPreloads() {
  ++generation;
  clearTimeout(timer);
  if (active) {
    active.onload = active.onerror = null;
    active.removeAttribute("src");
    active = undefined;
  }
}
export function preloadPreviews(assets: Asset[], delay = 220) {
  cancelPreloads();
  if (!mediaPolicy().prefetch || document.hidden) return;
  const key = generation;
  const sources = [...new Set(assets.filter(a => a.kind !== "video" && a.status === "ready" && !a.deletionPending)
    .map(a => media(a.primary, "preview")))].filter(src => !previewReady(src)).slice(0, 2);
  function next() {
    if (key !== generation || !mediaPolicy().prefetch || document.hidden) return;
    const source = sources.shift();
    if (!source) return;
    const image = new Image();
    active = image;
    image.decoding = "async";
    image.fetchPriority = "low";
    image.onload = async () => {
      try { await image.decode(); } catch { /* The browser may already have decoded it. */ }
      if (key !== generation) return;
      rememberPreview(image);
      active = undefined;
      next();
    };
    image.onerror = () => { if (key === generation) { active = undefined; next(); } };
    image.src = source;
  }
  timer = setTimeout(next, delay);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { cancelPreloads(); previews.clear(); }
});
subscribe(() => { if (!mediaPolicy().prefetch) cancelPreloads(); });
