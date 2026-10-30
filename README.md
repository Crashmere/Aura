# Aura

A personal photo library that keeps original files, pairs Apple Live Photos, and groups duplicates without discarding their source data.

The web interface provides a chronological library, albums, month navigation, Live Photo and video playback, resumable uploads, original downloads, and duplicate review. Normal removal moves an item to recently deleted; confirmed permanent deletion removes its live originals and previews. A task center retains processing and upload state, while library links retain the current view and filters. The Apple PhotoKit companion imports original resources within a selected capture-date range, checks server original availability, and respects intentional permanent deletion.

## Run locally

Install Go 1.24+, Node 20.19+, libvips, ExifTool, and FFmpeg. Building the bundled Mac client requires macOS with Apple's Command Line Tools. On a Mac:

```sh
brew install vips exiftool ffmpeg
npm --prefix web ci
make build
bin/aura init --data .local/data
bin/aura serve --data .local/data
```

Open `http://127.0.0.1:18087/aura/`. Local loopback access has no separate login. Production belongs behind the shared ServerPortal authentication layer; the application must not be bound directly to a public interface.

For frontend development, run `npm --prefix web run dev` while the local Go service is running. The Vite server proxies API/media requests.

## Apple photos and installers

Download the current [Mac DMG and iOS IPA from GitHub Releases](https://github.com/Crashmere/Aura/releases/latest), or use Aura's upload dialog. The Mac DMG supports Apple silicon and Intel on macOS 14+. The iOS device IPA targets iOS 17+ and is intended for user signing with AltStore or Sideloadly. Both export PhotoKit resources directly, including stills, paired videos, RAW alternatives, and adjustment resources. [Apple client instructions](docs/APPLE.md) explain installation, authorization, and capture-date selection.

iOS Safari cannot continuously scan the system photo library or guarantee delivery of both Live Photo components. Import the IPA into AltStore or Sideloadly to sign it with your own Apple ID; it is not an App Store or TestFlight distribution. The Mac app is signed locally, without Developer ID notarization.

Client-source and packaging changes pushed to `main` automatically build both installers and publish the next version. [Client release operations](docs/CLIENT-RELEASE.md) describe version selection, validation, and retries. Server builds and deployments continue to run from the maintenance computer.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture and technology choices](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Operations, release, backup and migration](docs/OPERATIONS.md)
- [Apple companion](docs/APPLE.md)

GitHub stores source, configuration, and published client installers. Original photos, databases, credentials, working build directories, and backups are excluded.
