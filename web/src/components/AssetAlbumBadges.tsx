import { createContext, useContext } from "react";
import { Images } from "lucide-react";
import type { CatalogAsset } from "../core/types";

export const CurrentAlbumContext = createContext("");

export function AssetAlbumBadges({ asset }: { asset: CatalogAsset }) {
  const currentAlbum = useContext(CurrentAlbumContext);
  const albums = asset.albums?.filter((album) => album.id !== currentAlbum) || [];
  if (!albums.length) return null;
  return (
    <span className="asset-albums" aria-label="所属相片集" title={albums.map((album) => album.name).join("、")}>
      {albums.map((album) => (
        <span key={album.id} className="asset-album-badge" data-album-id={album.id}>
          <Images size={11} aria-hidden="true" />
          <span>{album.name}</span>
        </span>
      ))}
    </span>
  );
}
