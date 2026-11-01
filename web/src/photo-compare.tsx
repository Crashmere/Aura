import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Columns2, Layers3, X } from "lucide-react";
import { type Asset } from "./api";
import { ProgressiveImage } from "./progressive-image";
import { IconButton } from "./controls";
import "./photo-compare.css";

export function PhotoCompare({ left, right, close }: { left: Asset; right: Asset; close: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [mode, setMode] = useState<"side" | "overlay">("side");
  const [position, setPosition] = useState(50);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const image = (asset: Asset) => <div className="compare-image"><ProgressiveImage key={asset.primary} asset={asset} onReady={() => {}} /></div>;
  return <div ref={root} className={`photo-comparison ${mode === "overlay" ? "is-overlay" : ""}`} role="dialog" aria-modal="true" aria-label="照片对比" tabIndex={-1}>
    <header className="comparison-header"><h2>照片对比</h2><div className="comparison-modes" role="group" aria-label="对比方式">
      <button aria-pressed={mode === "side"} onClick={() => setMode("side")}><Columns2 size={16} />并排</button>
      <button aria-pressed={mode === "overlay"} onClick={() => setMode("overlay")}><Layers3 size={16} />叠加</button>
    </div><IconButton title="关闭对比（Esc）" onClick={close}><X size={21} /></IconButton></header>
    <div className="comparison-labels"><span><strong>A · {left.name}</strong><small>{left.width} × {left.height}</small></span><span><strong>B · {right.name}</strong><small>{right.width} × {right.height}</small></span></div>
    {mode === "side" ? <div className="comparison-side"><section aria-label={`照片 A：${left.name}`}>{image(left)}</section><section aria-label={`照片 B：${right.name}`}>{image(right)}</section></div> : <div className="comparison-overlay" style={{ "--compare-position": `${position}%` } as CSSProperties}>
      <section aria-label={`照片 B：${right.name}`}>{image(right)}</section><section className="comparison-reveal" aria-label={`照片 A：${left.name}`}>{image(left)}</section>
      <div className="comparison-divider" aria-hidden="true" onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
        setPosition(Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)));
      }}><span>↔</span></div>
    </div>}
    {mode === "overlay" && <footer className="comparison-slider"><span>A</span><input aria-label="叠加对比位置" type="range" min="0" max="100" value={position} onChange={event => setPosition(Number(event.target.value))} /><span>B</span></footer>}
  </div>;
}
