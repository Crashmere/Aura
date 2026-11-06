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
import { useIsPresent } from "../core/motion";
import type { AlbumItem, CatalogAsset } from "../core/types";
import { PhotoTile } from "./TimelineCanvas";

export type AlbumModalState =
  | { kind: "create"; assets?: string[] }
  | { kind: "rename"; album: AlbumItem }
  | { kind: "add"; assets: string[] }
  | { kind: "pick"; album: AlbumItem }
  | { kind: "cover"; album: AlbumItem }
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
  const isPresent = useIsPresent();
  const [nameInput, setNameInput] = useState(
    state.kind === "rename" ? state.album.name : "",
  );
  const [albumsList, setAlbumsList] = useState<AlbumItem[]>([]);
  const [loadingList, setLoadingList] = useState(state.kind === "add");
  const [isCreatingNew, setIsCreatingNew] = useState(
    state.kind === "create" || state.kind === "rename",
  );
  const [busy, setBusy] = useState(false);
  const [pendingAlbumId, setPendingAlbumId] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isPhotoPicker = state.kind === "pick" || state.kind === "cover";

  const modalTitle =
    state.kind === "cover"
      ? "选择相片集封面"
      : state.kind === "pick"
        ? "添加照片"
        : state.kind === "rename"
          ? "重命名相片集"
          : state.kind === "delete"
            ? "删除相片集"
            : isCreatingNew
              ? "新建相片集"
              : "添加到相片集";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        isPresent &&
        e.key === "Escape" &&
        !e.isComposing &&
        !e.defaultPrevented &&
        !busy
      ) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, isPresent]);

  useEffect(() => {
    if (isPresent && isCreatingNew) inputRef.current?.focus();
  }, [isCreatingNew, isPresent]);

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
    setPendingAlbumId(chosenAlbum?.id || "");
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
      setPendingAlbumId("");
    }
  }

  const safeDismiss = () => {
    if (!busy) onClose();
  };

  return (
    <div className="modal-scrim album-scrim" onClick={safeDismiss}>
      <section
        className={`modal-card album-modal ${isPhotoPicker ? "photo-picker-modal" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{modalTitle}</h2>
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

        {state.kind === "pick" || state.kind === "cover" ? (
          <AlbumPhotoPickerBody
            album={state.album}
            mode={state.kind === "cover" ? "cover" : "add"}
            busy={busy}
            setBusy={setBusy}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <>
            <div className="modal-body" key={isCreatingNew ? "name" : "albums"}>
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
                          data-pending={pendingAlbumId === alb.id}
                          onClick={() => void commitAction(alb)}
                        >
                          <AlbumCoverThumb album={alb} />
                          <span>
                            <strong>{alb.name}</strong>
                            <small>{alb.count} 项</small>
                          </span>
                          {pendingAlbumId === alb.id ? (
                            <LoaderCircle size={18} className="spin" />
                          ) : (
                            <Plus size={18} />
                          )}
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
  mode,
  busy,
  setBusy,
  onClose,
  onSaved,
}: {
  album: AlbumItem;
  mode: "add" | "cover";
  busy: boolean;
  setBusy: (b: boolean) => void;
  onClose: () => void;
  onSaved: (album: AlbumItem) => void;
}) {
  const [candidates, setCandidates] = useState<CatalogAsset[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [nextCursor, setNextCursor] = useState("");
  const [chosenIds, setChosenIds] = useState<Set<string>>(
    () => new Set(mode === "cover" && album.cover ? [album.cover.id] : []),
  );
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
          ...(mode === "cover" ? { album: album.id } : { excludeAlbum: album.id }),
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
  }, [debouncedQuery, album.id, mode]);

  function togglePick(id: string) {
    setChosenIds((prev) => {
      if (mode === "cover") return new Set(prev.has(id) ? [] : [id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 1000) next.add(id);
      return next;
    });
  }

  async function submitPicked(automatic = false) {
    if (busy) return;
    setBusy(true);
    setErrorMsg("");
    try {
      const updated = mode === "cover"
        ? await requestJson<AlbumItem>(
            `albums/${album.id}/cover`,
            { assetId: automatic ? null : [...chosenIds][0] },
            "PATCH",
          )
        : await requestJson<AlbumItem>(`albums/${album.id}/assets`, {
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
          <p>{mode === "cover" ? "选择一项作为封面" : `选择照片加入“${album.name}”`}</p>
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label={mode === "cover" ? "搜索封面照片或视频" : "搜索可添加的照片"}
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
              : mode === "cover"
                ? "相片集暂无照片"
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

      <footer className={`modal-footer ${mode === "cover" ? "album-cover-picker-footer" : ""}`}>
        {mode === "cover" ? (
          <button
            type="button"
            className="btn btn-subtle"
            disabled={busy}
            onClick={() => void submitPicked(true)}
          >
            使用自动封面
          </button>
        ) : (
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
        )}
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
            {mode === "cover"
              ? busy
                ? "正在保存"
                : "设为封面"
              : busy
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
