# API

Production requests use `/aura/api/` and the existing ServerPortal device cookie. There is no second password, API key, or public upload bypass. Browser writes must be same-origin. The loopback upstream also accepts these routes without the `/aura` prefix.

JSON failures contain `error`; errors with a specific recovery condition also include `code`. Successful upload completion means the original is durable; inspect `status` or `/jobs` for derivative processing. `GET /api/info` advertises capabilities so native clients can distinguish original-presence verification and album import from older server behavior.

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

An existing original returns `{complete:true, duplicate:true, present:true, missing:false, assetId, status, trashed, trashedAt}` only when its stored object is present and has the expected size. Recognizing a duplicate does not restore a recently deleted item. Otherwise the response has `{id, offset, chunkSize:8388608, complete:false}`; repair responses also identify the existing item's status, visibility, and `missing:true`. The ID equals the file hash.

3. `PUT /api/uploads/{id}` with the next raw chunk, `Content-Type: application/octet-stream`, and `Upload-Offset: <received-byte-count>`. The response reports the next `offset`. A 409 with `offset` requires seeking to the server's position. Chunks are flushed before acknowledgment; incomplete requests are truncated back to the prior offset. Requests for one hash are serialized independently of other hashes, with a 120-second body-read deadline.
4. `POST /api/uploads/{id}/complete` with `{}`. The server verifies size and complete SHA-256, publishes the immutable object without replacing an existing file, and queues processing. A checksum mismatch returns 422 and removes only the failed temporary byte stream. An original outside the requested capture-date range returns `{complete:true, filtered:true, capturedAt}` without publishing it.
5. `GET /api/uploads/{id}` recovers upload or commit state after disconnection and checks original availability for a completed catalog record. A confirmed missing original is reported as incomplete/missing rather than as a successful duplicate. Repeating prepare or completion is safe. Date-range changes on re-preparation apply to the resumed upload; all source observations remain recorded.

A cataloged original whose object is missing can be uploaded again with the same hash. Publication requires the complete expected bytes and SHA-256, retains the existing logical item, and does not restore recently deleted visibility. An existing non-regular, wrong-size, or conflicting publication object returns 409 with `code: "original_integrity_error"` and is never overwritten by repair. The availability check verifies presence and expected size, not a fresh full-byte checksum of every stored original. Native clients must require `capabilities.originalPresence` before describing receipt reconciliation as an original-presence check.

The maximum original is 32 GiB. Metadata JSON is bounded to 64 KiB. Supported file extensions are declared in `internal/library/upload.go`; a native PhotoKit adjustment resource can use its original extension.

## Library endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Database connectivity; `{status:"ok",service:"Aura"}` |
| `GET /api/info` | Version, capabilities, library counts, original byte count, processing/error counts |
| `GET /api/assets` | `{items,next}` with `view`, `album`, `excludeAlbum`, `excludeAlbums`, `q`, `from`, `to`, `cursor`, and `limit` (default 120, maximum 240) |
| `PATCH /api/assets` | `{ids:[assetId],trash:boolean}`; transactional batch removal or restore, 1–1000 IDs |
| `POST /api/assets/purge` | `{ids:[assetId],confirmation:"永久删除"}`; persist confirmed permanent deletion of selected trash items |
| `GET /api/deletions/{id}` | Durable cleanup request, pending/error state or completion |
| `GET /api/timeline` | `{months:[{month,count}]}` using the same visibility, album, search, exclusion, and date filters |
| `GET /api/assets/{id}` | Logical asset, all file records, and combined metadata |
| `PATCH /api/assets/{id}` | Optional `favorite`, `trash`, or durable manual `primary` fields |
| `POST /api/assets/{id}/merge` | `{other:"asset-id"}`; merge without discarding originals |
| `POST /api/assets/{id}/split` | `{hash:"original-sha256"}`; separate one resource |
| `GET /api/assets/{id}/download` | Streaming ZIP of all originals plus `aura.json` |
| `GET /api/similar` | Legacy array of at most 100 `{left,right,distance}` pairs; `paged=true` returns `{items,next}` |
| `POST /api/similar/ignore` | `{left,right}`; persist a dismissal without merging or deleting originals |
| `DELETE /api/similar/ignore` | `{left,right}`; undo a dismissal |
| `GET /api/jobs` | Legacy array of the latest 100 pending/error files; `paged=true` returns durable processing history |
| `POST /api/files/{hash}/retry` | Queue metadata and derivative regeneration |
| `POST /api/files/retry` | `{hashes:[sha256]}`; retry a bounded batch of failed resources |
| `GET /api/uploads` | Paginated durable incomplete upload sessions with names, sizes, acknowledged offsets, and creation times |

