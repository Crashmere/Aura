import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Images,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { buildMediaUrl, requestJson } from "../core/client";
import type { AlbumItem, CatalogAsset } from "../core/types";
import { PhotoTile } from "./TimelineCanvas";

export type AlbumModalState =
  | { kind: "create"; assets?: string[] }
  | { kind: "rename"; album: AlbumItem }
  | { kind: "add"; assets: string[] }
  | { kind: "pick"; album: AlbumItem }
  | { kind: "delete"; album: AlbumItem };

function AlbumCoverThumb({
  album,
  retrySeq = 0,
  onBrokenChange,
}: {
  album: AlbumItem;
  retrySeq?: number;
  onBrokenChange?: (broken: boolean) => void;
}) {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
    onBrokenChange?.(false);
  }, [album, retrySeq]);

  useEffect(() => {
    if (!broken) return;
    const handleOnline = () => {
      setBroken(false);
      onBrokenChange?.(false);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [broken, onBrokenChange]);

  const coverSrc = album.cover
    ? buildMediaUrl(
        album.cover.primary,
        "thumb",
        album.cover.rotation,
        album.cover.cover?.revision,
      ) + (retrySeq ? `&retry=${retrySeq}` : "")
    : "";

  return (
    <span className="album-cover">
      {album.cover && !broken ? (
        <img
          src={coverSrc}
          alt=""
          loading="lazy"
          onError={() => {
            setBroken(true);
            onBrokenChange?.(true);
          }}
        />
      ) : (
        <Images size={32} strokeWidth={1.3} />
      )}
    </span>
  );
}

function AlbumGridCard({
  album,
  onSelect,
}: {
  album: AlbumItem;
  onSelect: (album: AlbumItem) => void;
}) {
  const [broken, setBroken] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);

  return (
    <div className="album-card-wrapper">
      <button type="button" className="album-card" onClick={() => onSelect(album)}>
        <AlbumCoverThumb
          album={album}
          retrySeq={retrySeq}
          onBrokenChange={setBroken}
        />
        <div className="album-card-meta">
          <strong>{album.name}</strong>
          <small>{album.count.toLocaleString("zh-CN")} 项</small>
        </div>
      </button>
      {broken && (
        <button
          type="button"
          className="album-cover-retry"
          title="重新加载封面"
          aria-label="重新加载封面"
          onClick={() => setRetrySeq((n) => n + 1)}
        >
          <RefreshCw size={15} />
        </button>
      )}
    </div>
  );
}

export function AlbumsCollectionGrid({
  albums,
  onOpenAlbum,
}: {
  albums: AlbumItem[];
  onOpenAlbum: (album: AlbumItem) => void;
}) {
  return (
    <div className="album-grid">
      {albums.map((album) => (
        <AlbumGridCard key={album.id} album={album} onSelect={onOpenAlbum} />
      ))}
    </div>
  );
}

