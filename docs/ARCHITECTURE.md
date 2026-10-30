# Architecture

Aura stores original bytes once and maintains a separate, reversible library view. Upload completion is independent of preview generation, so accepted originals survive processing failures and can be downloaded while derivatives are repaired.

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

`assets/<first-two-hash-characters>/<sha256>` holds immutable originals. `aura.sqlite` stores files, logical assets, uploads, source observations, grouping keys, and user decisions. The existing decision log also retains manual primary choices, similar-pair dismissals, and native album source mappings; these features require no new schema tables or columns. `derived/` contains disposable JPEG/MP4 previews. `incoming/` holds incomplete byte streams; `work/` holds short-lived decoding material. All paths are relative to the configurable data root.

The upload API identifies a byte stream by SHA-256. Chunk writes require the expected offset and flush before acknowledgment. Stale offsets return the actual offset. Completion recomputes the entire hash, verifies the expected byte count, publishes the original without replacing an existing object, and commits the file plus queue state transactionally. A retry recognizes an object published before a process interruption. Files with invalid checksums are never published. Per-original upload locks keep a slow client from blocking unrelated uploads; chunk body reads have a bounded deadline.

An existing catalog record is not sufficient to acknowledge a duplicate. Preparation and status also check that the original is a regular object of the expected size. A missing object can be recreated through the same complete-hash upload protocol while preserving its catalog identity and visibility. An existing abnormal object is reported for maintenance rather than overwritten. This availability check does not test readability or rehash every stored byte and does not replace full backup verification.

The current worker processes one original at a time. Image decoding is materialized once in a temporary libvips image and reused for both previews and full-pixel hashing, avoiding repeated RAW decoding. Its jobs survive restarts; interrupted processing returns to the queue. CPU-intensive work runs through libvips/FFmpeg subprocesses with explicit timeouts, while API and download requests remain independent. Worker parallelism and object storage can be introduced around this boundary when concrete throughput measurements justify them. No original-resolution cap is imposed; the per-file upload limit is 32 GiB, while each request is at most 8 MiB.

## Duplicate and version rules

1. **Equal file SHA-256:** reuse the stored bytes and append the source observation. No second object is written.
2. **Equal full decoded pixels:** automatically group the files. The digest covers complete samples, their dimensions/format/interpretation, and ICC metadata. A resized thumbnail or perceptual hash never triggers this rule. If a format cannot be fully decoded, no pixel-equality claim is made.
3. **Apple content identifier or explicit PhotoKit resource group:** group the related resources into one library item. Stills and video can arrive in either order. Filenames alone are never global pairing keys.
4. **Perceptual similarity:** a 64-bit difference hash and aspect ratio propose candidates. Hamming distance at most four produces review suggestions; users decide whether to merge or dismiss a pair. Candidate search uses a BK-tree and supports cursor pagination. Dismissals are durable, reversible decisions and never change original storage.

The primary image is selected deterministically by resolution, metadata completeness, GPS/date availability, and native-original preference until the user chooses a version explicitly. That choice is retained in the decision log and respected by reprocessing and grouping while the chosen resource belongs to the resulting item. A video becomes the motion resource of an image group. Metadata from all retained versions remains available; the detail response provides a combined view with the higher-ranked version winning duplicate keys. The original file is never rewritten to synthesize metadata.

All byte-distinct versions remain downloadable. A user can select another primary, split a resource, or restore an item from recently deleted. Recently deleted is a reversible visibility state and has no automatic purge. A manual split removes the group's automatic keys; a later import can discover exact relationships again. Source observations and merge/split decisions are retained for diagnosis.

Uploading an original whose item is in recently deleted does not restore it automatically. The upload response identifies that state so the web interface can offer an explicit restore action or open the existing item.

## Albums

Albums organize logical assets through `albums` and `album_assets` in the existing catalog. One item may belong to multiple albums; adding it again is idempotent. Creating an album with selected assets and changing membership each use a transaction, so an invalid or recently deleted asset rejects the complete addition. Names are trimmed and limited to 100 Unicode characters; each write accepts at most 1000 assets.

Album browsing reuses capture-date pagination, filename/metadata search, and date filters. The cover is the newest visible item. Recently deleted items retain membership but disappear from album counts, covers, and ordinary browsing; restoration makes them visible again. Removing membership or deleting an album leaves the assets and original files unchanged.