`view` accepts `all`, `favorites`, `live`, `videos`, `grouped`, or `trash`. Text search covers original filenames and retained metadata. Cursor pagination sorts by capture date and asset ID descending. A cursor is opaque to clients; pass back the returned string unchanged.

`album` restricts results to members of that album and returns 404 if it no longer exists. `excludeAlbum` omits existing members for the photo picker. `excludeAlbums=true` omits items belonging to any album. These filters run before cursor pagination and compose with search, date, and visibility filters. The web interface no longer exposes favorites; the legacy API field, filter, and native import hints remain compatible.

The timeline endpoint returns calendar-month keys such as `2026-10`, newest first. A month picker can omit `from` and `to` while retaining the other filters, then set the selected month's inclusive date bounds. The browser retains view, album, query, and dates in its URL; API cursor values remain opaque and must not be synthesized from the display month. Library mutations refresh month counts along with items and ordinary counts.

## Deletion and restore

`PATCH /api/assets/{id}` with `trash:true` moves an item to recently deleted; `trash:false` restores it. All originals, native paired resources, and album memberships remain stored. `PATCH /api/assets` accepts 1–1000 exact IDs and a required boolean `trash`, validates the entire batch, and returns `{updated:[assetId]}`. Invalid or unavailable items reject the batch without partially applying it. Ordinary removal has no automatic expiry.

`POST /api/assets/purge` requires the exact confirmation string `永久删除` and 1–1000 selected trash IDs. It rejects active items instead of deleting them implicitly. After committing the durable cleanup intent, it returns 202 `{requestId,state:"pending",accepted:[assetId]}`. Submission is not proof that file cleanup has finished. Repeating an identical accepted selection can recover the existing request; a completed identical retry may return 200 with `state:"complete"`.

`GET /api/deletions/{requestId}` returns `{id,state:"pending"|"complete",ids:[assetId],bytes,error?}`. `bytes` is the planned original-catalog byte count, not measured filesystem space released. A cleanup failure remains pending with an error and is retried; interruption or restart does not discard the intent. Pending assets expose `deletionPending:true`, and `/info` reports `pendingDeletions` as the number of logical items awaiting permanent cleanup. Restore, split, merge, or conflicting catalog mutations return 409 with `code:"asset_deletion_pending"` while cleanup is pending. Completion removes live originals, derivatives, matching temporary material, catalog resources, and memberships for that request. Albums themselves, system Photos, existing backups, and browser caches are unchanged.

`capabilities.permanentDelete` advertises this protocol. Deleted hashes are reported with 410 `{error,code:"original_deleted",deleted:true,scope:"hash",hash}` rather than as missing originals. Upload preparation, chunks, and completion can instead return `scope:"source"` with the exact `sourceKey` when that source is intentionally excluded. Clients must not apply a source-scoped rejection to another source retaining the same hash. Minimal guards survive completion to prevent automatic reimport; no API bypasses them to restore permanently deleted originals.

Wrong confirmation or an empty/oversized selection returns 400. A selection containing an active item returns 409 `asset_not_trashed`; missing selected IDs return 404. An overlapping but nonidentical pending selection returns 409 `asset_deletion_pending` with its `requestId`. ZIP requests for pending or completed deleted items return 410 `original_deleted`; use upload status to check a specific original hash.

Automatic grouping does not merge existing active and trashed items. Manual merge across their visibility states returns 409 with `code:"trash_state_conflict"`; restore or remove the relevant items explicitly first. Splitting an item preserves trash state and album memberships rather than restoring the separated version.

