# API

Production requests use `/aura/api/` and the existing ServerPortal device cookie. There is no second password, API key, or public upload bypass. Browser writes must be same-origin. The loopback upstream also accepts these routes without the `/aura` prefix.

JSON failures contain `error`. Successful upload completion means the original is durable; inspect `status` or `/jobs` for derivative processing.

## Upload protocol

1. Calculate SHA-256 over the unmodified file.
2. `POST /api/uploads` with the following JSON:

```json
{
  "hash": "64 lowercase hexadecimal characters",
  "name": "IMG_1234.HEIC",
  "size": 1234567,
  "capturedAt": "2026-10-27T10:30:00+08:00",
  "modifiedAt": "2026-10-27T10:30:00+08:00",
  "sourceKey": "photokit:client-library-id:asset-id",
  "resourceType": "originalPhoto",
  "from": "2026-01-01",
  "to": "2026-12-31"
}
```

Only `hash`, `name`, and `size` are required. `sourceKey` explicitly groups resources from one logical source asset; independent images must not share it. PhotoKit clients also provide `favorite`, `latitude`, and `longitude` when available. `from`/`to` are optional inclusive dates.

An existing original returns `{complete:true, duplicate:true, assetId, status}`. Otherwise the response has `{id, offset, chunkSize:8388608, complete:false}`. The ID equals the file hash.

3. `PUT /api/uploads/{id}` with the next raw chunk, `Content-Type: application/octet-stream`, and `Upload-Offset: <received-byte-count>`. The response reports the next `offset`. A 409 with `offset` requires seeking to the server's position. Chunks are flushed before acknowledgment; incomplete requests are truncated back to the prior offset.
4. `POST /api/uploads/{id}/complete` with `{}`. The server verifies size and complete SHA-256, publishes the immutable object, and queues processing. A checksum mismatch returns 422 and removes only the failed temporary byte stream. An original outside the requested capture-date range returns `{complete:true, filtered:true, capturedAt}` without publishing it.
5. `GET /api/uploads/{id}` recovers upload or commit state after disconnection. Repeating prepare or completion is safe. Date-range changes on re-preparation apply to the resumed upload; all source observations remain recorded.

The maximum original is 32 GiB. Metadata JSON is bounded to 64 KiB. Supported file extensions are declared in `internal/library/upload.go`; a native PhotoKit adjustment resource can use its original extension.

## Library endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Database connectivity; `{status:"ok",service:"Aura"}` |
| `GET /api/info` | Library counts, original byte count, processing/error counts |
| `GET /api/assets` | `{items,next}` with `view`, `album`, `excludeAlbum`, `excludeAlbums`, `q`, `from`, `to`, `cursor`, and `limit` (default 120, maximum 240) |
| `GET /api/assets/{id}` | Logical asset, all file records, and combined metadata |
| `PATCH /api/assets/{id}` | Optional `favorite`, `trash`, or `primary` fields |
| `POST /api/assets/{id}/merge` | `{other:"asset-id"}`; merge without discarding originals |
| `POST /api/assets/{id}/split` | `{hash:"original-sha256"}`; separate one resource |
| `GET /api/assets/{id}/download` | Streaming ZIP of all originals plus `aura.json` |
| `GET /api/similar` | At most 100 `{left,right,distance}` perceptual review pairs |
| `GET /api/jobs` | Most recent 100 pending/processing/error file records |
| `POST /api/files/{hash}/retry` | Queue metadata and derivative regeneration |

`view` accepts `all`, `favorites`, `live`, `videos`, `grouped`, or `trash`. Text search covers original filenames and retained metadata. Cursor pagination sorts by capture date and asset ID descending. A cursor is opaque to clients; pass back the returned string unchanged.

`album` restricts results to members of that album and returns 404 if it no longer exists. `excludeAlbum` omits existing members for the photo picker. `excludeAlbums=true` omits items belonging to any album. These filters run before cursor pagination and compose with search, date, and visibility filters. The web interface no longer exposes favorites; the legacy API field, filter, and native import hints remain compatible.

## Albums

| Method and path | Behavior |
| --- | --- |
| `GET /api/albums` | Array of albums ordered by creation time and ID descending |
| `POST /api/albums` | `{name,assets?:[assetId]}`; create and optionally add items atomically; returns 201 |
| `GET /api/albums/{id}` | Album name, visible item count, cover asset, and timestamps |
| `PATCH /api/albums/{id}` | `{name}`; rename |
| `DELETE /api/albums/{id}` | Delete the album and its memberships; returns `{deleted:true}`; preserves library items and originals |
| `POST /api/albums/{id}/assets` | `{assets:[assetId]}`; idempotent, atomic addition |
| `DELETE /api/albums/{id}/assets` | `{assets:[assetId]}`; idempotent removal of memberships only |

Album responses contain `id`, `name`, `count`, `createdAt`, `updatedAt`, and optional `cover` using the asset response shape. Counts and covers exclude recently deleted items; the newest visible item supplies the cover. Names contain 1–100 Unicode characters after trimming. Membership changes accept 1–1000 IDs; creation permits an empty list. Missing or recently deleted assets reject the entire addition with 400. Missing albums return 404. Removal does not require the item to remain visible. Merge transfers memberships to the retained item; split copies memberships to the new item.

## Media

`GET` and `HEAD /media/{sha256}/{kind}` accept `original`, `thumb`, `preview`, and `play`. All are protected by Portal. Original downloads use the original filename; JPEG previews and MP4 playback support standard HTTP Range requests. Media caching is private. Missing derivatives can be requeued from the jobs interface or by requesting a missing derivative of a ready resource.

No API permanently deletes an original. Export/import of the catalog for migration is a maintenance operation, described in [Operations](OPERATIONS.md).
