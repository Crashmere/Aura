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

An existing original returns `{complete:true, duplicate:true, present:true, missing:false, assetId, status, trashed, trashedAt}` only when its stored object is present and has the expected size. Recognizing a duplicate does not restore a recently deleted item. Otherwise the response has `{id, offset, chunkSize:134217728, complete:false}`; repair responses also identify the existing item's status, visibility, and `missing:true`. The ID equals the file hash. Clients can send smaller chunks, including the previous 8 MiB size; originals up to 128 MiB fit in one request. Aura's Nginx location allows 129 MiB request bodies on NAS and both public gateways.

3. `PUT /api/uploads/{id}` with the next raw chunk, `Content-Type: application/octet-stream`, and `Upload-Offset: <received-byte-count>`. The response reports the next `offset`. A 409 with `offset` requires seeking to the server's position. Chunks are flushed before acknowledgment; incomplete requests are truncated back to the prior offset. Requests for one hash are serialized independently of other hashes, with a 600-second body-read deadline. Clients allow 660 seconds for each chunk request.
4. `POST /api/uploads/{id}/complete` with `{}`. The server verifies size and complete SHA-256, publishes the immutable object without replacing an existing file, and queues processing. `assetId` can remain empty until background catalog publication; clients needing the logical item poll upload status rather than retransmitting the accepted original. A checksum mismatch returns 422 and removes only the failed temporary byte stream. An original outside the requested capture-date range returns `{complete:true, filtered:true, capturedAt}` without publishing it.
5. `GET /api/uploads/{id}` recovers upload or commit state after disconnection and checks original availability for a completed catalog record. A confirmed missing original is reported as incomplete/missing rather than as a successful duplicate. Repeating prepare or completion is safe. Date-range changes on re-preparation apply to the resumed upload; all source observations remain recorded.

A cataloged original whose object is missing can be uploaded again with the same hash. Publication requires the complete expected bytes and SHA-256, retains the existing logical item, and does not restore recently deleted visibility. An existing non-regular, wrong-size, or conflicting publication object returns 409 with `code: "original_integrity_error"` and is never overwritten by repair. The availability check verifies presence and expected size, not a fresh full-byte checksum of every stored original. Native clients must require `capabilities.originalPresence` before describing receipt reconciliation as an original-presence check.

The maximum original is 32 GiB. Metadata JSON is bounded to 64 KiB. Supported file extensions are declared in `internal/library/upload.go`; a native PhotoKit adjustment resource can use its original extension.

## Library endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Database connectivity; `{status:"ok",service:"Aura"}` |
| `GET /api/info` | Version, capabilities, library counts, original byte count, processing/error counts, effective `processingConcurrency:{workers,gpuOperations,cpuOperations}` |
| `GET /api/assets` | `{items,next}` with the shared library filters below, `cursor`, and `limit` (default 120, maximum 240) |
| `GET /api/filter-options` | `{cameras:string[],lenses:string[]}`; global equipment choices from all retained catalog assets, including trash and secondary originals |
| `PATCH /api/assets` | `{ids:[assetId],trash:boolean}`; transactional batch removal or restore, 1–1000 IDs |
| `POST /api/assets/purge` | `{ids:[assetId],confirmation:"永久删除"}`; persist confirmed permanent deletion of selected trash items |
| `GET /api/deletions/{id}` | Durable cleanup request, pending/error state or completion |
| `GET /api/timeline` | `{months:[{month,count}]}` using the same library filters before pagination |
| `GET /api/assets/{id}` | Logical asset, all file records, and combined metadata |
| `PATCH /api/assets/{id}` | Optional `favorite`, `trash`, or durable manual `primary` fields |
| `PATCH /api/assets/{id}/rotation` | `{hash,rotation,expectedRotation}`; save the selected photo/video direction and exact paired motion, returning the updated detail response |
| `POST /api/assets/{id}/merge` | `{other:"asset-id",primary?:"original-sha256"}`; merge and optionally select the primary in one transaction, retaining all originals and album memberships |
| `POST /api/assets/{id}/split` | `{hash:"original-sha256"}`; separate one resource |
| `GET /api/assets/{id}/download` | Streaming ZIP of all originals plus `aura.json` |
| `GET /api/similar` | `source=dhash` (default) or `source=dino`; legacy array up to 100 pairs, or `paged=true` returns `{items,next}` with DINO `index` progress |
| `POST /api/similar/ignore` | `{left,right}`; persist a dismissal without merging or deleting originals |
| `DELETE /api/similar/ignore` | `{left,right}`; undo a dismissal |
| `GET /api/review-history` | `kind=similar|split`, `limit` (default 20, maximum 100), and opaque `cursor`; retained dismissal or split records with current cards and restoration availability |
| `POST /api/splits/{id}/restore` | Restore the exact original identified by a split decision to its retained item; response `{id:assetId}` |
| `GET /api/jobs` | Legacy array of the latest 100 pending/error files; `paged=true` returns durable processing history |
| `POST /api/files/{hash}/retry` | Queue metadata and derivative regeneration |
| `POST /api/files/retry` | `{hashes:[sha256]}`; retry a bounded batch of failed resources |
| `GET /api/uploads` | Paginated durable incomplete upload sessions with names, sizes, acknowledged offsets, and creation times |
| `GET /api/assets/{id}/frame` | Preview a frame from the selected video or exact paired Live Photo motion |
| `PATCH /api/assets/{id}/cover` | Save or reset a selected video's cover or Live Photo's key photo |

