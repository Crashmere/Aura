# Contract Validation

Validation uses isolated libraries and synthetic or public upstream test media. Production acceptance is read-only and never seeds demonstration photos into the personal library.

## Asynchronous DINO similarity

An isolated nas library using public photo fixtures verified DINOv2 ViT-S/14 extraction under the `aura` identity with NVIDIA execution. A three-image queue remained unprocessed during its initial wait and completed as one partial batch; sixteen additional ready images formed an immediate full batch. A separate real resumable upload completed its byte acknowledgment and final commit while its feature record was still absent; media publication and DINO progress remained independent.

The review API and UI separated dHash matches from DINO recommendations, excluded overlapping pairs, and preserved shared dismiss/undo decisions. Focused API validation with the Go race detector checked source-specific pagination and trash filtering. Missing derived records were recovered after restart. Permanent deletion of a selected synthetic item during an active DINO batch canceled/drained the batch, removed its feature and original, and did not recreate the feature afterward. All remaining synthetic original SHA-256 values were preserved. Production acceptance uses read-only health, progress and review queries.

## Initial library contracts

Verified during initial development:

- Chunk interruption/resume from an acknowledged nonzero offset, stale-offset rejection, server SHA-256 validation, and repeated upload without duplicate object storage.
- Metadata-only JPEG variants produce equal full-pixel hashes; an independently uploaded variant is automatically grouped. The richer EXIF/GPS version becomes primary.
- Stills and paired videos form one Live Photo through a native resource grouping key; original ZIP downloads preserve the SHA-256 of every component.
- Original download integrity, search, favorites, reversible trash, and rejection of cross-origin writes.
- HEIC and Fujifilm X100V RAF imports retain their original bytes and generate previews. RAW embedded-preview fallback never supplies an automatic full-pixel duplicate hash.
- Server-side capture-date filtering excludes out-of-range originals before publication.
- Native snapshots restore into a fresh directory and pass SQLite plus full original-hash verification. Candidate checks open the database read-only and a subsequent full snapshot verification confirms that check operations preserve the manifest. The manifest matches the shared media-retention contract.
- TypeScript/Vite and Go builds succeed. Both Mac architectures compile with Swift and pass code-signature verification. The hosted Xcode 16.4 build produces the iOS device arm64 executable and compiled icons; the IPA passes ZIP, platform, version, privacy and background-declaration checks.
- Desktop browser browsing, the image viewer, and Live Photo playback use real local API/media responses. The actual browser checksum worker and upload queue recognize a duplicate original. Narrow-screen upload layout has no horizontal overflow; ordinary Tab remains intercepted.
- The same original/Live Photo checks passed against an isolated Linux listener on ali; HEIC and RAF processing completed with the production libvips/ExifTool/FFmpeg packages.
- Isolated Nginx checks passed 152 public-icon/authentication-boundary assertions and 18 cookie-renewal assertions including Aura. Only exact branding assets bypass authentication.

The public test HEIC and RAF came from `immich-app/test-assets`; these fixtures remain outside Git and are not included in the deployed library.

## Deletion and reimport protection

The version 0.3 deletion protocol was checked with synthetic JPEG versions, a paired Live Photo, a standalone video, and durable upload sessions in an isolated local library. The checks established:

- Normal removal preserves original bytes and memberships. Grouped and timeline counts exclude trash. A batch containing an unavailable item changes none of the selected items.
- Manual and automatic grouping preserve separate active/trash states and conflicting source-key ownership. A new native resource can join its existing trashed source without restoring it. Split preserves trash, favorite, and album membership; subsequent media retry keeps the split identities.
- Permanent deletion rejects active items and incorrect confirmation. An accepted two-item request counts two pending logical items, blocks conflicting mutations and media/reimport access, and returns the same request for reordered identical retries.
- A deliberately obstructed derivative path leaves cleanup pending with one durable error. Restart after clearing the obstruction completes the original, derivative, selected incoming-upload, catalog, and membership cleanup. Completed retries remain idempotent.
- A retained split member, its original bytes, a shared-source upload, albums, and unrelated work files survive selected deletion. Legacy short-prefix work directories are removed only when resource ownership is proven. A clean single-pass purge removes same-hash work copies even when a repaired object's inode differs. Hash/source guards reject reimport while a retained hash remains usable under its other source.
- A deterministic processing probe verifies that pending deletion cancels active extraction, waits for work-hardlink cleanup, and does not wait for an unrelated hash's upload lock. Status remains responsive during extraction. Separate confirmed requests can guard a fully deleted source without expanding either request's selected files; an unrequested retained upload still blocks that source guard.
- Offline probes of the production Swift methods verify legacy receipt compatibility, mixed-receipt trash protection, explicit ordinary restore, strict 410 validation, sticky hash guards, independent source guards, journal recovery, excluded-resource counts, and termination of prepare/chunk/completion retries. Both Mac architectures compile and the universal executable passes strict signature verification without running the client or accessing Photos.
- The actual Chrome checksum worker and browser upload queue recognize a server hash guard after one real preparation request, show an intentional exclusion rather than an error, and do not retry when the same selected file is submitted again.
- Real browser removal/restore requests verify atomic batch scope, mobile action visibility, touch selection, and viewer navigation locks during mutation. A controlled failed response after a real commit reconciles items, counts, selection, and timeline. Typed confirmation and cancellation preserve the exact selection; real single and selected-batch purges remove all selected resources, including Live motion. Controlled pending/error status responses never announce completion, and retry preserves the submitted IDs. Pending-count changes and page reactivation resume stopped status polling; pending conflicting actions stay locked. Ordinary Tab and Shift+Tab remain intercepted in the confirmation input without a focus outline.

