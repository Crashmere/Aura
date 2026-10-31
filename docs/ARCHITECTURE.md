# Architecture

Aura stores original bytes without rewriting them and maintains grouping and visibility separately. Normal removal and regrouping are reversible; confirmed permanent deletion removes selected trash items' live originals through durable cleanup. Upload completion is independent of preview generation, so accepted originals survive processing failures and remain downloadable while derivatives are repaired.

## Technology selection

| Component | Choice | Reason |
| --- | --- | --- |
| HTTP service | Go, chi | Streaming uploads/downloads, bounded media subprocesses, static deployment, explicit routing |
| Web application | React, TypeScript, Vite | Component-based library and viewer, worker-based checksums, modern browser file APIs |
| Catalog and durable work queue | SQLite with WAL | Indexed capture-date pagination and transactional grouping for a personal library; portable consistent snapshots |
| Image decoding and previews | libvips | Demand-driven decoding of HEIC and common image formats; full-resolution pixels can be hashed without keeping the entire library in memory |
| Metadata | ExifTool | EXIF, XMP, Apple MakerNotes, QuickTime, ICC, GPS, and camera-specific metadata |
| Video previews | FFmpeg | Compatible H.264/AAC derivatives with byte-range playback; original codecs and metadata remain intact |
| Apple import | SwiftUI, PhotoKit, URLSession | Direct original-resource access, capture-date queries, paired-video export, system-managed background transfers |

Immich was considered because it already provides a strong photo pipeline and native apps. Its documented root-domain requirement conflicts with the established path-based `/aura/` entry point, and its account/authentication and duplicate-selection semantics require substantial cross-layer changes to preserve the existing personal-service workflow. PhotoPrism similarly introduces a separate account/library model. Aura instead composes mature media components with a focused catalog and client; this choice is about the desired behavior and integration, rather than the current server's storage capacity.