All merge paths transfer the union of the two items' album memberships before removing the redundant logical asset. A split inherits the source item's memberships for the new item while retaining the source's memberships. These rules also apply to automatic exact-match and Live Photo grouping.

The web navigation uses albums instead of favorites. The photo viewer opens the album chooser from its add button, and the library supports batch addition. The chooser can create an album and add the selected items in one transaction. An album's photo picker excludes existing members and retains selections across searches and pages. The legacy favorite field and upload hints remain for client/data compatibility, without favorite controls or badges in the web interface.

The library's `隐藏已入相片集` switch excludes items belonging to any album through the server-side `excludeAlbums=true` filter. It defaults to off, remembers the choice in browser storage when available, and applies only to the main library view. Album browsing and its photo picker remain unchanged. Toggling resets pagination and selection; membership changes refresh the filtered results without changing originals.

Optional native album import uses a stable client-library and PhotoKit collection source key. It adds already uploaded, visible items to the mapped Aura album in bounded transactions. It neither removes memberships nor propagates Photos deletions, and it preserves an Aura user's album rename. An explicitly deleted mapped album is not silently recreated.

## Browsing and task state

Library views, album selection, search, and date filters are represented in browser URLs so reload and browser navigation retain the browsing context. Month counts use the same catalog filters as the timeline; the month picker can query without date bounds to retain the other available months. The photo viewer supports touch navigation without taking over text input or modifier shortcuts.

The task center reads durable file processing records and incomplete upload sessions, with cursor pagination and status filters. File status distinguishes accepted originals from pending, failed, and ready browsing resources. Retry queues metadata and derivative processing without changing original bytes; incomplete uploads require the client to reselect or recover the source bytes. Error messages remain available independently of the in-memory browser upload queue. A transient image-loading failure has a retry path instead of being presented indefinitely as server processing.

Aura reads the existing protected, same-origin Portal recovery summary and links to Portal's data-protection page. It does not create another backup service or grant Aura access to the collector socket. A recorded backup, an available external volume, and a verified isolated restore are separate states; unavailable or unreadable metadata remains unknown rather than becoming a successful protection claim.

## Date selection and continuous import

The server extracts capture dates from original EXIF/QuickTime metadata; native PhotoKit capture dates and file modification times provide fallbacks. A missing timezone uses the configured runtime timezone. Date ranges are inclusive calendar dates. Browser batches transmit the selected range; the server checks the original capture date before publishing, discarding only out-of-range temporary uploads. Photos with missing capture metadata fall back to the provided file date.

Chrome can retain a user-authorized directory handle and check it every 30 seconds while the page remains running. A browser restart requires reconnecting the handle or reselecting files; existing server offsets remain reusable. Browser selection does not grant background access to the iOS system photo library.

The Apple companion queries PhotoKit by creation date and exports each `PHAssetResource` without conversion. It handles iCloud originals under the user's network and power policy. A stable client source ID plus PhotoKit asset ID pairs resources, and receipts avoid re-exporting completed, unchanged resources. Server availability reconciliation can invalidate a receipt only after a confirmed missing or incomplete original, allowing reupload without discarding receipts on authentication or network failures. The server still performs SHA-256 checks for every new transfer. iOS scheduling and application signing constraints are documented in [Apple](APPLE.md).

## Media fidelity

Original HEIC, RAW, JPEG, video, ICC, EXIF, GPS, embedded metadata, and native adjustment resources retain their uploaded bytes. JPEG previews use a maximum dimension of 2560; thumbnails use 640; video playback derivatives use a maximum dimension of 1920 and H.264/AAC without enlarging smaller source videos. These sizes affect browsing only. Unsupported RAW decoders may use the embedded camera JPEG for a preview, while retaining the full RAW original. Such embedded previews are excluded from automatic pixel-equivalence decisions.

Browser or operating-system conversion that occurs before Aura receives a file cannot be reversed by the server. Use PhotoKit or exported unmodified originals when preservation is required. Downloading a Live Photo returns a ZIP with every resource and an `aura.json` source manifest; saving a ZIP in an iOS browser is not a native Photos-library import operation.