Video assets include optional `duration` in seconds and `frameRate` in frames per second from the primary original's stored `Duration` and `VideoFrameRate` metadata, including group-prefixed tags. Each field is omitted until its positive finite value is available. Live Photo assets instead expose optional `motionDuration` and `motionFrameRate` from their motion resource. Listing and detail responses use the same asset representation. The viewer displays the catalog duration before playback, then uses the loaded video's duration. Frame stepping pauses playback and uses the catalog frame rate, the observed frame interval when unavailable, or 30 fps before either is known; variable-rate sources use this interval estimate.

Assets include `variants` for all retained resources and `imageVersions` for resources with MIME `image/*`. When `imageVersions` is greater than one, `grouping` is `manual` if image resources moved by a recorded user merge still share the item with an image from the other side; otherwise it is `automatic`. Grouping is derived from current resource membership, so it follows later automatic regrouping and stops applying after the two sides are separated. Single-image Live Photos omit `grouping`. `GET /api/info` retains the total multi-image count `grouped` and adds disjoint `automatic` and `merged` counts for these two classes.

The shared asset representation includes `albums:[{id,name}]`, ordered by album name using SQLite `NOCASE` and then ID. Items without memberships return an empty array. Lists, details, similar/review-history cards and album covers use this same representation. An album-filtered response still includes every membership; clients hide only the currently open album's label.

Manual `primary` selection accepts an image or video original belonging to the item. During a merge it may belong to either input, and validation occurs after moving resources within the same transaction. An invalid selection returns 400 and rolls back both the merge and primary decision. Omitting `primary` preserves the existing automatic/preference selection. The choice follows its original hash through later grouping and reprocessing. A selected still uses only its unique Apple content-identifier motion match, or its exact PhotoKit original/full-size paired-video role when content identifiers are absent; unrelated or ambiguous motion resources remain retained but do not make that still a Live Photo. Selecting a video makes the item a video.

`GET /api/assets/{id}` also returns `edits`, an array of retained native adjustment records. Each includes its original `hash`, optional `sourceKey`, editor bundle ID, format/version and record timestamp, a `state` (`parsed`, `unsupported`, or `unavailable`), optional coordinate `metadata`, and the complete `adjustments` array. Supported records contain XML-plist `adjustmentData` with raw DEFLATE JSON or direct JSON; decoding reads at most 4 MiB for the plist and decompressed payload. Binary keyed archives and other private formats remain available as original downloads and return `unsupported`. Extraction is read-only and runs when details are requested; it neither rewrites stored metadata nor queues media work. Consumers associate a record only with resources from its exact `sourceKey`. An enabled operation documents a stored treatment, including camera processing; it does not establish that the user changed that setting in Aura.

### Saved rotation

Assets and file records include `rotation`, an absolute clockwise angle of `0`, `90`, `180`, or `270` relative to the unedited browsing orientation. Assets also include nonzero `motionRotation` for their motion resource. Stored `width` and `height` continue to describe the source dimensions; consumers swap them for quarter-turn display geometry without changing source metadata or pixel hashes. `capabilities.rotation` advertises the save endpoint.

`PATCH /api/assets/{id}/rotation` requires an original `hash` belonging to that item, the desired `rotation`, and the previously observed `expectedRotation`. The selected resource and its browsing derivatives must be ready. A still image's motion is included only when one video matches its Apple content identifier, or one matching PhotoKit original/full-size paired-video role belongs to its exact source group. The motion's saved direction receives the still's rotation delta. Unrelated or ambiguous videos and other image versions remain unchanged. Saving an individual video changes that video alone.

Save prepares lossless metadata-only variants, rechecks ownership, processing/deletion state and previous directions, then commits the hash-associated decisions together. Success returns the same `{asset,files,metadata,edits}` shape as the detail endpoint. A stale direction, changed resource pair or incomplete preview returns 409 without committing a new direction. Missing resources return 404 and invalid angles or omitted fields return 400. Pending permanent deletion retains the existing `asset_deletion_pending` response. Reopening the library retains the saved direction; saving `0` restores the unedited browsing orientation. Downloaded originals are unchanged, and ZIP manifests include the rotation fields.

### Saved Frame Covers

Assets and file records expose optional `cover:{motion,time,revision,width,height}`. The selection belongs to the displayed original hash; `motion` identifies the immutable video supplying the frame, and `time` is its actual frame-start time in seconds relative to the video's start. `width` and `height` describe the motion's native display orientation before Aura rotation. Source dimensions, metadata, fingerprints and original downloads remain unchanged. A selection follows its owner through grouping while the supplying motion remains in the same item; detached or permanently deleted motion does not provide a displayed cover. `capabilities.coverFrames` advertises these endpoints.

