import { useEffect, useRef, useState } from "react";
import { Check, Images, LoaderCircle, Plus, RefreshCw, Search, X } from "lucide-react";
import { Album, Asset, api, media } from "./api";
import { Photo } from "./photo";

export type AlbumDialogState =
  | { kind: "create"; assets?: string[] }
  | { kind: "rename"; album: Album }
  | { kind: "add"; assets: string[] }
  | { kind: "pick"; album: Album }
  | { kind: "delete"; album: Album };

function AlbumCover({ album, attempt = 0, failed }: { album: Album; attempt?: number; failed?: (value: boolean) => void }) {
  const [broken, setBroken] = useState(false);
  useEffect(
    () => { setBroken(false); failed?.(false); },
    [album, attempt],
  );
  useEffect(() => {
    if (!broken) return;
    const retry = () => { setBroken(false); failed?.(false); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [broken, failed]);
  return (
    <span className="album-cover">
      {album.cover && !broken ? (
        <img
          src={media(album.cover.primary) + (attempt ? `?retry=${attempt}` : "")}
          alt=""
          loading="lazy"
          onError={() => { setBroken(true); failed?.(true); }}
        />
      ) : (
        <Images size={32} strokeWidth={1.2} />
      )}
    </span>
  );
}

function AlbumCard({ album, open }: { album: Album; open: (album: Album) => void }) {
  const [broken, setBroken] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <div className="album-card-wrapper">
      <button className="album-card" onClick={() => open(album)}>
        <AlbumCover album={album} attempt={attempt} failed={setBroken} />
        <strong>{album.name}</strong>
        <small>{album.count.toLocaleString()} 项</small>
      </button>
      {broken && <button className="album-cover-retry" title="重新加载封面" aria-label="重新加载封面" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={15} /></button>}
    </div>
  );
}

export function AlbumGrid({
  albums,
  open,
}: {
  albums: Album[];
  open: (a: Album) => void;
}) {
  return (
    <div className="album-grid">
      {albums.map((album) => (
        <AlbumCard key={album.id} album={album} open={open} />
      ))}
    </div>
  );
}

export function AlbumDialog({
  state,
  close,
  saved,
}: {
  state: AlbumDialogState;
  close: () => void;
  saved: (album?: Album) => void;
}) {
  const [name, setName] = useState(
    state.kind === "rename" ? state.album.name : "",
  );
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(state.kind === "add");
  const [creating, setCreating] = useState(
    state.kind === "create" || state.kind === "rename",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title =
    state.kind === "rename"
      ? "重命名相片集"
      : state.kind === "delete"
        ? "删除相片集"
        : creating
          ? "新建相片集"
          : "添加到相片集";
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !busy) close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, close]);
  useEffect(() => {
    if (creating) input.current?.focus();
  }, [creating]);
  useEffect(() => {
    if (state.kind !== "add") return;
    let active = true;
    api<Album[]>("albums")
      .then((data) => {
        if (active) setAlbums(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state]);

  async function save(album?: Album) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (state.kind === "delete") {
        await api(`albums/${state.album.id}`, undefined, "DELETE");
        saved();
      } else if (state.kind === "rename") {
        saved(
          await api<Album>(
            `albums/${state.album.id}`,
            { name: name.trim() },
            "PATCH",
          ),
        );
      } else if (album && state.kind === "add") {
        saved(
          await api<Album>(`albums/${album.id}/assets`, {
            assets: state.assets,
          }),
        );
      } else {
        const assets =
          state.kind === "create" || state.kind === "add"
            ? state.assets || []
            : [];
        saved(await api<Album>("albums", { name: name.trim(), assets }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const dismiss = () => {
    if (!busy) close();
  };
  return (
    <div className="modal-backdrop album-backdrop" onClick={dismiss}>
      <section
        className={`dialog album-dialog ${state.kind === "pick" ? "photo-picker-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dialog-title">
          <div>
            <h2>{state.kind === "pick" ? "添加照片" : title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭相片集弹窗"
            disabled={busy}
            onClick={dismiss}
          >
            <X size={20} />
          </button>
        </header>
        {state.kind === "pick" ? (
          <PhotoPicker
            album={state.album}
            busy={busy}
            setBusy={setBusy}
            close={close}
            saved={saved}
          />
        ) : (
          <>
            <div className="dialog-content">
              {state.kind === "delete" ? (
                <p className="album-delete-note">
                  删除“{state.album.name}”？照片仍保留在照片库中。
                </p>
              ) : creating ? (
                <form
                  id="album-name-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  <label className="album-name-label">
                    相片集名称
                    <input
                      ref={input}
                      aria-label="相片集名称"
                      placeholder="输入名称"
                      value={name}
                      maxLength={100}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  {state.kind === "add" && (
                    <p className="album-dialog-note">
                      同时添加已选的 {state.assets.length} 项。
                    </p>
                  )}
                </form>
              ) : (
                <>
                  <p className="album-dialog-note">
                    将 {state.kind === "add" ? state.assets.length : 0}{" "}
                    项添加到相片集
                  </p>
                  {loading ? (
                    <div className="loading-inline">
                      <LoaderCircle className="spin" size={20} />
                      正在加载
                    </div>
                  ) : (
                    <div className="album-options">
                      {albums.map((album) => (
                        <button
                          key={album.id}
                          disabled={busy}
                          onClick={() => void save(album)}
                        >
                          <AlbumCover album={album} />
                          <span>
                            <strong>{album.name}</strong>
                            <small>{album.count} 项</small>
                          </span>
                          <Plus size={18} />
                        </button>
                      ))}
                      {!albums.length && !error && (
                        <p className="album-dialog-note">
                          还没有相片集，新建一个开始整理。
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                </div>
              )}
            </div>
            <footer className="dialog-footer">
              <button className="button" disabled={busy} onClick={dismiss}>
                取消
              </button>
              {state.kind === "delete" ? (
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  删除相片集
                </button>
              ) : creating ? (
                <button
                  className="button primary"
                  form="album-name-form"
                  type="submit"
                  disabled={busy || !name.trim()}
                >
                  {busy
                    ? "正在保存"
                    : state.kind === "rename"
                      ? "保存"
                      : "创建"}
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={busy || loading}
                  onClick={() => {
                    setCreating(true);
                    setError("");
                  }}
                >
                  <Plus size={16} />
                  新建相片集
                </button>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function PhotoPicker({
  album,
  busy,
  setBusy,
  close,
  saved,
}: {
  album: Album;
  busy: boolean;
  setBusy: (v: boolean) => void;
  close: () => void;
  saved: (a: Album) => void;
}) {
  const [items, setItems] = useState<Asset[]>([]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [next, setNext] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  async function load(cursor = "") {
    const key = ++request.current;
    setLoading(true);
    setError("");
    try {
      const data = await api<{ items: Asset[]; next: string }>(
        "assets?" +
          new URLSearchParams({ q: query, cursor, excludeAlbum: album.id }),
      );
      if (key !== request.current) return;
      setItems((old) =>
        cursor
          ? [
              ...old,
              ...data.items.filter((a) => !old.some((b) => a.id === b.id)),
            ]
          : data.items,
      );
      setNext(data.next);
    } catch (e) {
      if (key === request.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (key === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setNext("");
    void load();
    return () => {
      ++request.current;
    };
  }, [query]);
  function toggle(id: string) {
    setSelected((old) => {
      const result = new Set(old);
      if (result.has(id)) result.delete(id);
      else if (result.size < 1000) result.add(id);
      return result;
    });
  }
  async function add() {
    setBusy(true);
    setError("");
    try {
      saved(
        await api<Album>(`albums/${album.id}/assets`, {
          assets: [...selected],
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <>
      <div className="dialog-content photo-picker">
        <div className="picker-heading">
          <p>选择照片加入“{album.name}”</p>
          <div className="search">
            <Search size={17} />
            <input
              aria-label="搜索可添加的照片"
              placeholder="搜索文件名、相机…"
              value={search}
              disabled={busy}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              className="button"
              disabled={busy}
              onClick={() => void load()}
            >
              重试
            </button>
          </div>
        )}
        {!items.length && !loading && !error && (
          <p className="album-dialog-note">
            {query
              ? "没有符合条件的照片"
              : "没有可添加的照片，已有项目不会重复显示。"}
          </p>
        )}
        <div className={`photo-grid picker-grid ${busy ? "is-busy" : ""}`}>
          {items.map((asset) => (
            <Photo
              key={asset.id}
              asset={asset}
              selected={selected.has(asset.id)}
              onClick={() => {
                if (!busy) toggle(asset.id);
              }}
              select={() => {
                if (!busy) toggle(asset.id);
              }}
            />
          ))}
        </div>
        {loading ? (
          <div className="loading-inline">
            <LoaderCircle className="spin" size={20} />
            正在加载
          </div>
        ) : (
          next && (
            <button
              className="button picker-more"
              disabled={busy}
              onClick={() => void load(next)}
            >
              加载更多
            </button>
          )
        )}
      </div>
      <footer className="dialog-footer">
        <span>
          <Check size={15} />
          已选 {selected.size} 项
          {selected.size === 1000 ? "，已达单次上限" : ""}
        </span>
        <div className="album-footer-actions">
          <button className="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || !selected.size}
            onClick={() => void add()}
          >
            {busy ? "正在添加" : "添加"}
          </button>
        </div>
      </footer>
    </>
  );
}
