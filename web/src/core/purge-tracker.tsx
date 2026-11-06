import React, { useEffect, useRef, useState } from "react";
import { CheckCheck, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import { formatByteSize, requestJson } from "./client";
import type { CatalogAsset, PurgeRequestReceipt, PurgeTaskStatus } from "./types";

const LOCAL_STORAGE_KEY = "aura-pending-deletions";
export const PURGE_CONFIRM_TOKEN = "永久删除";

function loadPersistedTasks(): PurgeTaskStatus[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry) =>
          typeof entry?.id === "string" &&
          /^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) &&
          Array.isArray(entry.ids) &&
          entry.ids.every((id: unknown) => typeof id === "string"),
      )
      .slice(-100)
      .map((entry) => ({
        id: entry.id,
        ids: entry.ids,
        state: "pending" as const,
        bytes: 0,
      }));
  } catch {
    return [];
  }
}

export function usePurgeTracker(
  enabled: boolean,
  onCatalogMutated: () => void,
  onPurgeCompleted: (task: PurgeTaskStatus) => void,
  serverPendingCount?: number,
) {
  const [tasks, setTasks] = useState<PurgeTaskStatus[]>(loadPersistedTasks);
  const [pollTrigger, setPollTrigger] = useState(0);
  const [retryingTaskId, setRetryingTaskId] = useState("");
  const handlersRef = useRef({ onCatalogMutated, onPurgeCompleted });
  handlersRef.current = { onCatalogMutated, onPurgeCompleted };

  const activeIdsKey = tasks
    .filter((t) => t.state === "pending")
    .map((t) => t.id)
    .join("|");

  useEffect(() => {
    try {
      localStorage.setItem(
        LOCAL_STORAGE_KEY,
        JSON.stringify(
          tasks
            .filter((t) => t.state === "pending")
            .map(({ id, ids }) => ({ id, ids })),
        ),
      );
    } catch {
      /* Server state remains authoritative */
    }
  }, [tasks]);

  useEffect(() => {
    if (!enabled || !activeIdsKey) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let cycles = 0;

    const handleWake = () => {
      if (document.visibilityState === "visible") {
        setPollTrigger((v) => v + 1);
      }
    };
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("focus", handleWake);

    async function checkAll() {
      for (const taskId of activeIdsKey.split("|")) {
        if (!alive) return;
        try {
          const status = await requestJson<PurgeTaskStatus>(`deletions/${taskId}`);
          if (!alive) return;
          setTasks((prev) => prev.map((t) => (t.id === taskId ? status : t)));
          if (status.state === "complete") {
            handlersRef.current.onCatalogMutated();
            handlersRef.current.onPurgeCompleted(status);
          }
        } catch (err) {
          if (!alive) return;
          setTasks((prev) =>
            prev.map((t) =>
              t.id === taskId
                ? { ...t, error: err instanceof Error ? err.message : String(err) }
                : t,
            ),
          );
        }
      }
      if (alive && ++cycles < 30) {
        timer = setTimeout(checkAll, 2000);
      }
    }

    void checkAll();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("focus", handleWake);
    };
  }, [enabled, activeIdsKey, pollTrigger, serverPendingCount]);

  function registerTask(
    id: string,
    ids: string[] = [],
    state: "pending" | "complete" = "pending",
  ) {
    setTasks((prev) => {
      const existing = prev.find((t) => t.id === id);
      const updated: PurgeTaskStatus = {
        id,
        ids: ids.length ? ids : existing?.ids || [],
        state,
        bytes: existing?.bytes || 0,
      };
      return [...prev.filter((t) => t.id !== id), updated];
    });
    if (state === "complete") {
      handlersRef.current.onPurgeCompleted({ id, ids, state, bytes: 0 });
    } else {
      setPollTrigger((v) => v + 1);
    }
  }

  async function retryTask(task: PurgeTaskStatus) {
    if (retryingTaskId || !task.ids.length) return;
    setRetryingTaskId(task.id);
    try {
      const receipt = await requestJson<PurgeRequestReceipt>("assets/purge", {
        ids: task.ids,
        confirmation: PURGE_CONFIRM_TOKEN,
      });
      registerTask(receipt.requestId, receipt.accepted, receipt.state);
    } catch (err) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? { ...t, error: err instanceof Error ? err.message : String(err) }
            : t,
        ),
      );
    } finally {
      setRetryingTaskId("");
      handlersRef.current.onCatalogMutated();
      setPollTrigger((v) => v + 1);
    }
  }

  return {
    operations: tasks,
    track: registerTask,
    retry: retryTask,
    retrying: retryingTaskId,
    refresh: () => {
      setPollTrigger((v) => v + 1);
      handlersRef.current.onCatalogMutated();
    },
    dismiss: (id: string) => setTasks((prev) => prev.filter((t) => t.id !== id)),
  };
}