`GET /api/assets/{id}/frame` requires single `hash`, `motion`, and finite nonnegative `time` query parameters. For a video, both hashes are the selected video hash. For a Live Photo, the motion must be the still's unique Apple content-identifier match or exact PhotoKit original/full-size paired-video resource. Optional `rotation=0|90|180|270` defaults to the owner's saved direction, and `size=thumb|preview` defaults to `preview` (640 or 2560 maximum dimension). The JPEG response is `no-store`; it does not save an edit. Requests inside a frame resolve to that frame, including variable-rate sources and the last frame. A timestamp at or beyond the video stream's duration returns 400.

`PATCH /api/assets/{id}/cover` requires `{hash,motion,time,expectedCover}`. `expectedCover` is the previously observed revision, or an empty string for the source cover. A numeric `time` selects the containing frame; `null` restores the source still or automatic video cover. Save renders independent thumbnail and preview files from the original video before committing a replaceable decision in the existing catalog. It rechecks membership, directions, processing/deletion state and the previous revision, then returns the detail response. A stale selection returns 409 with `code:"cover_changed"`; invalid pairing or time returns 400. Acknowledged originals and native Photos remain unchanged.

Selections survive server restart and processing retries. Missing cover derivatives rebuild from the original and persisted selection; rotation applies without changing the selection. Restoring the source removes the active display edit, and later media requests with an obsolete revision return 409. NAS full packages include the decisions and cover derivatives; legacy original/catalog snapshots rebuild derivatives after isolated recovery.

### Shared library filters

`GET /api/assets` and `GET /api/timeline` accept the same optional scalar parameters. Empty values omit a filter; whitespace-only `q`, `camera`, and `lens` also omit it. All supplied filters combine with AND before cursor pagination. Both endpoints return 400 for repeated filter parameters, unknown enum values, malformed dates or numbers, negative or non-finite numeric bounds, and a lower bound greater than its upper bound. Enum values are case-sensitive. Contradictory valid filters return an empty result.

| Parameter | Values | Meaning |
| --- | --- | --- |
| `view` | `all`, `albums`, `favorites`, `live`, `videos`, `grouped`, `automatic`, `merged`, `trash` | Default `all` excludes recently deleted items. `albums` uses the same visibility and combines with `album` to select a specific album. `trash` includes only deleted items; other views also exclude them. `grouped` requires more than one image original; `automatic` and `merged` select its automatically combined and manually merged items respectively. |
| `q` | Text | Literal substring of any original filename or retained metadata JSON. |
| `from`, `to` | `YYYY-MM-DD` | Inclusive capture-date bounds, compared to the stored date portion of `asset.captured_at`. |
| `album` | Album ID | Require membership; a nonexistent album returns 404. |
| `excludeAlbum` | Album ID | Exclude members of that album. |
| `excludeAlbums` | `true` | Exclude items belonging to any album; omitted, empty, or `false` leaves this filter off. |
| `kind` | `photo`, `live`, `video` | Logical item kind; `photo` excludes Live Photos and videos. |
| `format` | `jpeg`, `heic`, `png`, `gif`, `webp`, `tiff`, `raw`, `avif`, `mov`, `mp4` | Match any original resource, including secondary images and paired motion, using detected MIME and the filename fallbacks below. |
| `orientation` | `landscape`, `portrait`, `square`, `panorama` | Primary dimensions after saved rotation: width greater than height, less than height, equal to height, or width at least twice height. Panorama also qualifies as landscape. Unknown or nonpositive dimensions match none. |
| `status` | `ready`, `queued`, `processing`, `error` | Primary file processing status. A secondary resource's status does not change this match. |
| `location` | `with`, `without` | Presence or absence of location on any one original: both native latitude/longitude hints, both GPS latitude/longitude metadata tags, or a nonempty combined GPS position/coordinates tag. Zero coordinates are present. |
| `versions` | `single`, `multiple` | Exactly one or more than one original with MIME `image/*`. Paired motion and adjustment resources do not count. A one-image Live Photo is `single`; pure videos and items with no identified image match neither. |
| `grouping` | `automatic`, `manual` | Multi-image items with the corresponding grouping classification; combines with every view, including albums and trash. |
| `albumState` | `in`, `none` | Belongs to at least one album, or to none. `none` has the same effect as `excludeAlbums=true`. |
| `camera` | Text | Match a `Make` or `Model` metadata value on any original. |
| `lens` | Text | Match `LensMake`, `LensModel`, `LensID`, `Lens`, `LensType`, `LensInfo`, `LensSpec`, or `LensSpecification` on any original. |
| `cameraMatch`, `lensMatch` | `contains`, `exact`, `missing` | Mode for the corresponding equipment filter; omitted or empty defaults to the existing literal substring behavior. `exact` compares the whole trimmed scalar tag using SQLite `NOCASE`. `missing` requires an empty corresponding name and matches items with no recognized nonempty scalar equipment tag on any retained original; a secondary version's record counts as present. |
| `minSize`, `maxSize` | Nonnegative integer bytes, at most 9223372036854775807 | Inclusive primary-file size bounds; secondary resource sizes are not summed. |
| `minMP`, `maxMP` | Nonnegative finite floating-point megapixels | Inclusive primary resolution bounds, calculated as width × height / 1,000,000 without display rounding. Unknown or nonpositive dimensions are excluded even when a bound is zero. |
| `addedFrom`, `addedTo` | `YYYY-MM-DD` | Inclusive import calendar dates in the service's local timezone (`Asia/Shanghai` on `nas`), applied to the UTC `asset.created_at` timestamp. Bounds run from local midnight on `addedFrom` through, but excluding, local midnight after `addedTo`; fractional seconds retain their exact boundary membership. This is the retained logical item's creation date, independent of capture date and the date a version or album membership was added. |