export function AlbumActionModal({
  state,
  onClose,
  onSaved,
}: {
  state: AlbumModalState;
  onClose: () => void;
  onSaved: (album?: AlbumItem) => void;
}) {
  const [nameInput, setNameInput] = useState(
    state.kind === "rename" ? state.album.name : "",
  );
  const [albumsList, setAlbumsList] = useState<AlbumItem[]>([]);
  const [loadingList, setLoadingList] = useState(state.kind === "add");
  const [isCreatingNew, setIsCreatingNew] = useState(
    state.kind === "create" || state.kind === "rename",
  );
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const modalTitle =
    state.kind === "rename"
      ? "重命名相片集"
      : state.kind === "delete"
        ? "删除相片集"
        : isCreatingNew
          ? "新建相片集"
          : "添加到相片集";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    if (isCreatingNew) inputRef.current?.focus();
  }, [isCreatingNew]);

  useEffect(() => {
    if (state.kind !== "add") return;
    let alive = true;
    requestJson<AlbumItem[]>("albums")
      .then((res) => {
        if (alive) setAlbumsList(res);
      })
      .catch((err) => {
        if (alive) setErrorMsg(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoadingList(false);
      });
    return () => {
      alive = false;
    };
  }, [state]);

  async function commitAction(chosenAlbum?: AlbumItem) {
    if (busy) return;
    setBusy(true);
    setErrorMsg("");
    try {
      if (state.kind === "delete") {
        await requestJson(`albums/${state.album.id}`, undefined, "DELETE");
        onSaved();
      } else if (state.kind === "rename") {
        const updated = await requestJson<AlbumItem>(
          `albums/${state.album.id}`,
          { name: nameInput.trim() },
          "PATCH",
        );
        onSaved(updated);
      } else if (chosenAlbum && state.kind === "add") {
        const updated = await requestJson<AlbumItem>(
          `albums/${chosenAlbum.id}/assets`,
          { assets: state.assets },
        );
        onSaved(updated);
      } else {
        const initialAssets =
          state.kind === "create" || state.kind === "add" ? state.assets || [] : [];
        const created = await requestJson<AlbumItem>("albums", {
          name: nameInput.trim(),
          assets: initialAssets,
        });
        onSaved(created);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const safeDismiss = () => {
    if (!busy) onClose();
  };

  return (
    <div className="modal-scrim album-scrim" onClick={safeDismiss}>
      <section
        className={`modal-card album-modal ${state.kind === "pick" ? "photo-picker-modal" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{state.kind === "pick" ? "添加照片" : modalTitle}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭相片集弹窗"
            disabled={busy}
            onClick={safeDismiss}
          >
            <X size={20} />
          </button>
        </header>

        {state.kind === "pick" ? (
          <AlbumPhotoPickerBody
            album={state.album}
            busy={busy}
            setBusy={setBusy}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <>
            <div className="modal-body">
              {state.kind === "delete" ? (
                <p className="album-modal-note">
                  删除“{state.album.name}”？照片仍保留在照片库中。
                </p>
              ) : isCreatingNew ? (
                <form
                  id="album-name-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void commitAction();
                  }}
                >
                  <label className="album-name-field">
                    <span>相片集名称</span>
                    <input
                      ref={inputRef}
                      aria-label="相片集名称"
                      placeholder="输入名称"
                      value={nameInput}
                      maxLength={100}
                      disabled={busy}
                      onChange={(e) => setNameInput(e.target.value)}
                    />
                  </label>
                  {state.kind === "add" && (
                    <p className="album-modal-note">
                      同时添加已选的 {state.assets.length} 项。
                    </p>
                  )}
                </form>
              ) : (
                <>
                  <p className="album-modal-note">
                    将 {state.kind === "add" ? state.assets.length : 0} 项添加到相片集
                  </p>
                  {loadingList ? (
                    <div className="loading-inline">
                      <LoaderCircle className="spin" size={20} />
                      <span>正在加载</span>
                    </div>
                  ) : (
                    <div className="album-choice-list">
                      {albumsList.map((alb) => (
                        <button
                          type="button"
                          key={alb.id}
                          disabled={busy}
                          onClick={() => void commitAction(alb)}
                        >
                          <AlbumCoverThumb album={alb} />
                          <span>
                            <strong>{alb.name}</strong>
                            <small>{alb.count} 项</small>
                          </span>
                          <Plus size={18} />
                        </button>
                      ))}
                      {!albumsList.length && !errorMsg && (
                        <p className="album-modal-note">
                          还没有相片集，新建一个开始整理。
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
              {errorMsg && (
                <div className="inline-alert" role="alert">
                  {errorMsg}
                </div>
              )}
            </div>

            <footer className="modal-footer">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={safeDismiss}
              >
                取消
              </button>
              {state.kind === "delete" ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => void commitAction()}
                >
                  删除相片集
                </button>
              ) : isCreatingNew ? (
                <button
                  type="submit"
                  form="album-name-form"
                  className="btn btn-primary"
                  disabled={busy || !nameInput.trim()}
                >
                  {busy
                    ? "正在保存"
                    : state.kind === "rename"
                      ? "保存"
                      : "创建"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || loadingList}
                  onClick={() => {
                    setIsCreatingNew(true);
                    setErrorMsg("");
                  }}
                >
                  <Plus size={16} />
                  <span>新建相片集</span>
                </button>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function AlbumPhotoPickerBody({
  album,
  busy,
  setBusy,
  onClose,
  onSaved,
}: {
  album: AlbumItem;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onClose: () => void;
  onSaved: (album: AlbumItem) => void;
}) {
  const [candidates, setCandidates] = useState<CatalogAsset[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [nextCursor, setNextCursor] = useState("");
  const [chosenIds, setChosenIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const reqIdRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  async function fetchCandidates(cursor = "") {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setErrorMsg("");
    try {
      const page = await requestJson<{ items: CatalogAsset[]; next: string }>(
        `assets?${new URLSearchParams({
          q: debouncedQuery,
          cursor,
          excludeAlbum: album.id,
        }).toString()}`,
      );
      if (reqId !== reqIdRef.current) return;
      setCandidates((prev) =>
        cursor
          ? [...prev, ...page.items.filter((a) => !prev.some((b) => a.id === b.id))]
          : page.items,
      );
      setNextCursor(page.next);
    } catch (err) {
      if (reqId === reqIdRef.current) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    setCandidates([]);
    setNextCursor("");
    void fetchCandidates();
    return () => {
      ++reqIdRef.current;
    };
  }, [debouncedQuery]);

  function togglePick(id: string) {
    setChosenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 1000) next.add(id);
      return next;
    });
  }

  async function submitPicked() {
    setBusy(true);
    setErrorMsg("");
    try {
      const updated = await requestJson<AlbumItem>(`albums/${album.id}/assets`, {
        assets: [...chosenIds],
      });
      onSaved(updated);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-body photo-picker-body">
        <div className="picker-toolbar">
          <p>选择照片加入“{album.name}”</p>
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索可添加的照片"
              placeholder="搜索文件名、相机…"
              value={searchInput}
              disabled={busy}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </div>

        {errorMsg && (
          <div className="inline-alert" role="alert">
            <span>{errorMsg}</span>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void fetchCandidates()}
            >
              重试
            </button>
          </div>
        )}

        {!candidates.length && !loading && !errorMsg && (
          <p className="album-modal-note">
            {debouncedQuery
              ? "没有符合条件的照片"
              : "没有可添加的照片，已有项目不会重复显示。"}
          </p>
        )}

        <div className={`photo-grid picker-grid ${busy ? "is-busy" : ""}`}>
          {candidates.map((asset) => (
            <PhotoTile
              key={asset.id}
              asset={asset}
              selected={chosenIds.has(asset.id)}
              selecting
              disabled={busy}
              onClick={() => {
                if (!busy) togglePick(asset.id);
              }}
              onToggleSelect={() => {
                if (!busy) togglePick(asset.id);
              }}
            />
          ))}
        </div>

        {loading ? (
          <div className="loading-inline">
            <LoaderCircle className="spin" size={20} />
            <span>正在加载</span>
          </div>
        ) : (
          nextCursor && (
            <button
              type="button"
              className="btn picker-more-btn"
              disabled={busy}
              onClick={() => void fetchCandidates(nextCursor)}
            >
              加载更多
            </button>
          )
        )}
      </div>

      <footer className="modal-footer">
        <span className="picker-selection-summary">
          <Check size={15} />
          <span>
            已选 {chosenIds.size} 项
            {chosenIds.size === 1000 ? "，已达单次上限" : ""}
          </span>
          {chosenIds.size > 0 && (
            <button
              type="button"
              className="picker-clear-btn"
              disabled={busy}
              onClick={() => setChosenIds(new Set())}
            >
              清空选择
            </button>
          )}
        </span>
        <div className="modal-footer-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !chosenIds.size}
            onClick={() => void submitPicked()}
          >
            {busy
              ? "正在添加"
              : chosenIds.size
                ? `添加 ${chosenIds.size} 项`
                : "添加"}
          </button>
        </div>
      </footer>
    </>
  );
}
