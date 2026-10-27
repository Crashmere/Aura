# Client Installation Releases

The user authorized public Mac and iOS installation assets and automatic publication of subsequent client updates on 2026-10-27. Server deployment remains the local restricted SSH workflow; the Apple client workflow has no server access or deployment credentials.

## Publication contract

`.github/workflows/client-release.yml` runs on `main` when `apple/`, `scripts/client-release.py`, or the workflow changes. It can also be run manually with `make client-release`. It uses GitHub's standard `macos-15` environment, full Xcode, and a repository-scoped GitHub token with content-write permission. It installs no third-party packaging tools and requires no Apple certificates, provisioning profiles, or Apple ID secrets.

The release always includes:

| Asset | Use |
| --- | --- |
| `Aura-macOS.dmg` | Drag Aura into Applications; universal arm64/x86_64, macOS 14+ |
| `Aura-iOS.ipa` | iPhone/iPad device arm64; self-sign with AltStore/Sideloadly, iOS 17+ |
| `SHA256SUMS` | SHA-256 of both installers and the build manifest |
| `build-manifest.json` | Source commit, app version/build, architectures, platform, signing mode, toolchain and package digests |

Stable download URLs use `/releases/latest/download/<asset-name>`; each older release retains its own assets. The Mac app has an ad-hoc signature and is not notarized. The iOS package contains no provisioning profile and cannot install directly through Safari. User signing is part of the iOS installation process.

## Versioning and retries

`apple/version.json` defines the minimum desired semantic version. The preparer selects it when no newer/equal release exists; otherwise it increments the highest existing patch version. A release already assigned to the same immutable source commit reuses its version. Set a higher minimum version for a deliberate minor/major version change. `GITHUB_RUN_NUMBER` becomes the native build number. Both packages use the same app version and build.

```sh
make client-release
gh run list --repo Crashmere/Aura --workflow client-release.yml
gh run watch <run-id> --repo Crashmere/Aura --exit-status
```

The source checkout is the triggering commit. The workflow first creates a draft release targeted at that exact commit, uploads packages, checks remote sizes/digests, and publishes only after validation. A failed build creates no public installer release. Failed publication can be rerun; a draft can have its incomplete assets replaced. A retry of an already published commit downloads and verifies the existing assets, skipping rebuilds so native build numbers and DMG timestamps cannot change a published package. Build artifacts and diagnostics are retained for seven days in Actions; published installers remain in Releases.

## Validation

The packager compiles both Mac architectures, checks the universal binary and code signature, verifies and mounts the DMG read-only, and checks the Applications shortcut. The IPA validator checks ZIP integrity, bundle/version/privacy/background declarations, compiled icon assets, and the Mach-O iOS device platform. A simulator executable cannot pass the IPA check. The remote release must contain exactly the four declared assets with matching sizes and SHA-256.

These checks establish package integrity and device-target compilation. They do not establish actual iPhone Photos authorization or background scheduling; real-device acceptance remains separate. Ordinary client UI changes need their affected interaction checked before publication, following the project testing policy.
