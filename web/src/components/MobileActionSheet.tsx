import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useIsPresent } from "../core/motion";
import { usePageScrollLock } from "../core/photo-view";

export function MobileActionSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const panel = useRef<HTMLElement>(null);
  usePageScrollLock();

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (present && event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return createPortal(
    <div className={`mobile-sheet-scrim ${present ? "" : "is-closing"}`}
      onClick={onClose} inert={!present} aria-hidden={!present || undefined}>
      <section ref={panel} className="mobile-action-sheet" role="dialog"
        aria-modal="true" aria-label={title} tabIndex={-1}
        onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label={`关闭${title}`} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="mobile-sheet-content">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
