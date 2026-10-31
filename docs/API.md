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
| `GET /api/assets` | `{items,next}` with the shared library filters below, `cursor`, and `limit` (default 120, maximum 240) |
| `GET /api/filter-options` | `{cameras:string[],lenses:string[]}`; global equipment choices from all retained catalog assets, including trash and secondary originals |
| `PATCH /api/assets` | `{ids:[assetId],trash:boolean}`; transactional batch removal or restore, 1–1000 IDs |
| `POST /api/assets/purge` | `{ids:[assetId],confirmation:"永久删除"}`; persist confirmed permanent deletion of selected trash items |
| `GET /api/deletions/{id}` | Durable cleanup request, pending/error state or completion |
| `GET /api/timeline` | `{months:[{month,count}]}` using the same library filters before pagination |
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

### Shared library filters

`GET /api/assets` and `GET /api/timeline` accept the same optional scalar parameters. Empty values omit a filter; whitespace-only `q`, `camera`, and `lens` also omit it. All supplied filters combine with AND before cursor pagination. Both endpoints return 400 for repeated filter parameters, unknown enum values, malformed dates or numbers, negative or non-finite numeric bounds, and a lower bound greater than its upper bound. Enum values are case-sensitive. Contradictory valid filters return an empty result.

| Parameter | Values | Meaning |
| --- | --- | --- |
| `view` | `all`, `albums`, `favorites`, `live`, `videos`, `grouped`, `trash` | Default `all` excludes recently deleted items. `albums` uses the same visibility and combines with `album` to select a specific album. `trash` includes only deleted items; other views also exclude them. `grouped` requires more than one image original. |
| `q` | Text | Literal substring of any original filename or retained metadata JSON. |
| `from`, `to` | `YYYY-MM-DD` | Inclusive capture-date bounds, compared to the stored date portion of `asset.captured_at`. |
| `album` | Album ID | Require membership; a nonexistent album returns 404. |
| `excludeAlbum` | Album ID | Exclude members of that album. |
| `excludeAlbums` | `true` | Exclude items belonging to any album; omitted, empty, or `false` leaves this filter off. |
| `kind` | `photo`, `live`, `video` | Logical item kind; `photo` excludes Live Photos and videos. |
| `format` | `jpeg`, `heic`, `png`, `gif`, `webp`, `tiff`, `raw`, `avif`, `mov`, `mp4` | Match any original resource, including secondary images and paired motion, using detected MIME and the filename fallbacks below. |
| `orientation` | `landscape`, `portrait`, `square`, `panorama` | Primary dimensions only: width greater than height, less than height, equal to height, or width at least twice height. Panorama also qualifies as landscape. Unknown or nonpositive dimensions match none. |
| `status` | `ready`, `queued`, `processing`, `error` | Primary file processing status. A secondary resource's status does not change this match. |
| `location` | `with`, `without` | Presence or absence of location on any one original: both native latitude/longitude hints, both GPS latitude/longitude metadata tags, or a nonempty combined GPS position/coordinates tag. Zero coordinates are present. |
| `versions` | `single`, `multiple` | Exactly one or more than one original with MIME `image/*`. Paired motion and adjustment resources do not count. A one-image Live Photo is `single`; pure videos and items with no identified image match neither. |
| `albumState` | `in`, `none` | Belongs to at least one album, or to none. `none` has the same effect as `excludeAlbums=true`. |
| `camera` | Text | Match a `Make` or `Model` metadata value on any original. |
| `lens` | Text | Match `LensMake`, `LensModel`, `LensID`, `Lens`, `LensType`, `LensInfo`, `LensSpec`, or `LensSpecification` on any original. |
| `cameraMatch`, `lensMatch` | `contains`, `exact` | Mode for the corresponding equipment filter; omitted or empty defaults to the existing literal substring behavior. `exact` compares the whole trimmed scalar tag using SQLite `NOCASE`. |
| `minSize`, `maxSize` | Nonnegative integer bytes, at most 9223372036854775807 | Inclusive primary-file size bounds; secondary resource sizes are not summed. |
| `minMP`, `maxMP` | Nonnegative finite floating-point megapixels | Inclusive primary resolution bounds, calculated as width × height / 1,000,000 without display rounding. Unknown or nonpositive dimensions are excluded even when a bound is zero. |
| `addedFrom`, `addedTo` | `YYYY-MM-DD` | Inclusive import calendar dates in the service's local timezone (`Asia/Shanghai` on `nas`), applied to the UTC `asset.created_at` timestamp. Bounds run from local midnight on `addedFrom` through, but excluding, local midnight after `addedTo`; fractional seconds retain their exact boundary membership. This is the retained logical item's creation date, independent of capture date and the date a version or album membership was added. |

