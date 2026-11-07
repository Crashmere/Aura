import { prefersReducedMotion } from "../core/motion";

// Presentation only; the pointer controller and album APIs own movement and persistence.
export function createAlbumDragMotion(root: () => HTMLElement | null) {
  let preview: HTMLElement | null = null;
  let offsetX = 0, offsetY = 0;
  const animations = new Set<Animation>();

  function elements() {
    const found = new Map<string, HTMLElement>();
    root()?.querySelectorAll<HTMLElement>("[data-album-id]").forEach((el) => {
      if (!el.closest(".motion-collapse:not(.is-open)")) found.set(`album:${el.dataset.albumId}`, el);
    });
    root()?.querySelectorAll<HTMLElement>("[data-album-group-id]").forEach((group) => {
      const header = group.querySelector<HTMLElement>(".album-group-header");
      const empty = group.querySelector<HTMLElement>(".album-group-empty");
      if (header) found.set(`group:${group.dataset.albumGroupId}`, header);
      if (empty && !empty.closest(".motion-collapse:not(.is-open)")) found.set(`empty:${group.dataset.albumGroupId}`, empty);
    });
    return found;
  }

  function clearPreview() {
    preview?.remove();
    preview = null;
  }

  function cancelAnimations() {
    for (const animation of animations) animation.cancel();
    animations.clear();
    root()?.removeAttribute("data-album-drop-motion");
  }

  function move(x: number, y: number) {
    if (!preview) return;
    preview.style.left = `${x - offsetX}px`;
    preview.style.top = `${y - offsetY}px`;
  }

  function start(source: HTMLElement, x: number, y: number, count: number) {
    const card = source.closest<HTMLElement>(".album-card, .album-group-header")!;
    const rect = card.getBoundingClientRect();
    clearPreview();
    cancelAnimations();
    const copy = card.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    const width = card.classList.contains("album-card") ? rect.width : Math.min(rect.width, 360);
    copy.style.width = `${width}px`;
    copy.style.height = `${rect.height}px`;
    offsetX = (x - rect.left) * width / Math.max(1, rect.width);
    offsetY = y - rect.top;
    preview = document.createElement("div");
    preview.className = "album-drag-image";
    preview.setAttribute("aria-hidden", "true");
    preview.inert = true;
    preview.append(copy);
    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "album-drag-count";
      badge.textContent = `${count} 个相片集`;
      preview.append(badge);
    }
    document.body.append(preview);
    move(x, y);
  }

  function play(el: HTMLElement, frames: Keyframe[], duration: number) {
    const animation = el.animate(frames, { duration, easing: "cubic-bezier(.22, .8, .25, 1)" });
    animations.add(animation);
    const finish = () => {
      animations.delete(animation);
      if (!animations.size) root()?.removeAttribute("data-album-drop-motion");
    };
    void animation.finished.then(finish, finish);
  }

  function captureDrop(albumIds: string[]) {
    const before = new Map([...elements()].map(([key, el]) => [key, el.getBoundingClientRect()]));
    cancelAnimations();
    root()?.setAttribute("data-album-drop-motion", "");
    return () => {
      if (!root() || prefersReducedMotion()) {
        root()?.removeAttribute("data-album-drop-motion");
        return;
      }
      const moved = new Set(albumIds.map((id) => `album:${id}`));
      const after = elements();
      // Move siblings individually so the dropped card settles only at its final location.
      for (const [key, el] of after) {
        if (moved.has(key)) continue;
        const old = before.get(key);
        if (!old) {
          if (key.startsWith("empty:")) play(el, [{ opacity: 0 }, { opacity: 1 }], 140);
          continue;
        }
        const rect = el.getBoundingClientRect();
        const dx = old.left - rect.left, dy = old.top - rect.top;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) {
          play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], 220);
        }
      }
      const counts = new Set<HTMLElement>();
      for (const id of albumIds) {
        const card = after.get(`album:${id}`)?.querySelector<HTMLElement>(".album-card");
        if (card) {
          play(card, [
            { transform: "scale(1.025)", boxShadow: "0 8px 24px color-mix(in srgb, var(--accent) 16%, transparent)" },
            { transform: "scale(.997)", offset: 0.72 },
            { transform: "none", boxShadow: getComputedStyle(card).boxShadow },
          ], 260);
        } else {
          const group = root()!.querySelector(`[data-album-id="${CSS.escape(id)}"]`)?.closest("[data-album-group-id]");
          const count = group?.querySelector<HTMLElement>(".album-group-toggle small");
          if (count) counts.add(count);
        }
      }
      for (const count of counts) play(count, [{ transform: "scale(1.2)", color: "var(--accent)" }, { transform: "none", color: "var(--text-muted)" }], 220);
      if (!animations.size) root()?.removeAttribute("data-album-drop-motion");
    };
  }

  return { start, move, clearPreview, captureDrop, dispose() { clearPreview(); cancelAnimations(); } };
}