Official references: [Immich reverse proxy](https://docs.immich.app/administration/reverse-proxy/), [PhotoKit](https://developer.apple.com/documentation/photokit), [libvips](https://www.libvips.org/), [ExifTool](https://exiftool.org/), [FFmpeg](https://ffmpeg.org/).

## Data flow

```text
Browser files / PhotoKit original resources
  -> client SHA-256 -> prepare/resume -> durable 8 MiB chunks
  -> full server SHA-256 -> atomic original publication -> durable queued file
  -> ExifTool -> image/video derivatives -> duplicate/Live Photo grouping
  -> capture-date timeline, original versions, metadata and downloads
```

`assets/<first-two-hash-characters>/<sha256>` holds immutable originals until their confirmed permanent deletion. `aura.sqlite` stores files, logical assets, uploads, source observations, grouping keys, and user decisions. The existing decision log also retains manual primary choices, similar-pair dismissals, native album source mappings, and permanent-deletion intents and guards; these features require no new schema tables or columns. `derived/` contains disposable JPEG/MP4 previews. `incoming/` holds incomplete byte streams; `work/` holds short-lived decoding material. All paths are relative to the configurable data root.

The upload API identifies a byte stream by SHA-256. Chunk writes require the expected offset and flush before acknowledgment. Stale offsets return the actual offset. Completion recomputes the entire hash, verifies the expected byte count, publishes the original without replacing an existing object, and commits the file plus queue state transactionally. A retry recognizes an object published before a process interruption. Files with invalid checksums are never published. Per-original upload locks keep a slow client from blocking unrelated uploads; chunk body reads have a bounded deadline.

An existing catalog record is not sufficient to acknowledge a duplicate. Preparation and status also check that the original is a regular object of the expected size. A missing object can be recreated through the same complete-hash upload protocol while preserving its catalog identity and visibility. An existing abnormal object is reported for maintenance rather than overwritten. This availability check does not test readability or rehash every stored byte and does not replace full backup verification.

The current worker processes one original at a time. Image decoding is materialized once in a temporary libvips image and reused for both previews and full-pixel hashing, avoiding repeated RAW decoding. Its jobs survive restarts; interrupted processing returns to the queue. CPU-intensive work runs through libvips/FFmpeg subprocesses with explicit timeouts, while API and download requests remain independent. Worker parallelism and object storage can be introduced around this boundary when concrete throughput measurements justify them. No original-resolution cap is imposed; the per-file upload limit is 32 GiB, while each request is at most 8 MiB.

## Duplicate and version rules

1. **Equal file SHA-256:** reuse the stored bytes and append the source observation. No second object is written.
2. **Equal full decoded pixels:** automatically group the files. The digest covers complete samples, their dimensions/format/interpretation, and ICC metadata. A resized thumbnail or perceptual hash never triggers this rule. If a format cannot be fully decoded, no pixel-equality claim is made.
3. **Apple content identifier or explicit PhotoKit resource group:** group the related resources into one library item. Stills and video can arrive in either order. Filenames alone are never global pairing keys.
4. **Perceptual similarity:** a 64-bit difference hash and aspect ratio propose candidates. Hamming distance at most four produces review suggestions; users decide whether to merge or dismiss a pair. Candidate search uses a BK-tree and supports cursor pagination. Dismissals are durable, reversible decisions and never change original storage.

The primary image is selected deterministically by resolution, metadata completeness, GPS/date availability, and native-original preference until the user chooses a version explicitly. That choice is retained in the decision log and respected by reprocessing and grouping while the chosen resource belongs to the resulting item. A video becomes the motion resource of an image group. Metadata from all retained versions remains available; the detail response provides a combined view with the higher-ranked version winning duplicate keys. The original file is never rewritten to synthesize metadata.

All retained byte-distinct versions remain downloadable. A user can select another primary, split a resource, or restore an item from recently deleted. A split preserves the source item's trash state and album memberships; processing retries respect explicit grouping decisions. A later import can discover compatible exact relationships again. Source observations and merge/split decisions are retained for diagnosis.

Automatic grouping does not merge existing active and trashed groups or transfer their visibility by overwriting a conflicting group key. A newly arriving native resource can join its existing source's trash group without restoring it. Manual merge across active/trash states returns a conflict; the user must first make their visibility consistent. Processing reads current group identity at publication rather than restoring a cached identity after a concurrent merge or split.

Uploading an original whose item is in recently deleted does not restore it automatically. The upload response identifies that state so the web interface can offer an explicit restore action or open the existing item.

## Deletion

Normal removal updates the logical item's trash timestamp and preserves every original and membership. Restore reverses that visibility change. Batch removal and restore validate all selected IDs in one transaction; a failed batch does not partially update the catalog. List, album, month, and library counts refresh together after mutations, including uncertain request failures. Recently deleted has no automatic expiry or purge.

Permanent deletion is available only for explicitly selected trash items and requires a second confirmation. The server first commits a cleanup request in the decision log. That request identifies the selected logical items, exact original hashes, eligible source guards, and planned original bytes. It immediately blocks restore, grouping changes, uploads, processing, and media access for the affected resources. The worker then cancels and drains targeted processing, removes their original objects, derivatives, matching incoming chunks and proven work links, flushes affected directories, and removes catalog rows and memberships before recording completion. The intent survives failure or restart, so partial cleanup remains pending and can resume rather than being reported as complete. Upload and processing locks coordinate on each original hash; no SQLite transaction waits while acquiring those locks.

Completed requests retain minimal hash/source guards to prevent continuous import from recreating deliberately removed items. A source-wide guard is recorded only when no retained file or upload outside the selection still uses that source; shared sources from explicit splits are not grounds to remove or exclude the retained items. Resources already covered by another confirmed cleanup request do not count as retained, but their IDs, hashes, and bytes remain owned by that request. A scoped source rejection must not become a hash rejection for the same bytes retained under another source. These guards, pending requests, and cleanup results use existing decision records rather than a separate schema or external queue.

The web interface confirms permanent deletion in a separate dialog listing the selected items and their resources. The explicit confirmation button submits the existing confirmation token; no text entry is required. Cancel, Escape, and closing the dialog submit no deletion request.

Permanent deletion applies to the live Aura library, not system Photos, existing backup packages, browser caches, or downloads already in progress. It unlinks live files; it is not a secure-erase operation or a guarantee that the filesystem immediately releases the reported byte count. An older recovery point can contain the removed originals and older deletion history; production restoration remains an explicitly selected maintenance operation.

## Albums

Albums organize logical assets through `albums` and `album_assets` in the existing catalog. One item may belong to multiple albums; adding it again is idempotent. Creating an album with selected assets and changing membership each use a transaction, so an invalid or recently deleted asset rejects the complete addition. Names are trimmed and limited to 100 Unicode characters; each write accepts at most 1000 assets.

Album browsing reuses capture-date pagination, filename/metadata search, and date filters. The cover is the newest visible item. Recently deleted items retain membership but disappear from album counts, covers, and ordinary browsing; restoration makes them visible again. Removing membership or deleting an album leaves the assets and original files unchanged.

All merge paths transfer the union of the two items' album memberships before removing the redundant logical asset. A split inherits the source item's memberships for the new item while retaining the source's memberships. These rules also apply to automatic exact-match and Live Photo grouping.

The web navigation uses albums instead of favorites. The photo viewer opens the album chooser from its add button, and the library supports batch addition. The chooser can create an album and add the selected items in one transaction. An album's photo picker excludes existing members and retains selections across searches and pages. The legacy favorite field and upload hints remain for client/data compatibility, without favorite controls or badges in the web interface.

The library filter panel includes album membership: all items, members of any album, or items belonging to none. Legacy `unfiled` URLs and the prior browser preference migrate to the equivalent membership filter. Applying filters resets pagination and selection; membership changes refresh the filtered results without changing originals.

Optional native album import uses a stable client-library and PhotoKit collection source key. It adds already uploaded, visible items to the mapped Aura album in bounded transactions. It neither removes memberships nor propagates Photos deletions, and it preserves an Aura user's album rename. An explicitly deleted mapped album is not silently recreated.

## Browsing and task state

Library views, album selection, search, date filters, and the open photo are represented in browser URLs. Opening a photo adds a history entry; switching photos replaces that entry, so Back returns to the library. Switching library sections clears filters. The floating filter panel holds a draft until Apply; Cancel leaves the current results unchanged. Its dimensions cover media kind, original format, orientation, location, image versions, album membership, capture/import dates, camera/lens, primary resolution/size, and processing status. Assets and month counts share server-side filtering before pagination; the month picker omits capture-date bounds while retaining all other conditions. The API reference defines each dimension's resource scope. Device and lens selectors load deduplicated options from all retained library originals, including secondary resources and recently deleted items, whenever the panel opens. They use exact metadata matches; existing text-filter URLs retain substring behavior.

Thumbnail zoom is a browser preference with seven steps, from smaller to larger. The default shows seven columns above 720px and four on smaller screens; the endpoints are twelve/four columns on desktop and seven/one on mobile. Layout changes animate visible photo containers while anchoring a visible photo, and honor reduced-motion preferences. Dense layouts suppress crowded badges without changing selection or media data.

Selection mode supports individual photos, Shift ranges, and reversible day-group selection. Select-all applies to loaded items and excludes pending permanent deletions. Background processing refreshes preserve the loaded range and reconcile selections; pagination failures pause automatic requests until retry. The viewer shows the loaded position and nearby thumbnails, loads another page near the current boundary, and preloads at most two adjacent previews. Touch gestures and arrow keys navigate photos while native media controls, text input, composition, and modifier shortcuts retain their own behavior.

The task center reads durable file processing records and incomplete upload sessions, with cursor pagination and status filters. File status distinguishes accepted originals from pending, failed, and ready browsing resources. Retry queues metadata and derivative processing without changing original bytes; incomplete uploads require the client to reselect or recover the source bytes. Error messages remain available independently of the in-memory browser upload queue. A transient image-loading failure has a retry path instead of being presented indefinitely as server processing.

Whole-application NAS backup and recovery are agent-operated through server-operations. Aura's web application has no backup status card, backup archive controls, or dependency on Portal recovery APIs; Portal remains responsible for device authentication.

## Date selection and continuous import

The server extracts capture dates from original EXIF/QuickTime metadata; native PhotoKit capture dates and file modification times provide fallbacks. A missing timezone uses the configured runtime timezone. Date ranges are inclusive calendar dates. Browser batches transmit the selected range; the server checks the original capture date before publishing, discarding only out-of-range temporary uploads. Photos with missing capture metadata fall back to the provided file date.

Chrome can retain a user-authorized directory handle and check it every 30 seconds while the page remains running. A browser restart requires reconnecting the handle or reselecting files; existing server offsets remain reusable. Browser selection does not grant background access to the iOS system photo library.

The Apple companion queries PhotoKit by creation date and exports each `PHAssetResource` without conversion. It handles iCloud originals under the user's network and power policy. A stable client source ID plus PhotoKit asset ID pairs resources, and receipts avoid re-exporting completed, unchanged resources. Server availability reconciliation can invalidate a receipt only after a confirmed missing or incomplete original, allowing reupload without discarding receipts on authentication or network failures. The server still performs SHA-256 checks for every new transfer. iOS scheduling and application signing constraints are documented in [Apple](APPLE.md).

## Media fidelity

Original HEIC, RAW, JPEG, video, ICC, EXIF, GPS, embedded metadata, and native adjustment resources retain their uploaded bytes. JPEG previews use a maximum dimension of 2560; thumbnails use 640; video playback derivatives use a maximum dimension of 1920 and H.264/AAC without enlarging smaller source videos. These sizes affect browsing only. Unsupported RAW decoders may use the embedded camera JPEG for a preview, while retaining the full RAW original. Such embedded previews are excluded from automatic pixel-equivalence decisions.

Browser or operating-system conversion that occurs before Aura receives a file cannot be reversed by the server. Use PhotoKit or exported unmodified originals when preservation is required. Downloading a Live Photo returns a ZIP with every resource and an `aura.json` source manifest; saving a ZIP in an iOS browser is not a native Photos-library import operation.