Format matching uses JPEG, HEIC/HEIF (including sequence MIME types), PNG, GIF, WebP, TIFF, vendor RAW, AVIF, QuickTime, and MP4 MIME types. `heic` also matches `.heic`/`.heif`; `raw` also matches `.dng`, `.cr2`, `.cr3`, `.nef`, `.arw`, `.raf`, `.rw2`, `.orf`, `.pef`, and `.srw`, since these resources can have generic container MIME types. Other formats use their corresponding extensions only when MIME is empty or `application/octet-stream`; JPEG includes `.jpg`/`.jpeg`, TIFF includes `.tif`/`.tiff`, and MP4 includes `.mp4`/`.m4v`. MIME and extension comparisons ignore ASCII case. An item can match multiple format choices because it retains several originals, or because a RAW container also identifies as TIFF. File records represent originals; generated previews and playback files do not supply matches.

Camera, lens, and GPS metadata recognize exact tag names and colon-prefixed group suffixes such as `IFD0:Make`, `ExifIFD:LensModel`, and `Composite:GPSLatitude`. Location requires a pair on the same original, or a complete `GPSPosition`/`GPSCoordinates` field; latitude/longitude references, altitude alone, nulls, and empty text do not establish location. Camera/lens query values and `q` are trimmed. Equipment matches accept text and numeric scalar tags only; both modes treat `%`, `_`, and backslash literally and ignore ASCII case, without non-ASCII case folding. `q` retains literal substring matching. Exact selection such as `camera=iPhone%2016%20Pro&cameraMatch=exact` excludes `iPhone 16 Pro Max`. Camera/lens matching does not search filenames or unrelated metadata tags. Different filters may match different resources of the same logical item.

`GET /api/filter-options` uses the same Portal authentication and fixed EXIF keysets. It ignores all view, filter, cursor, and limit parameters, includes every retained original linked to a catalog asset (including trash), and never reads historical permanently deleted metadata. Per original, cameras prefer `Model` over `Make`; lenses prefer `LensModel`, `LensID`, `Lens`, `LensType`, then the equal-priority `LensInfo`/`LensSpec`/`LensSpecification` tier, with `LensMake` last. Only nonempty trimmed text/numeric values qualify; ties between group-prefixed tags are retained. Each array is deduplicated and sorted ascending with SQLite `NOCASE`, choosing the binary-smallest spelling for case variants. There is no list cap; an empty library returns two empty arrays. Dropdowns send the chosen `camera` or `lens` with its corresponding `Match=exact`.

Cursor pagination sorts by capture date and asset ID descending. Pass the returned cursor unchanged with the same filters; reset it when filters change. The timeline returns calendar-month keys such as `2026-10`, newest first, counting matching logical items across all pages and ignoring `cursor` and `limit`. A month picker can omit `from` and `to` while retaining every other filter, including import dates, then set the selected month's inclusive capture-date bounds. Library mutations refresh month counts along with items and ordinary counts. The web interface no longer exposes favorites; the legacy API field, filter, and native import hints remain compatible.

For example, `/api/assets?kind=live&format=heic&location=with&versions=single&minMP=12&addedFrom=2026-10-01&limit=24` lists matching Live Photos; `/api/timeline` with the same filter parameters counts them by capture month. These read-only filters use the existing catalog and resource/membership indexes, without a schema migration or materialized metadata writes.

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
