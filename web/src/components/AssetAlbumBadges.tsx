import { createContext, useContext } from "react";
import { Images } from "lucide-react";
import type { CatalogAsset } from "../core/types";

export const CurrentAlbumContext = createContext("");

export function AssetAlbumBadges({ asset, onOpenAlbum, disabled = false }: {
  asset: CatalogAsset;
  onOpenAlbum?: (albumId: string) => void;
  disabled?: boolean;
}) {
  const currentAlbum = useContext(CurrentAlbumContext);
  const albums = asset.albums?.filter((album) => album.id !== currentAlbum) || [];
  if (!albums.length) return null;
  return (
    <span className="asset-albums" aria-label="所属相片集" title={albums.map((album) => album.name).join("、")}>
      {albums.map((album) => (
        onOpenAlbum ? (
          <button key={album.id} type="button" className="asset-album-badge asset-album-link"
            data-album-id={album.id} disabled={disabled}
            aria-label={`在${album.name}中定位这张照片`} title={`在${album.name}中定位这张照片`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenAlbum(album.id);
            }}>
            <Images size={11} aria-hidden="true" />
            <span>{album.name}</span>
          </button>
        ) : (
          <span key={album.id} className="asset-album-badge" data-album-id={album.id}>
            <Images size={11} aria-hidden="true" />
            <span>{album.name}</span>
          </span>
        )
      ))}
    </span>
  );
}
