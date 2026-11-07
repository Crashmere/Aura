import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FolderInput,
  FolderOpen,
  Images,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { buildMediaUrl, requestJson } from "../core/client";
import { CollapsibleRegion, useIsPresent } from "../core/motion";
import type { AlbumGroup, AlbumItem, CatalogAsset } from "../core/types";
import { PhotoTile } from "./TimelineCanvas";

export type AlbumModalState =
  | { kind: "create"; assets?: string[]; groupId?: string }
  | { kind: "rename"; album: AlbumItem }
  | { kind: "add"; assets: string[] }
  | { kind: "pick"; album: AlbumItem }
  | { kind: "delete"; album: AlbumItem }
  | { kind: "group-create" }
  | { kind: "group-rename"; group: AlbumGroup }
  | { kind: "group-delete"; group: AlbumGroup }
  | { kind: "move"; albums: AlbumItem[] };

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
  onMove,
  selecting,
  selected,
}: {
  album: AlbumItem;
  onSelect: (album: AlbumItem) => void;
  onMove: (album: AlbumItem) => void;
  selecting: boolean;
  selected: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);

  return (
    <div className="album-card-wrapper">
      <button type="button" className={`album-card ${selected ? "is-selected" : ""}`}
        aria-pressed={selecting ? selected : undefined} onClick={() => onSelect(album)}>
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
      {selecting ? (
        <span className={`album-selection-mark ${selected ? "is-selected" : ""}`} aria-hidden="true">
          {selected && <Check size={16} />}
        </span>
      ) : (
        <button type="button" className="album-move-btn" title="移动到分组"
          aria-label={`将“${album.name}”移动到分组`} onClick={() => onMove(album)}>
          <FolderInput size={16} />
        </button>
      )}
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
  groups,
  onOpenAlbum,
  onAction,
}: {
  albums: AlbumItem[];
  groups: AlbumGroup[];
  onOpenAlbum: (album: AlbumItem) => void;
  onAction: (state: AlbumModalState) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => albums.some((a) => a.id === id))));
  }, [albums]);

  const sections: {
    id: string;
    name: string;
    group?: AlbumGroup;
    albums: AlbumItem[];
  }[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
    group,
    albums: albums.filter((album) => album.groupId === group.id),
  }));
  const ungrouped = albums.filter((album) => !groups.some((group) => group.id === album.groupId));
  if (ungrouped.length) sections.push({ id: "", name: "未分组", albums: ungrouped });

  function selectAlbum(album: AlbumItem) {
    if (!selecting) {
      onOpenAlbum(album);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(album.id)) next.delete(album.id);
      else if (next.size < 1000) next.add(album.id);
      return next;
    });
  }

  return (
    <div className="album-collections">
      {albums.length > 0 && (
        <div className="album-organize-toolbar">
          {selecting ? (
            <>
              <span>已选 {selected.size} 个相片集{selected.size === 1000 ? "，已达单次上限" : ""}</span>
              <button type="button" className="btn" onClick={() => { setSelecting(false); setSelected(new Set()); }}>取消</button>
              <button type="button" className="btn btn-primary" disabled={!selected.size}
                onClick={() => onAction({ kind: "move", albums: albums.filter((a) => selected.has(a.id)) })}>
                <FolderInput size={15} />移动到分组
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setSelecting(true)}>批量分组</button>
          )}
        </div>
      )}
      {sections.map((section) => (
        <section key={section.id} className="album-group-section">
          <header className="album-group-header">
            <button type="button" className="album-group-toggle" aria-expanded={!collapsed.has(section.id)}
              aria-controls={`album-group-${section.id || "unfiled"}`}
              onClick={() => setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(section.id)) next.delete(section.id); else next.add(section.id);
                return next;
              })}>
              <ChevronDown size={16} className={collapsed.has(section.id) ? "is-collapsed" : ""} />
              <FolderOpen size={18} />
              <h2>{section.name}</h2>
              <small>{section.albums.length} 个相片集</small>
            </button>
            {!selecting && (
              <div className="album-group-actions">
                <button type="button" className="icon-btn" title="在此分组新建相片集"
                  aria-label={`在“${section.name}”新建相片集`}
                  onClick={() => onAction({ kind: "create", groupId: section.id })}><Plus size={16} /></button>
                {section.group && (
                  <>
                    <button type="button" className="icon-btn" title="重命名分组" aria-label={`重命名“${section.name}”分组`}
                      onClick={() => { if (section.group) onAction({ kind: "group-rename", group: section.group }); }}><Pencil size={15} /></button>
                    <button type="button" className="icon-btn" title="删除分组" aria-label={`删除“${section.name}”分组`}
                      onClick={() => { if (section.group) onAction({ kind: "group-delete", group: section.group }); }}><Trash2 size={15} /></button>
                  </>
                )}
              </div>
            )}
          </header>
          <CollapsibleRegion open={!collapsed.has(section.id)} id={`album-group-${section.id || "unfiled"}`}>
            {section.albums.length ? (
              <div className="album-grid">
                {section.albums.map((album) => (
                  <AlbumGridCard key={album.id} album={album} onSelect={selectAlbum}
                    onMove={(album) => onAction({ kind: "move", albums: [album] })}
                    selecting={selecting} selected={selected.has(album.id)} />
                ))}
              </div>
            ) : <p className="album-group-empty">此分组还没有相片集</p>}
          </CollapsibleRegion>
        </section>
      ))}
    </div>
  );
}