Format matching uses JPEG, HEIC/HEIF (including sequence MIME types), PNG, GIF, WebP, TIFF, vendor RAW, AVIF, QuickTime, and MP4 MIME types. `heic` also matches `.heic`/`.heif`; `raw` also matches `.dng`, `.cr2`, `.cr3`, `.nef`, `.arw`, `.raf`, `.rw2`, `.orf`, `.pef`, and `.srw`, since these resources can have generic container MIME types. Other formats use their corresponding extensions only when MIME is empty or `application/octet-stream`; JPEG includes `.jpg`/`.jpeg`, TIFF includes `.tif`/`.tiff`, and MP4 includes `.mp4`/`.m4v`. MIME and extension comparisons ignore ASCII case. An item can match multiple format choices because it retains several originals, or because a RAW container also identifies as TIFF. File records represent originals; generated previews and playback files do not supply matches.

Camera, lens, and GPS metadata recognize exact tag names and colon-prefixed group suffixes such as `IFD0:Make`, `ExifIFD:LensModel`, and `Composite:GPSLatitude`. Location requires a pair on the same original, or a complete `GPSPosition`/`GPSCoordinates` field; latitude/longitude references, altitude alone, nulls, and empty text do not establish location. Camera/lens query values and `q` are trimmed. Equipment matches accept text and numeric scalar tags only; text matching modes treat `%`, `_`, and backslash literally and ignore ASCII case, without non-ASCII case folding. `q` retains literal substring matching. Exact selection such as `camera=iPhone%2016%20Pro&cameraMatch=exact` excludes `iPhone 16 Pro Max`. Camera/lens matching does not search filenames or unrelated metadata tags. Different filters may match different resources of the same logical item.

`GET /api/filter-options` uses the same Portal authentication and fixed EXIF keysets. It ignores all view, filter, cursor, and limit parameters, includes every retained original linked to a catalog asset (including trash), and never reads historical permanently deleted metadata. Per original, cameras prefer `Model` over `Make`; lenses prefer `LensModel`, `LensID`, `Lens`, `LensType`, then the equal-priority `LensInfo`/`LensSpec`/`LensSpecification` tier, with `LensMake` last. Only nonempty trimmed text/numeric values qualify; ties between group-prefixed tags are retained. Each array is deduplicated and sorted ascending with SQLite `NOCASE`, choosing the binary-smallest spelling for case variants. There is no list cap; an empty library returns two empty arrays. Dropdowns send the chosen `camera` or `lens` with its corresponding `Match=exact`.

Cursor pagination sorts by capture date and asset ID descending. Pass the returned cursor unchanged with the same filters; reset it when filters change. The timeline returns calendar-month keys such as `2026-10`, newest first, counting matching logical items across all pages and ignoring `cursor` and `limit`. A month picker can omit `from` and `to` while retaining every other filter, including import dates, then set the selected month's inclusive capture-date bounds. Library mutations refresh month counts along with items and ordinary counts. The web interface no longer exposes favorites; the legacy API field, filter, and native import hints remain compatible.

For example, `/api/assets?kind=live&format=heic&location=with&versions=single&minMP=12&addedFrom=2026-10-01&limit=24` lists matching Live Photos; `/api/timeline` with the same filter parameters counts them by capture month. These read-only endpoints use catalog/resource indexes and rebuildable metadata projections. Pending projection updates are synchronized before filtering; existing original metadata is not rewritten.

## Deletion and restore

`PATCH /api/assets/{id}` with `trash:true` moves an item to recently deleted; `trash:false` restores it. All originals, native paired resources, and album memberships remain stored. `PATCH /api/assets` accepts 1–1000 exact IDs and a required boolean `trash`, validates the entire batch, and returns `{updated:[assetId]}`. Invalid or unavailable items reject the batch without partially applying it. Ordinary removal has no automatic expiry.