The catalog remains schema version 1 and passes SQLite integrity and foreign-key checks after cleanup. These synthetic checks do not delete existing NAS originals or establish real-device Photos/background behavior.

The maintenance computer lacks full Xcode and an iOS signing identity. iPhone installation, PhotoKit resource extraction on a user's authorized device, actual iOS background scheduling, and iPhone home-screen installation require real-device acceptance. Compilation and HTTP checks do not establish those results.

## GPU still-image compatibility

A synthetic 12-megapixel fixture set covers EXIF-rotated JPEG, HEIC, PNG, grayscale, alpha, Display P3 and CMYK inputs on NAS's RTX 3070. GPU and CPU runs retained identical original SHA-256 and canonical pixel hashes across the set. Preview/thumbnail dimensions and orientation matched. Decoded RGB mean absolute differences were below 1.25 out of 255 for these fixtures, reflecting different resizing/JPEG encoders rather than byte-identical derivatives. This is a bounded compatibility check, not a guarantee for every camera profile or RAW decoder. GPU work remains limited to derivatives; exact grouping uses the established libvips path.

## Parallel processing and interruption

Isolated synthetic checks with Go's race detector verified a four-job bound, separate image-worker event streams, two shared GPU slots, cancellation of active and waiting GPU requests, and continued processing after a selected hash is permanently deleted. Eight queued originals included an interrupted attempt; shutdown requeued every unfinished job, restart completed them, and concurrent source matches published into one logical item. Original SHA-256 checks and catalog integrity passed.

On NAS's Ryzen 9 5900HX, 64 GB RAM and 8 GiB RTX 3070, a 16-file batch of eight 24-megapixel JPEG variants and eight 10-second 1080p videos took 60.76 seconds with four jobs/two GPU slots and 36.17 seconds with eight jobs/four GPU slots. Increasing only the job count to six or eight took 56.21 and 56.84 seconds; four jobs/four GPU slots took 37.38 seconds. A separate 16-image JPEG/PNG batch took 5.10 seconds at four jobs/four GPU slots and 2.87 seconds at eight jobs/four GPU slots, supporting eight jobs for CPU image stages as well as four GPU slots for video throughput.

The eight-job/four-GPU configuration also completed four 80-megapixel JPEGs and four 10-second 4K videos in 24.49 seconds, reaching 5,525 MiB GPU memory and 2,467 MiB service memory. These initial JPEG/video batches reached eight processing jobs and at most 92 threads/processes under the former 128-task budget; Portal health requests remained within 10.2 milliseconds. Every planned GPU derivative step completed with a NVIDIA engine. Original SHA-256, canonical pixel hashes, catalog integrity and grouping comparisons passed. Subsequent HEIC-heavy imports exceeded that budget, so production now uses the native CPU bound and 1024-task configuration described in Operations.

A 512-original isolated NAS batch covers 256 HEICs, 128 JPEGs, 64 PNGs, 56 short MOVs and eight RAFs with distinct source bytes. The final configuration completed every resource with zero errors in 214.3 seconds, including an intentional interruption while eight jobs were active. Peak use was 198 threads/processes, 2,676 MiB service memory and 2,459 MiB GPU memory; cgroup task-limit rejections and automatic restarts were zero. The slowest sampled `/api/info` response was 97.5 milliseconds. Original hashes, SQLite integrity, foreign keys and representative HEIC/JPEG/PNG/RAF pixel identities passed after completion; DINO reached idle with all eligible thumbnails indexed. A further 32-file batch used sixteen concurrent HTTP clients with date-range metadata extraction, verified chunk offsets and complete-file publication, then confirmed duplicate receipts and original hashes. All uploads and media jobs completed without task-budget rejections.

Repeated RAF decoding initially produced different samples in both old and candidate programs. Pipe and file output from the same decoded image matched exactly. Restricting ImageMagick/OpenMP delegates to one thread made repeated decoding and all eight metadata-only RAF variants retain the same full-resolution pixel identity. The GPU derivative pipeline remains independent of this canonical decode path. Race-enabled regression checks verify that blocked ExifTool/libvips calls share four slots, cancellation drains active and waiting callers, a subsequent attempt can acquire a released slot, and a Python child that never reads its request cannot block past its deadline.

## Indexed catalog and incremental background work

Isolated legacy catalogs retained original file bytes and existing file metadata/group identity after additive index initialization. Race-enabled checks cover grouped equipment priority ties, literal substring/wildcard searches, zero-coordinate location presence, projection invalidation, repeated progress UPSERTs, durable hash/source deletion guards and removal of deleted search entries. A generated fingerprint set compared five-block retrieval against exhaustive Hamming/aspect checks and retained every qualifying pair.

On nas, isolated public-photo checks verified the ten-second partial DINO wait, immediate sixteen-image batches, upload completion before DINO readiness, dismissal/undo, model-child idle/restart recovery and selected permanent deletion while preserving other original hashes. Streaming libvips pixel output matched the previous raw-file bytes. A synthetic ten-thousand-item web library kept only nearby cards mounted during long scrolling; refresh fetched the first page and one bounded card set. Browser preparation overlapped transfer and both files completed after pause/resume. Universal Mac client compilation and signature verification passed; iOS device packages use the existing release workflow. Real-device PhotoKit scheduling remains separate from these checks.