function AlbumGroupField({
  label,
  groups,
  value,
  disabled,
  onChange,
}: {
  label: string;
  groups: AlbumGroup[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label className="album-name-field">
      <span>{label}</span>
      <select aria-label={label} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">未分组</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>{group.name}</option>
        ))}
      </select>
    </label>
  );
}

export function AlbumActionModal({
  state,
  groups,
  onClose,
  onSaved,
}: {
  state: AlbumModalState;
  groups: AlbumGroup[];
  onClose: () => void;
  onSaved: (album?: AlbumItem) => void;
}) {
  const isPresent = useIsPresent();
  const [nameInput, setNameInput] = useState(
    state.kind === "rename" ? state.album.name
      : state.kind === "group-rename" ? state.group.name : "",
  );
  const [groupId, setGroupId] = useState(
    state.kind === "create" ? state.groupId || ""
      : state.kind === "move" && state.albums.every((a) => a.groupId === state.albums[0]?.groupId)
        ? state.albums[0]?.groupId || "" : "",
  );
  const [albumsList, setAlbumsList] = useState<AlbumItem[]>([]);
  const [loadingList, setLoadingList] = useState(state.kind === "add");
  const [isCreatingNew, setIsCreatingNew] = useState(
    state.kind === "create" || state.kind === "rename" || state.kind === "group-create" || state.kind === "group-rename",
  );
  const [busy, setBusy] = useState(false);
  const [pendingAlbumId, setPendingAlbumId] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isPhotoPicker = state.kind === "pick";
  const isGroupName = state.kind === "group-create" || state.kind === "group-rename" || state.kind === "move";
  const isDeleting = state.kind === "delete" || state.kind === "group-delete";

  const modalTitle =
    state.kind === "group-delete" ? "删除分组"
    : state.kind === "group-rename" ? "重命名分组"
    : state.kind === "group-create" || (state.kind === "move" && isCreatingNew) ? "新建分组"
    : state.kind === "move" ? "移动到分组"
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
      if (state.kind === "group-delete") {
        await requestJson(`album-groups/${state.group.id}`, undefined, "DELETE");
        onSaved();
      } else if (state.kind === "group-rename") {
        await requestJson(`album-groups/${state.group.id}`, { name: nameInput.trim() }, "PATCH");
        onSaved();
      } else if (state.kind === "group-create" || state.kind === "move" && isCreatingNew) {
        await requestJson("album-groups", {
          name: nameInput.trim(),
          albums: state.kind === "move" ? state.albums.map((a) => a.id) : [],
        });
        onSaved();
      } else if (state.kind === "move") {
        await requestJson("albums/group", { albums: state.albums.map((a) => a.id), groupId: groupId || null }, "PATCH");
        onSaved();
      } else if (state.kind === "delete") {
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
          groupId,
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
            <div className="modal-body" key={isCreatingNew ? "name" : "albums"}>
              {state.kind === "group-delete" ? (
                <p className="album-modal-note">删除“{state.group.name}”分组？相片集会移至“未分组”，相片集和照片均保留。</p>
              ) : state.kind === "delete" ? (
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
                    <span>{isGroupName ? "分组名称" : "相片集名称"}</span>
                    <input
                      ref={inputRef}
                      aria-label={isGroupName ? "分组名称" : "相片集名称"}
                      placeholder="输入名称"
                      value={nameInput}
                      maxLength={100}
                      disabled={busy}
                      onChange={(e) => setNameInput(e.target.value)}
                    />
                  </label>
                  {!isGroupName && state.kind !== "rename" && groups.length > 0 && (
                    <AlbumGroupField label="所属分组" groups={groups} value={groupId}
                      disabled={busy} onChange={setGroupId} />
                  )}
                  {state.kind === "move" && <p className="album-modal-note">同时移入已选的 {state.albums.length} 个相片集。</p>}
                  {state.kind === "add" && (
                    <p className="album-modal-note">
                      同时添加已选的 {state.assets.length} 项。
                    </p>
                  )}
                </form>
              ) : state.kind === "move" ? (
                <>
                  <p className="album-modal-note">{state.albums.length === 1 ? `移动“${state.albums[0].name}”` : `移动已选的 ${state.albums.length} 个相片集`}</p>
                  <AlbumGroupField label="目标分组" groups={groups} value={groupId}
                    disabled={busy} onChange={setGroupId} />
                </>
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
                            <small>{alb.count} 项 · {groups.find((group) => group.id === alb.groupId)?.name || "未分组"}</small>
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
              {isDeleting ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => void commitAction()}
                >
                  {state.kind === "group-delete" ? "删除分组" : "删除相片集"}
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
                    : state.kind === "rename" || state.kind === "group-rename"
                      ? "保存"
                      : "创建"}
                </button>
              ) : state.kind === "move" ? (
                <>
                  <button type="button" className="btn" disabled={busy} onClick={() => { setIsCreatingNew(true); setErrorMsg(""); }}>新建分组</button>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void commitAction()}>{busy ? "正在移动" : "移动"}</button>
                </>
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
  }, [debouncedQuery, album.id]);

  function togglePick(id: string) {
    setChosenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 1000) next.add(id);
      return next;
    });
  }

  async function submitPicked() {
    if (busy) return;
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