## Tasks and review

Paginated jobs accept `paged=true`, `status=all|queued|processing|error|ready`, `limit` (default 50, maximum 240), and `cursor`, and return `{items,next,counts}`. Each item contains `hash`, `name`, `mime`, `size`, `assetId`, `status`, and `createdAt`, with optional `error`; full metadata remains in asset details or the legacy unpaged response. Counts contain `all`, `queued`, `processing`, `error`, and `ready`. Pages sort by creation time and hash descending. `ready` means browsing resources are ready; accepted originals can also be downloaded while derivative processing is pending or failed. Batch retry accepts 1–1000 hashes and returns 409 if any selected resource is no longer failed, without partially queuing the batch.

`GET /api/uploads?paged=true` returns `{items,next}` for incomplete sessions, using the same default/maximum page sizes. Each item includes `id`, `name`, `size`, `offset`, `createdAt`, `state`, and `missing`. Pages sort by creation time and ID descending. These server records survive browser restarts. The client must recover or reselect the original source file to continue; listing a session grants no background file access and does not discard its acknowledged chunks.

Similar review supports `paged=true`, `limit`, and an opaque cursor. Ignored pairs are omitted from ordinary results. Ignore and undo append reversible decisions for the explicit pair; they do not alter catalog membership or original files. Manual merges remain separate user actions.

## Albums

| Method and path | Behavior |
| --- | --- |
| `GET /api/albums` | Array of albums ordered by creation time and ID descending |
| `POST /api/albums` | `{name,assets?:[assetId]}`; create and optionally add items atomically; returns 201 |
| `POST /api/albums/import` | `{sourceKey,name,assets:[assetId]}`; idempotent native source mapping and additive membership import |
| `GET /api/albums/{id}` | Album name, visible item count, cover asset, and timestamps |
| `PATCH /api/albums/{id}` | `{name}`; rename |
| `DELETE /api/albums/{id}` | Delete the album and its memberships; returns `{deleted:true}`; preserves library items and originals |
| `POST /api/albums/{id}/assets` | `{assets:[assetId]}`; idempotent, atomic addition |
| `DELETE /api/albums/{id}/assets` | `{assets:[assetId]}`; idempotent removal of memberships only |

Album responses contain `id`, `name`, `count`, `createdAt`, `updatedAt`, and optional `cover` using the asset response shape. Counts and covers exclude recently deleted items; the newest visible item supplies the cover. Names contain 1–100 Unicode characters after trimming. Membership changes accept 1–1000 IDs; creation permits an empty list. Missing or recently deleted assets reject the entire addition with 400. Missing albums return 404. Removal does not require the item to remain visible. Merge transfers memberships to the retained item; split copies memberships to the new item.

Native import source keys use `photokit-album:<client-library-id>:<collection-id>`. Source mappings are retained in the existing decision log. The import adds at most 1000 visible items per request, preserves an Aura-side rename, and never propagates removals from Apple Photos. A mapped album deleted in Aura returns 409 with `code: "imported_album_deleted"` instead of being silently recreated. Clients preserve that user decision and surface it separately from network failures. Native clients must require `capabilities.albumImport` before enabling this operation.

## Backup and recovery

NAS backup and recovery are agent-operated through server-operations tooling. Portal has no backup/recovery API or page, and Aura exposes no API for starting a backup. Verify recovery packages through the agent-operated workflow in [Operations](OPERATIONS.md).

## Media

`GET` and `HEAD /media/{sha256}/{kind}` accept `original`, `thumb`, `preview`, and `play`. All are protected by Portal. Original downloads use the original filename; JPEG previews and MP4 playback support standard HTTP Range requests. Media caching is private. Missing derivatives can be requeued from the jobs interface or by requesting a missing derivative of a ready resource.

Permanent deletion is limited to the confirmed selected-trash protocol above; media reads do not delete originals. Export/import of the catalog for migration is a maintenance operation, described in [Operations](OPERATIONS.md).