`POST /api/assets/purge` requires the exact confirmation string `永久删除` and 1–1000 selected trash IDs. It rejects active items instead of deleting them implicitly. After committing the durable cleanup intent, it returns 202 `{requestId,state:"pending",accepted:[assetId]}`. Submission is not proof that file cleanup has finished. Repeating an identical accepted selection can recover the existing request; a completed identical retry may return 200 with `state:"complete"`.

`GET /api/deletions/{requestId}` returns `{id,state:"pending"|"complete",ids:[assetId],bytes,error?}`. `bytes` is the planned original-catalog byte count, not measured filesystem space released. A cleanup failure remains pending with an error and is retried; interruption or restart does not discard the intent. Pending assets expose `deletionPending:true`, and `/info` reports `pendingDeletions` as the number of logical items awaiting permanent cleanup. Restore, split, merge, or conflicting catalog mutations return 409 with `code:"asset_deletion_pending"` while cleanup is pending. Completion removes live originals, derivatives, matching temporary material, catalog resources, and memberships for that request. Albums themselves, system Photos, existing backups, and browser caches are unchanged.

`capabilities.permanentDelete` advertises this protocol. Deleted hashes are reported with 410 `{error,code:"original_deleted",deleted:true,scope:"hash",hash}` rather than as missing originals. Upload preparation, chunks, and completion can instead return `scope:"source"` with the exact `sourceKey` when that source is intentionally excluded. Clients must not apply a source-scoped rejection to another source retaining the same hash. Minimal guards survive completion to prevent automatic reimport; no API bypasses them to restore permanently deleted originals.

Wrong confirmation or an empty/oversized selection returns 400. A selection containing an active item returns 409 `asset_not_trashed`; missing selected IDs return 404. An overlapping but nonidentical pending selection returns 409 `asset_deletion_pending` with its `requestId`. ZIP requests for pending or completed deleted items return 410 `original_deleted`; use upload status to check a specific original hash.

Automatic grouping does not merge existing active and trashed items. Manual merge across their visibility states returns 409 with `code:"trash_state_conflict"`; restore or remove the relevant items explicitly first. Splitting an item preserves trash state and album memberships rather than restoring the separated version.

## Tasks and review

Paginated jobs accept `paged=true`, `status=all|queued|processing|error|ready`, `limit` (default 50, maximum 240), and `cursor`, and return `{items,next,counts,retentionHours:24}`. Queued and processing files remain visible until they finish. Ready and failed records remain visible for 24 hours after the latest attempt finishes; older records without attempt timestamps use original creation time. This window applies equally to every status count and page, and never removes catalog rows, original bytes, or resumable upload state. Pages sort by `activityAt` and hash descending, using the finish time, start time, or original creation time in that order. Treat cursors as opaque.

Each item contains `hash`, `name`, `mime`, `size`, `assetId`, `status`, `createdAt`, and `activityAt`, with optional `error` and `progress`. Progress contains attempt `startedAt`, optional `finishedAt`, and ordered `steps`: each step has `id`, `label`, `status` (`queued`, `processing`, `ready`, `error`, or `skipped`), optional timestamps, `error`, execution `engine`, fallback `note`, and media-time `percent`. A queued file returns its planned steps; metadata can refine the plan after decoding the media type. Older completed records have no step history. Counts contain `all`, `queued`, `processing`, `error`, and `ready`. Full metadata remains in asset details or the legacy unpaged response. `ready` means browsing resources are ready; accepted originals can also be downloaded while derivative processing is pending or failed. Batch retry accepts 1–1000 hashes and returns 409 if any selected resource is no longer failed, without partially queuing the batch.

`GET /api/uploads?paged=true` returns `{items,next}` for incomplete sessions, using the same default/maximum page sizes. Each item includes `id`, `name`, `size`, `offset`, `createdAt`, `state`, and `missing`. Pages sort by creation time and ID descending. These server records survive browser restarts. The client must recover or reselect the original source file to continue; listing a session grants no background file access and does not discard its acknowledged chunks.

Similar review supports `source=dhash` (default), `source=dino`, `paged=true`, `limit`, and an opaque cursor specific to the selected source. dHash pairs contain `{left,right,distance,source:"dhash"}`. DINO pairs contain `{left,right,distance:0,source:"dino",score}`, where `score` is normalized-feature cosine similarity, not a duplicate probability. DINO candidates are limited to the incremental top-20 neighbors with score at least 0.7, exclude pairs already passing the dHash conditions, and are ordered by descending score with asset IDs as tie-breakers. Ignored pairs are omitted from both sources. Ignore and undo append reversible decisions for the explicit pair; they do not alter catalog membership or original files. Manual merges remain separate user actions.

`/api/info.similarityIndex` and paged DINO results' `index` report `{state,total,ready,pending,errors,engine?,batchSize,waitSeconds}`. States are `starting`, `idle`, `waiting`, `processing`, `unavailable`, or `disabled`. Counts cover ready primary images with available thumbnails; `pending` includes failed images waiting to retry. DINO works asynchronously in batches of at most 16, after ten seconds for a partial batch. It never changes upload or media-job status. Candidate pages may change while background analysis adds records; refresh starts from the latest result set.

