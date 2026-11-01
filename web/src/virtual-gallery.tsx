import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Asset } from "./api";

type Group = { date: string; items: Asset[] };
type Row = { group: Group; assets?: Asset[]; top: number; height: number };

export function VirtualGallery({ groups, columns, mobileColumns, heading, photo }: {
  groups: Group[]; columns: number; mobileColumns: number;
  heading: (group: Group) => ReactNode; photo: (asset: Asset) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ width: 800, mobile: innerWidth <= 720 });
  const [range, setRange] = useState({ top: 0, bottom: innerHeight + 900 });
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const layout = useRef("");
  const count = geometry.mobile ? mobileColumns : columns;
  const gap = geometry.mobile ? 2 : 3;
  const { rows, height } = useMemo(() => {
    const rows: Row[] = []; let top = 0;
    const tile = Math.max(1, (geometry.width - (count - 1) * gap) / count);
    for (const group of groups) {
      rows.push({ group, top, height: 42 }); top += 42;
      for (let start = 0; start < group.items.length; start += count) {
        rows.push({ group, assets: group.items.slice(start, start + count), top, height: tile + gap });
        top += tile + gap;
      }
      top += 22 - gap;
    }
    return { rows, height: top };
  }, [groups, count, gap, geometry.width]);
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      setGeometry(previous => previous.width === rect.width && previous.mobile === (innerWidth <= 720) ? previous : { width: rect.width, mobile: innerWidth <= 720 });
      const top = Math.max(0, -rect.top - 700), bottom = Math.max(0, innerHeight - rect.top + 700);
      const card = [...element.querySelectorAll<HTMLElement>(".photo")].find(card => card.getBoundingClientRect().top >= 180);
      if (card) anchor.current = { id: card.dataset.assetId!, offset: card.getBoundingClientRect().top };
      setRange(previous => Math.abs(previous.top - top) < 80 && Math.abs(previous.bottom - bottom) < 80 ? previous : { top, bottom });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule); observer.observe(element);
    window.addEventListener("scroll", schedule, { passive: true }); window.addEventListener("resize", schedule);
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [height]);
  useLayoutEffect(() => {
    const key = `${count}:${geometry.width}`;
    if (layout.current && layout.current !== key && anchor.current && root.current) {
      const saved = anchor.current;
      const row = rows.find(row => row.assets?.some(asset => asset.id === saved.id));
      if (row) window.scrollBy({ top: root.current.getBoundingClientRect().top + row.top - saved.offset, behavior: "instant" });
    }
    layout.current = key;
  }, [count, geometry.width, rows]);
  useLayoutEffect(() => {
    const scroll = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const row = rows.find(row => row.assets?.some(asset => asset.id === id));
      const element = root.current;
      if (row && element) window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top + row.top + row.height / 2 - innerHeight / 2, behavior: "instant" });
    };
    window.addEventListener("aura-gallery-scroll", scroll);
    return () => window.removeEventListener("aura-gallery-scroll", scroll);
  }, [rows]);
  function lowerBound(position: number) {
    let left = 0, right = rows.length;
    while (left < right) { const middle = (left + right) >>> 1; if (rows[middle].top + rows[middle].height < position) left = middle + 1; else right = middle; }
    return left;
  }
  const start = lowerBound(range.top), end = Math.min(rows.length, lowerBound(range.bottom) + 1);
  return <div ref={root} className="virtual-gallery" style={{ height, position: "relative" }}>
    {rows.slice(start, end).map(row => <section className="day-group" key={`${row.group.date}:${row.assets?.[0].id || "heading"}`} style={{ position: "absolute", top: row.top, width: "100%", height: row.height }}>
      {row.assets ? <div className="photo-grid" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, gap }}>{row.assets.map(photo)}</div> : heading(row.group)}
    </section>)}
  </div>;
}
