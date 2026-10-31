import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Camera, Check, FileImage, SlidersHorizontal, X } from "lucide-react";
import { emptyFilters, filterOptions, type FilterDraft } from "./library-filters";
import { localDay } from "./api";
import "./filter-panel.css";

export function FilterPanel({ value, anchor, apply, close }: {
  value: FilterDraft;
  anchor: RefObject<HTMLButtonElement | null>;
  apply: (value: FilterDraft) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [sizeInputs, setSizeInputs] = useState({
    minSize: value.minSize ? String(Number((Number(value.minSize) / 1048576).toFixed(6))) : "",
    maxSize: value.maxSize ? String(Number((Number(value.maxSize) / 1048576).toFixed(6))) : "",
  });
  const [closing, setClosing] = useState(false);
  const [position, setPosition] = useState({ top: 100, right: 24, maxHeight: 640 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panel = useRef<HTMLElement>(null);
  const set = (key: keyof FilterDraft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  function dismiss() {
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(close, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const width = Math.min(560, innerWidth - 32);
      const top = Math.max(16, Math.min((rect?.bottom || 76) + 10, innerHeight - 420));
      const left = Math.max(16, Math.min(rect?.left || 24, innerWidth - width - 16));
      setPosition({ top, right: innerWidth - left - width, maxHeight: Math.min(720, innerHeight - top - 16) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  function quickDate(days?: number) {
    const end = new Date();
    const start = new Date(end);
    if (days) start.setDate(start.getDate() - days + 1);
    else { start.setMonth(0, 1); }
    setDraft(previous => ({ ...previous, from: localDay(start), to: localDay(end) }));
  }
  const select = (key: keyof typeof filterOptions, label: string) => <label className="filter-field"><span>{label}</span><select aria-label={label} value={draft[key]} onChange={event => set(key, event.target.value)}><option value="">全部</option>{filterOptions[key].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
  const range = (low: "minSize" | "minMP", high: "maxSize" | "maxMP", label: string, unit: string, divisor: number) => <fieldset className="filter-range"><legend>{label} <small>{unit}</small></legend><div>
    <input aria-label={`最小${label}`} type="number" min="0" step="any" placeholder="最小" value={low === "minSize" ? sizeInputs.minSize : draft[low]} onChange={event => { const value = event.target.value; if (low === "minSize") setSizeInputs(previous => ({ ...previous, minSize: value })); set(low, value === "" || divisor === 1 ? value : String(Math.round(Number(value) * divisor))); }} />
    <span>—</span>
    <input aria-label={`最大${label}`} type="number" min="0" step="any" placeholder="最大" value={high === "maxSize" ? sizeInputs.maxSize : draft[high]} onChange={event => { const value = event.target.value; if (high === "maxSize") setSizeInputs(previous => ({ ...previous, maxSize: value })); set(high, value === "" || divisor === 1 ? value : String(Math.round(Number(value) * divisor))); }} />
  </div></fieldset>;
  const dates = (low: "from" | "addedFrom", high: "to" | "addedTo", label: string) => <fieldset className="filter-range filter-dates"><legend>{label}</legend><div>
    <input aria-label={`${label}开始`} type="date" value={draft[low]} max={draft[high] || undefined} onChange={event => set(low, event.target.value)} />
    <span>—</span>
    <input aria-label={`${label}结束`} type="date" value={draft[high]} min={draft[low] || undefined} onChange={event => set(high, event.target.value)} />
  </div></fieldset>;
  const invalidRange = (draft.from && draft.to && draft.from > draft.to) || (draft.addedFrom && draft.addedTo && draft.addedFrom > draft.addedTo) || (draft.minSize && draft.maxSize && Number(draft.minSize) > Number(draft.maxSize)) || (draft.minMP && draft.maxMP && Number(draft.minMP) > Number(draft.maxMP));
  return createPortal(<div className={`filter-scrim ${closing ? "is-closing" : ""}`} onClick={dismiss}>
    <section ref={panel} className="filter-panel" style={position} id="library-filters" role="dialog" aria-modal="true" aria-labelledby="filter-panel-title" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <form onSubmit={event => { event.preventDefault(); if (!invalidRange && !closing) { apply(draft); dismiss(); } }}>
        <header><h2 id="filter-panel-title"><SlidersHorizontal size={18} />筛选照片</h2><button className="icon-button" type="button" aria-label="关闭筛选" onClick={dismiss}><X size={19} /></button></header>
        <div className="filter-panel-content">
          <section className="filter-section"><h3><FileImage size={15} />照片内容</h3><div className="filter-fields">
            {select("kind", "媒体类型")}{select("format", "原件格式")}{select("orientation", "构图")}{select("location", "定位信息")}
            {select("versions", "照片版本")}{select("albumState", "相片集归属")}
          </div></section>
          <section className="filter-section"><h3><CalendarDays size={15} />日期</h3>
            <div className="filter-presets"><button type="button" onClick={() => quickDate(7)}>最近 7 天</button><button type="button" onClick={() => quickDate(30)}>最近 30 天</button><button type="button" onClick={() => quickDate()}>今年</button></div>
            {dates("from", "to", "拍摄日期")}{dates("addedFrom", "addedTo", "导入日期")}
          </section>
          <section className="filter-section"><h3><Camera size={15} />拍摄设备</h3><div className="filter-fields">
            <label className="filter-field"><span>相机品牌或型号</span><input aria-label="相机品牌或型号" placeholder="如 Apple、iPhone、Canon" value={draft.camera} onChange={event => set("camera", event.target.value)} /></label>
            <label className="filter-field"><span>镜头</span><input aria-label="镜头" placeholder="镜头型号或名称" value={draft.lens} onChange={event => set("lens", event.target.value)} /></label>
          </div></section>
          <section className="filter-section"><h3><SlidersHorizontal size={15} />文件与处理</h3><div className="filter-fields">
            {range("minMP", "maxMP", "像素数", "MP", 1)}{range("minSize", "maxSize", "原件大小", "MB", 1048576)}
            {select("status", "处理状态")}
          </div><p className="filter-field-note">像素数、构图、大小和处理状态按主版本筛选。</p></section>
          {invalidRange && <p className="filter-validation" role="alert">范围的起点不能大于终点</p>}
        </div>
        <footer><button type="button" className="filter-reset" onClick={() => { setDraft({ ...emptyFilters(), from: "", to: "" }); setSizeInputs({ minSize: "", maxSize: "" }); }}>重置</button><button type="button" className="button" onClick={dismiss}>取消</button><button type="submit" className="button primary" disabled={!!invalidRange || closing}><Check size={16} />应用筛选</button></footer>
      </form>
    </section>
  </div>, document.body);
}
