# Contract Validation

Validation uses isolated libraries and synthetic or public upstream test media. Production acceptance is read-only and never seeds demonstration photos into the personal library.

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
