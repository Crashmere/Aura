# Aura

A personal photo library that keeps original files, pairs Apple Live Photos, and groups duplicates without discarding their source data.

The web interface provides a chronological library, favorites, Live Photo playback, video playback, date filters, resumable uploads, original downloads, and duplicate review. An Apple PhotoKit companion continuously imports original resources within a selected capture-date range.

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

## Apple photos

The Mac client is available from Aura's upload dialog after a release build. It exports PhotoKit resources directly, including stills, paired videos, RAW alternatives, and adjustment resources. [Apple client instructions](docs/APPLE.md) explain authorization, capture-date selection, and iOS installation.

iOS Safari cannot continuously scan the system photo library or guarantee delivery of both Live Photo components. The iOS native target requires an Apple signing identity and Xcode installation; it is not an App Store or TestFlight distribution. The Mac binary targets Apple silicon and is signed locally, without Developer ID notarization.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture and technology choices](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Operations, release, backup and migration](docs/OPERATIONS.md)
- [Apple companion](docs/APPLE.md)

GitHub stores source and configuration. Original photos, databases, credentials, local builds, and backups are excluded.