Both similar endpoints accept optional `minScore` and `maxScore` with `source=dino`, finite normalized bounds from 0.7 to 1 inclusive, defaulting to 0.7 and 1. Candidates within the inclusive range remain, before pagination and counting. Scores are compared at their stored float32 precision and capped at 1 for filtering and percentage display. Invalid bounds or a lower bound above the upper bound return 400. Changing either bound starts a new pagination sequence. The workspace places a dual-handle slider beside the review-source tabs; the floating window uses the same control and combines it with the outside-album filter. Handles adjust in 0.1-percentage-point steps and commit on release, retaining existing cards during the request. Selecting the full range from 70% to 100% restores all candidates.

Paged similar responses include `total` for the selected source after score filtering and `counts:{dhash,dino}` for both unfiltered sources across every page. Each candidate is one distinct photo pair after current visibility, grouping and dismissal rules. Counts reuse the fingerprint index and DINO candidate snapshot and remain cached until the review revision changes. The two tab badges show these unfiltered totals, including zero, and update after dismissal, undo, merging or refreshed analysis. The workspace shows a separate filtered result count when a narrower range is selected.

`GET /api/assets/{id}/similar` filters candidates to one visible library item. It accepts `source=dhash|dino` (default dHash), `limit` (default 24, maximum 100), and an opaque cursor, and returns `{items,assets,total,next}` with the same pair/card shapes and DINO `index` when applicable. dHash orders by ascending distance, DINO by descending score, and both use the other asset's ID as a tie-breaker. The current item, recently deleted or pending-deletion items, and dismissed pairs are excluded; DINO retains the review list's exclusion of dHash matches. Missing or unavailable reference items return 404.

Visible cards returned by `GET /api/assets`, including ID refreshes and album pages, include `similarCounts:{dhash,dino}`. Each value counts the other eligible library items in the corresponding unfiltered per-photo similar response, independent of gallery filters and album membership. dHash counts use indexed lookups for the returned page; DINO counts aggregate the cached review snapshot. Recently deleted and pending-deletion reference cards omit the field. Gallery badges omit zero values and open the same floating similar-photo window directly, retaining the current album context.

With `outsideAlbums=true`, candidates sharing any album with the reference item are excluded before pagination and counting. Optional `album=<albumId>` restricts that exclusion to one album containing the reference item; an invalid ID or a non-member reference returns 400. Without album memberships, outside-album filtering leaves all candidates eligible. The viewer's floating similar-photo window shows both algorithms separately, supports independent pagination and comparison, and uses the current album when opened from album browsing. Other entry points exclude the union of the reference item's albums. Filtering and browsing do not change memberships, grouping, or originals.

The history response is `{items,assets,next}`. Items contain `id`, `createdAt`, `left`, `right`, `canRestore` and optional `reason`, `hash`, and `name`. Similar history returns the latest effective `similar-ignore` decision for each pair across both recommendation sources; undo uses the existing `DELETE /api/similar/ignore` and remains available after refresh. Missing current cards are omitted from `assets`; undoing a dismissal does not recreate a removed or merged photo.

Split history returns decisions without a `split-restore` record. New split decisions preserve a remaining original's hash as an anchor and the separated filename; old `{from,to,hash}` records remain readable. Restoration resolves the retained item by its ID, follows recorded merge destinations if its ID changed, and can use an unsplit anchor if neither ID is retained. It moves only the recorded hash. Other originals in the separated item remain there. Album memberships are added to the target, favorites are retained, and both items must have compatible trash state and no pending permanent deletion. A removed original/target, a newer split of the same hash, or a changed separated-item identity returns 409 `split_restore_conflict`. A successful restore appends `split-restore`, removes an empty logical item, refreshes primary/motion projections and returns the retained item's ID. Repeating it is idempotent. It does not unlink or rewrite originals, restore trashed items, or create a user-merge decision. Media processing no longer treats that restored split as an active grouping exclusion.

## Albums

| Method and path | Behavior |
| --- | --- |
| `GET /api/albums` | Array of albums ordered by creation time and ID descending |
| `POST /api/albums` | `{name,assets?:[assetId],groupId?:groupId}`; create, optionally assign a group and add items atomically; returns 201 |
| `POST /api/albums/common` | `{assets:[assetId]}`; albums containing every selected visible item, in normal album order |
| `DELETE /api/albums/assets` | `{albums:[albumId],assets:[assetId]}`; atomically remove selected memberships across multiple albums; returns `{removed:true}` |
| `PATCH /api/albums/group` | `{albums:[albumId],groupId:groupId|null}`; atomically move 1–1000 albums to a group, or to ungrouped with explicit null |
| `POST /api/albums/import` | `{sourceKey,name,assets:[assetId]}`; idempotent native source mapping and additive membership import |
| `GET /api/albums/{id}` | Album name, visible item count, cover asset, and timestamps |
| `PATCH /api/albums/{id}` | `{name}`; rename |
| `PATCH /api/albums/{id}/cover` | `{assetId:assetId}`; select one visible member as cover, or `{assetId:null}` to restore automatic selection; returns the updated album |
| `DELETE /api/albums/{id}` | Delete the album and its memberships; returns `{deleted:true}`; preserves library items and originals |
| `POST /api/albums/{id}/assets` | `{assets:[assetId]}`; idempotent, atomic addition |
| `DELETE /api/albums/{id}/assets` | `{assets:[assetId]}`; idempotent removal of memberships only |