export function PurgeStatusBanner({
  tracker,
  hasServerPending,
}: {
  tracker: ReturnType<typeof usePurgeTracker>;
  hasServerPending: boolean;
}) {
  if (!tracker.operations.length && !hasServerPending) return null;

  return (
    <section className="purge-status-banner" aria-label="永久删除进度" aria-live="polite">
      {tracker.operations.map((op) => (
        <article key={op.id} className="purge-status-row">
          <span className="purge-status-icon">
            {op.state === "complete" ? (
              <CheckCheck size={18} />
            ) : (
              <LoaderCircle className="spin" size={18} />
            )}
          </span>
          <div className="purge-status-body">
            <strong>
              {op.state === "complete" ? "永久删除已完成" : "正在永久删除"}
              {op.ids.length ? ` · ${op.ids.length} 项` : ""}
            </strong>
            <small>
              {op.state === "complete"
                ? "原件与对应预览已清理"
                : op.error
                  ? `清理尚未完成：${op.error}`
                  : `清理在服务器继续进行${op.bytes ? ` · 原件 ${formatByteSize(op.bytes)}` : ""}`}
            </small>
          </div>
          <div className="purge-status-actions">
            {op.state === "complete" ? (
              <button
                type="button"
                aria-label="关闭删除完成提示"
                onClick={() => tracker.dismiss(op.id)}
              >
                <X size={16} />
              </button>
            ) : (
              <>
                {op.error && !!op.ids.length && (
                  <button
                    type="button"
                    disabled={!!tracker.retrying}
                    onClick={() => void tracker.retry(op)}
                  >
                    {tracker.retrying === op.id ? "正在重试" : "重试清理"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!!tracker.retrying}
                  onClick={tracker.refresh}
                >
                  <RefreshCw size={14} />
                  刷新状态
                </button>
              </>
            )}
          </div>
        </article>
      ))}
      {!tracker.operations.length && hasServerPending && (
        <article className="purge-status-row">
          <span className="purge-status-icon">
            <LoaderCircle className="spin" size={18} />
          </span>
          <div className="purge-status-body">
            <strong>永久删除正在清理</strong>
            <small>已锁定的项目暂不可恢复，清理完成后会从最近删除中移除。</small>
          </div>
          <div className="purge-status-actions">
            <button type="button" onClick={tracker.refresh}>
              <RefreshCw size={14} />
              刷新状态
            </button>
          </div>
        </article>
      )}
    </section>
  );
}

export function ConfirmPurgeModal({
  targets,
  onClose,
  onConfirm,
}: {
  targets: CatalogAsset[];
  onClose: () => void;
  onConfirm: (ids: string[], confirmation: string) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");
  const busyLock = useRef(false);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const prev = document.activeElement;
    modalRef.current?.focus({ preventScroll: true });
    return () => {
      if (prev instanceof HTMLElement && prev.isConnected) {
        prev.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !busyLock.current) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const safeDismiss = () => {
    if (!busyLock.current) onClose();
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busyLock.current) return;
    busyLock.current = true;
    setSubmitting(true);
    setErrorText("");
    try {
      await onConfirm(
        targets.map((a) => a.id),
        PURGE_CONFIRM_TOKEN,
      );
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      busyLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-scrim purge-scrim" onClick={safeDismiss}>
      <section
        ref={modalRef}
        tabIndex={-1}
        className="modal-card purge-modal"
        role="dialog"
        aria-modal="true"
        aria-label="确认永久删除"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>永久删除 {targets.length} 项照片</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭永久删除弹窗"
            disabled={submitting}
            onClick={safeDismiss}
          >
            <X size={20} />
          </button>
        </header>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="modal-body">
            <p className="purge-warning-line">
              <Trash2 size={19} />
              <span>此操作无法在 Aura 内撤销。</span>
            </p>
            <p className="purge-description">
              会删除这些照片的全部原件、其他版本、实况视频及对应预览，不会删除设备上的 Apple 照片，也不会改动已有备份。
            </p>
            <ul className="purge-target-list">
              {targets.slice(0, 4).map((item) => (
                <li key={item.id}>
                  <strong>{item.name}</strong>
                  <span>{item.variants} 份资源</span>
                </li>
              ))}
              {targets.length > 4 && <li>以及另外 {targets.length - 4} 项</li>}
            </ul>
            {errorText && (
              <div className="inline-alert" role="alert">
                {errorText}
              </div>
            )}
          </div>
          <footer className="modal-footer">
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={safeDismiss}
            >
              取消
            </button>
            <button type="submit" className="btn btn-danger" disabled={submitting}>
              {submitting ? "正在确认删除" : "确认永久删除"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
