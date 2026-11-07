import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { useIsPresent } from "../core/motion";
import type { CatalogAsset } from "../core/types";
import { PhotoTile } from "./TimelineCanvas";

export function MergePhotosModal({ left, right, onClose, onMerge }: {
  left: CatalogAsset;
  right: CatalogAsset;
  onClose: () => void;
  onMerge: (primary: string) => Promise<void>;
}) {
  const isPresent = useIsPresent();
  const [primary, setPrimary] = useState(left.primary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPresent && !busy && !e.isComposing && !e.defaultPrevented && e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPresent, busy, onClose]);

  async function merge() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onMerge(primary);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onClick={() => { if (!busy) onClose(); }}>
      <section className="modal-card merge-photos-modal" role="dialog" aria-modal="true"
        aria-label="选择归并主版本" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>选择归并主版本</h2>
          <button type="button" className="icon-btn" aria-label="关闭归并" disabled={busy} onClick={onClose}><X size={20} /></button>
        </header>
        <div className="modal-body">
          <p className="merge-preservation-note">两个项目的原件和相片集归属均保留。</p>
          <div className="merge-choices">
            {[left, right].map((asset) => (
              <div key={asset.id} className="merge-choice">
                <PhotoTile asset={asset} selected={primary === asset.primary} selecting disabled={busy}
                  onClick={() => setPrimary(asset.primary)} onToggleSelect={() => setPrimary(asset.primary)} />
                <button type="button" className="merge-primary-choice" aria-pressed={primary === asset.primary}
                  disabled={busy} onClick={() => setPrimary(asset.primary)}>
                  <strong>{asset.name}</strong>
                  <span>{primary === asset.primary ? <><Check size={14} />保留为主版本</> : "选为主版本"}</span>
                </button>
              </div>
            ))}
          </div>
          {error && <div className="inline-alert" role="alert">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy || !!left.deletionPending || !!right.deletionPending}
            onClick={() => void merge()}>{busy ? "正在归并" : "归并，保留所选主版本"}</button>
        </footer>
      </section>
    </div>
  );
}