Album responses contain `id`, `name`, `groupId` (empty for ungrouped), `count`, `createdAt`, `updatedAt`, and optional `cover` using the asset response shape. Counts and covers exclude recently deleted items. The selected member supplies the cover while it remains visible in the album; otherwise the newest visible member supplies the automatic fallback. Selection follows the chosen original hash through merge/split, and uses the current item's thumbnail, rotation and video-cover/key-photo revision. Cover writes require `assetId` as an ID or explicit null; a missing field, invalid ID, non-member or recently deleted item returns 400, and pending permanent deletion returns 409. Selecting or resetting a cover changes neither membership nor originals. Names contain 1–100 Unicode characters after trimming. Membership changes accept 1–1000 IDs; creation permits an empty list. Missing or recently deleted assets reject the entire addition with 400. Missing albums return 404. Removal does not require the item to remain visible. Merge transfers memberships to the retained item; split copies memberships to the new item.

Common-album lookup and multi-album removal accept 1–1000 unique valid IDs per list. Lookup returns an empty array if any selected item is missing or recently deleted. Removal is idempotent for absent memberships, rejects missing albums with 404 and pending permanent deletion with 409, and commits no partial changes. It updates the affected albums' timestamps and preserves library items, originals and unrelated memberships. The selection toolbar loads the current intersection, supports choosing multiple destination albums, and requires confirmation before removing memberships.

### Album groups

| Method and path | Behavior |
| --- | --- |
| `GET /api/album-groups` | Array of single-level groups in saved order, followed by unranked groups in creation-time and ID descending order |
| `POST /api/album-groups` | `{name,albums?:[albumId]}`; create and optionally move up to 1000 albums atomically; returns 201 |
| `PATCH /api/album-groups/order` | `{groups:[groupId]}`; replace the explicit ordering with up to 1000 unique active IDs; an empty array resets to creation order; returns `{ordered:true}` |
| `PATCH /api/album-groups/{id}` | `{name}`; rename; returns the updated group |
| `DELETE /api/album-groups/{id}` | Delete the group; its albums become ungrouped; returns `{deleted:true}` |

Group responses contain `id`, `name`, `createdAt`, and `updatedAt`. Names follow the album name limits. Each album belongs to at most one group. Missing albums or missing/deleted destination groups return 404 without partial changes. Moving requires an explicit valid group ID or null; missing/malformed destinations and invalid batch sizes return 400. Moving or deleting a group preserves albums, photo memberships, covers and original bytes. Native import preserves the Aura-side group assignment and creates new albums ungrouped.

Ordering requires a non-null array; omitted/null arrays, duplicates and oversized requests return 400, and missing/deleted IDs return 404. Invalid requests leave the saved order unchanged. Omitted groups follow explicitly ranked groups; deleting a ranked group does not affect the order of the remaining groups. Ordering persists in the existing decision log, independently of album assignment.

Native import source keys use `photokit-album:<client-library-id>:<collection-id>`. Source mappings are retained in the existing decision log. The import adds at most 1000 visible items per request, preserves an Aura-side rename, and never propagates removals from Apple Photos. A mapped album deleted in Aura returns 409 with `code: "imported_album_deleted"` instead of being silently recreated. Clients preserve that user decision and surface it separately from network failures. Native clients must require `capabilities.albumImport` before enabling this operation.

## Backup and recovery

NAS backup and recovery are agent-operated through server-operations tooling. Portal has no backup/recovery API or page, and Aura exposes no API for starting a backup. Verify recovery packages through the agent-operated workflow in [Operations](OPERATIONS.md).

## Media

All media and playback endpoints retain Portal authentication. `GET /api/playback/{sha256}?rotation=0|90|180|270` returns `{source?:{url,mime,codecs?},stream:{url,mime},duration,frameRate?}`. A single optional direction defaults to the file's saved direction. Native `source` eligibility requires an MP4/MOV container, an absolute start timestamp at most 1 ms and a requested Aura direction of zero. Eligible video is H.264 tagged `avc1`/`avc3` with Baseline, Constrained Baseline, Main or High profile and 8-bit 4:2:0 pixels (`yuv420p` or full-range `yuvj420p`), or HEVC tagged `hvc1`/`hev1` with Main or Main 10 profile. The first audio stream, if present, must be AAC-LC or signed 16-bit little-endian PCM (`pcm_s16le`); only AAC sources advertise `mp4a.40.2`. Sources outside the timestamp tolerance retain HLS's normalized timeline, and saved Aura rotations use pixel-transformed HLS rather than CSS-only rotation.

