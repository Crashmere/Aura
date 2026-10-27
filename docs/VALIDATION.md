# Initial Contract Validation

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

The maintenance computer lacks full Xcode and an iOS signing identity. iPhone installation, PhotoKit resource extraction on a user's authorized device, actual iOS background scheduling, and iPhone home-screen installation require real-device acceptance. Compilation and HTTP checks do not establish those results.
