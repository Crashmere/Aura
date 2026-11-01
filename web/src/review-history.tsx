import { useEffect, useRef, useState } from "react";
import { History, LoaderCircle, RotateCcw, X } from "lucide-react";
import { api, type Asset, type ReviewHistoryItem, type ReviewHistoryPage, displayDate } from "./api";
import { Photo } from "./photo";
import { Button, IconButton } from "./controls";
import "./review-history.css";

export type HistoryKind = "similar" | "split";
export function ReviewHistory({ initialKind, close, changed, open, compare, notify, covered = false }: {
  initialKind: HistoryKind; close: () => void; changed: () => Promise<void>; open: (asset: Asset) => void;
  compare: (left: Asset, right: Asset) => void; notify: (message: string, error?: boolean) => void;
  covered?: boolean;
}) {
  const [kind, setKind] = useState(initialKind);
  const [page, setPage] = useState<ReviewHistoryPage>({ items: [], assets: {}, next: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState("");
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const blocked = useRef(false); blocked.current = covered || !!restoring;
  const currentKind = useRef(kind); currentKind.current = kind;
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented && !blocked.current) { event.preventDefault(); closeRef.current(); } };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); controller.current?.abort(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  async function load(append = false) {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true); setError("");
    try {
      const data = await api<ReviewHistoryPage>("review-history?" + new URLSearchParams({ kind, limit: "20", ...(append && page.next ? { cursor: page.next } : {}) }), undefined, undefined, request.signal);
      if (!request.signal.aborted) setPage(old => append ? { items: [...old.items, ...data.items], assets: { ...old.assets, ...data.assets }, next: data.next } : data);
    } catch (error) { if (!request.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }
  useEffect(() => { setPage({ items: [], assets: {}, next: "" }); void load(); return () => controller.current?.abort(); }, [kind, revision]);
  async function restore(item: ReviewHistoryItem) {
    if (restoring) return;
    const requestedKind = kind;
    setRestoring(item.id);
    try {
      if (kind === "similar") await api("similar/ignore", { left: item.left, right: item.right }, "DELETE");
      else await api(`splits/${item.id}/restore`, {}, "POST");
      if (currentKind.current === requestedKind) setPage(old => ({ ...old, items: old.items.filter(record => record.id !== item.id) }));
      notify(kind === "similar" ? "已撤销确认不同，可重新参与推荐" : "已重新组合，所有原件均已保留");
      await changed();
      if (currentKind.current === requestedKind) setRevision(value => value + 1);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); setRevision(value => value + 1); }
    finally { setRestoring(""); }
  }
  return <div className="modal-backdrop review-history-backdrop" onClick={() => { if (!restoring) close(); }}>
    <section ref={dialog} className="review-history" role="dialog" aria-modal={!covered} aria-label="整理记录" inert={covered} tabIndex={-1} onClick={event => event.stopPropagation()}>
      <header><h2><History size={18} />整理记录</h2><IconButton title="关闭整理记录" disabled={!!restoring} onClick={close}><X size={20} /></IconButton></header>
      <nav className="review-history-tabs" aria-label="记录类型">
        <button aria-pressed={kind === "similar"} disabled={!!restoring} onClick={() => setKind("similar")}>已确认不同</button>
        <button aria-pressed={kind === "split"} disabled={!!restoring} onClick={() => setKind("split")}>分离记录</button>
      </nav>
      <div className="review-history-content">
        {error && <div className="error-banner">{error}<Button onClick={() => void load()}>重试</Button></div>}
        {!page.items.length && !loading && !error && <p className="review-history-empty">{kind === "similar" ? "没有已确认不同的候选" : "没有待恢复的分离记录"}</p>}
        {page.items.map(item => {
          const left = page.assets[item.left], right = page.assets[item.right];
          return <article className="review-history-item" key={item.id}>
            <div className="review-history-photos">{[left, right].map((asset, index) => asset ? <Photo key={index} asset={asset} originalAspect onClick={() => open(asset)} disabled={!!restoring || !!asset.deletionPending} /> : <div key={index} className="history-photo-unavailable">照片已不在图库中</div>)}</div>
            <div className="review-history-info"><strong>{kind === "similar" ? "已确认不同" : item.name || "分离的版本"}</strong><small>{displayDate(item.createdAt, true)} {new Date(item.createdAt).toLocaleTimeString("zh-CN")}</small>
              {item.reason && <p>{item.reason}</p>}
              <div className="review-history-actions">{left && right && left.id !== right.id && <Button disabled={!!restoring || !!left.deletionPending || !!right.deletionPending} onClick={() => compare(left, right)}>对比</Button>}
                <Button disabled={!!restoring || !item.canRestore} onClick={() => void restore(item)}>{restoring === item.id ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}{kind === "similar" ? "撤销确认不同" : "重新组合"}</Button>
              </div>
            </div>
          </article>;
        })}
        {loading && <p className="review-history-empty"><LoaderCircle size={18} className="spin" />正在读取记录</p>}
        {!loading && page.next && <Button disabled={!!restoring} onClick={() => void load(true)}>加载更多记录</Button>}
      </div>
    </section>
  </div>;
}
