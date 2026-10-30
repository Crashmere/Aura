import { useEffect, useRef, useState } from "react";
import { CheckCheck, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import { api, Asset, bytes, DeletionOperation, PurgeResponse } from "./api";

const storageKey = "aura-pending-deletions";
const confirmationText = "永久删除";

function savedOperations(): DeletionOperation[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(item => typeof item?.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(item.id) && Array.isArray(item.ids) && item.ids.every((id: unknown) => typeof id === "string")).slice(-100).map(item => ({ id: item.id, ids: item.ids, state: "pending", bytes: 0 }));
  } catch { return []; }
}

export function useDeletionOperations(enabled: boolean, changed: () => void, completed: (operation: DeletionOperation) => void, pendingCount?: number) {
  const [operations, setOperations] = useState<DeletionOperation[]>(savedOperations);
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState("");
  const callbacks = useRef({ changed, completed });
  callbacks.current = { changed, completed };
  const pendingKey = operations.filter(operation => operation.state === "pending").map(operation => operation.id).join("|");
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(operations.filter(operation => operation.state === "pending").map(({ id, ids }) => ({ id, ids }))));
    } catch { /* Server intent remains durable when local storage is unavailable. */ }
  }, [operations]);
  useEffect(() => {
    if (!enabled || !pendingKey) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const resume = () => { if (document.visibilityState === "visible") setRefresh(value => value + 1); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    async function poll() {
      for (const id of pendingKey.split("|")) {
        if (!active) return;
        try {
          const operation = await api<DeletionOperation>(`deletions/${id}`);
          if (!active) return;
          setOperations(old => old.map(item => item.id === id ? operation : item));
          if (operation.state === "complete") {
            callbacks.current.changed();
            callbacks.current.completed(operation);
          }
        } catch (error) {
          if (!active) return;
          setOperations(old => old.map(item => item.id === id ? { ...item, error: error instanceof Error ? error.message : String(error) } : item));
        }
      }
      // A closed or idle page must not poll forever; the server owns cleanup.
      if (active && ++attempts < 30) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [enabled, pendingKey, refresh, pendingCount]);

  function track(id: string, ids: string[] = [], state: "pending" | "complete" = "pending") {
    setOperations(old => {
      const previous = old.find(item => item.id === id);
      const operation = { id, ids: ids.length ? ids : previous?.ids || [], state, bytes: previous?.bytes || 0 };
      return [...old.filter(item => item.id !== id), operation];
    });
    if (state === "complete") callbacks.current.completed({ id, ids, state, bytes: 0 });
    else setRefresh(value => value + 1);
  }
  async function retry(operation: DeletionOperation) {
    if (retrying || !operation.ids.length) return;
    setRetrying(operation.id);
    try {
      const response = await api<PurgeResponse>("assets/purge", { ids: operation.ids, confirmation: confirmationText });
      track(response.requestId, response.accepted, response.state);
    } catch (error) {
      setOperations(old => old.map(item => item.id === operation.id ? { ...item, error: error instanceof Error ? error.message : String(error) } : item));
    } finally {
      setRetrying("");
      callbacks.current.changed();
      setRefresh(value => value + 1);
    }
  }
  return {
    operations,
    track,
    retry,
    retrying,
    refresh: () => { setRefresh(value => value + 1); callbacks.current.changed(); },
    dismiss: (id: string) => setOperations(old => old.filter(item => item.id !== id)),
  };
}

export function DeletionProgress({ state, otherPending }: { state: ReturnType<typeof useDeletionOperations>; otherPending: boolean }) {
  if (!state.operations.length && !otherPending) return null;
  return (
    <section className="deletion-progress" aria-label="永久删除进度" aria-live="polite">
      {state.operations.map(operation => (
        <article key={operation.id}>
          {operation.state === "complete" ? <CheckCheck size={18} /> : <LoaderCircle className="spin" size={18} />}
          <div><strong>{operation.state === "complete" ? "永久删除已完成" : "正在永久删除"}{operation.ids.length ? ` · ${operation.ids.length} 项` : ""}</strong>
            <small>{operation.state === "complete" ? "原件与对应预览已清理" : operation.error ? `清理尚未完成：${operation.error}` : `清理在服务器继续进行${operation.bytes ? ` · 原件 ${bytes(operation.bytes)}` : ""}`}</small></div>
          {operation.state === "complete" ? <button aria-label="关闭删除完成提示" onClick={() => state.dismiss(operation.id)}><X size={16} /></button> : <>
            {operation.error && !!operation.ids.length && <button disabled={!!state.retrying} onClick={() => void state.retry(operation)}>{state.retrying === operation.id ? "正在重试" : "重试清理"}</button>}
            <button disabled={!!state.retrying} onClick={state.refresh}><RefreshCw size={14} />刷新状态</button>
          </>}
        </article>
      ))}
      {!state.operations.length && otherPending && <article><LoaderCircle className="spin" size={18} /><div><strong>永久删除正在清理</strong><small>已锁定的项目暂不可恢复，清理完成后会从最近删除中移除。</small></div><button onClick={state.refresh}>刷新状态</button></article>}
    </section>
  );
}

export function PermanentDeleteDialog({ targets, close, submit }: {
  targets: Asset[];
  close: () => void;
  submit: (ids: string[], confirmation: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !lock.current) close(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);
  const dismiss = () => { if (!lock.current) close(); };
  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || confirmation.trim() !== confirmationText) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try { await submit(targets.map(asset => asset.id), confirmation.trim()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return (
    <div className="modal-backdrop deletion-backdrop" onClick={dismiss}>
      <section className="dialog permanent-delete-dialog" role="dialog" aria-modal="true" aria-label="确认永久删除" onClick={event => event.stopPropagation()}>
        <header className="dialog-title"><h2>永久删除 {targets.length} 项照片</h2><button className="icon-button" aria-label="关闭永久删除弹窗" disabled={busy} onClick={dismiss}><X size={20} /></button></header>
        <form onSubmit={event => void confirm(event)}>
          <div className="dialog-content">
            <p className="deletion-warning"><Trash2 size={20} />此操作无法在 Aura 内撤销。</p>
            <p className="deletion-note">会删除这些照片的全部原件、其他版本、实况视频及对应预览，不会删除设备上的 Apple 照片，也不会改动已有备份。</p>
            <ul className="deletion-targets">{targets.slice(0, 4).map(asset => <li key={asset.id}>{asset.name}<span>{asset.variants} 份资源</span></li>)}{targets.length > 4 && <li>以及另外 {targets.length - 4} 项</li>}</ul>
            <label className="deletion-confirm-label">输入“永久删除”确认<input ref={input} aria-label="永久删除确认文字" placeholder="永久删除" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></label>
            {error && <div className="error-banner" role="alert">{error}</div>}
          </div>
          <footer className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={dismiss}>取消</button><button className="button danger" type="submit" disabled={busy || confirmation.trim() !== confirmationText}>{busy ? "正在确认删除" : "确认永久删除"}</button></footer>
        </form>
      </section>
    </div>
  );
}