The browser tries `source` if either its MIME/codec hint or its container MIME is accepted. It falls back to `stream` after an actual playback failure or loaded metadata with zero video width, which can otherwise leave only audio playing. These hints do not guarantee video or audio support on every device.

`GET` and `HEAD /media/{sha256}/{kind}` accept `original`, `source`, `thumb`, `preview`, and the legacy `play` alias. `original` is a byte-identical attachment with the original filename. `source` serves immutable video bytes inline, using MP4 MIME for ISO BMFF/QuickTime video; a nonzero requested Aura direction returns 409 and uses segmented playback instead. Both support HTTP Range. `play` redirects to the HLS playlist and is not an MP4 representation.

`GET` and `HEAD /media/{sha256}/stream/index.m3u8?rotation=N` describe the complete finite timeline without encoding it. `/media/{sha256}/stream/{segment}.ts?rotation=N` serves a request-triggered four-second H.264/AAC MPEG-TS segment; the final segment is shorter. Segment indices begin at zero. A distant seek generates that window rather than all preceding footage; a native HLS player may also request opening segments for metadata. Source orientation and requested Aura direction are baked into the segment's displayed pixels, the original frame rate is retained, and HDR uses the bounded BT.709 SDR conversion described in [Architecture](ARCHITECTURE.md#data-flow). That fallback does not render Dolby Vision dynamic adjustments. Segments use a bounded transient cache outside the catalog and never produce a complete playback MP4. Successful cached responses expose the actual encoder in `X-Aura-Playback-Engine`; a cold `HEAD` returns media headers without generating a segment. Cache misses and encoding errors do not requeue whole-file media processing.

Thumbnail/preview requests use the saved direction by default; an optional single `rotation=0|90|180|270` selects a browsing variant. They default to the active saved cover; optional `cover=original` selects the source derivative, and `cover=<revision>` requires that current selection or returns 409 `cover_changed`. Web clients include cover and direction queries so cached representations remain distinct after save/reset. JPEG rotation variants retain compressed pixels and add EXIF orientation. These parameters do not transform an original download.

`POST /api/files/{sha256}/rebuild-cover` synchronously rebuilds a ready video's automatic thumbnail and its active selected-frame JPEGs, or a still resource's active Live Photo key-photo JPEGs. It takes no body and returns `{hash,status:"ready"}`. It preserves originals, catalog metadata/classification, grouping, album memberships, saved frame time/revision and rotations; unlike whole-file retries, it does not publish metadata or enqueue catalog processing. Existing original locks, processing admission and permanent-deletion guards protect generation; completed JPEGs replace their previous files atomically. Missing resources return 404, an invalid identity or still without a selected motion returns 400, and processing, selection or deletion conflicts return 409. Rotation variants refresh from their base JPEG's new source stamp. Callers should use a new thumbnail/preview URL version after a recipe rebuild.

Successful original/source and JPEG responses use `Cache-Control: private, max-age=86400`, `Last-Modified`, and an ETag. Original/source ETags identify their SHA-256; JPEG ETags include the requested direction, opened file's size and nanosecond modification time so rebuilt bytes have a new validator. Conditional GET/HEAD can return 304; matching `If-Range` requests return selected bytes, while an obsolete validator sends the full representation. Media failures use `no-store`. Browser caches can retain fresh original/JPEG representations for up to 24 hours; explicit retries use a new request URL. Missing or stale JPEG rotation variants rebuild from unedited derivatives. Missing base JPEGs can be requeued from the jobs interface or by requesting a missing derivative of a ready resource; a cold HLS cache does not change catalog readiness.

Permanent deletion is limited to the confirmed selected-trash protocol above; media reads do not delete originals. Export/import of the catalog for migration is a maintenance operation, described in [Operations](OPERATIONS.md).

## Indexed catalog and bounded refresh

`GET /api/info` includes a numeric `revision` for the catalog. Additive SQLite projections track metadata filters, activity timestamps, deletion guards and DINO pending work; authoritative originals and decisions are retained. Equipment options and summaries reuse cached results until their dependencies change.

`GET /api/assets?ids=<comma-separated-asset-ids>&limit=1000` refreshes at most 1,000 selected cards with the same visibility/filter rules as the normal list. Omitted IDs no longer match that filter or visibility state. Normal list pages default to 120 with a maximum of 240; ID refreshes allow up to 1,000. Consumers should refresh a bounded visible range rather than rereading every previously loaded page.

Paged `GET /api/similar` responses contain `assets`, a map from candidate asset ID to its card projection, alongside `items`, `next` and the DINO `index` where applicable. DINO pages reuse an ordered candidate snapshot until the review/catalog revision changes. The twenty-pair product pagination and existing cursor formats remain supported. dHash pages reuse a five-block fingerprint index and apply the exact distance/aspect gate.

Text searches retain literal substring semantics. A trigram index narrows suitable searches of at least three characters; the original escaped predicate verifies candidates. Short or escaped-wildcard searches use the existing predicate directly.
