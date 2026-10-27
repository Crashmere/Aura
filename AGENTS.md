# Aura Maintenance Entry Point

Aura is a personal photo library at `/aura/`, protected by ServerPortal device authentication. Read `docs/README.md`, then the architecture and operations documents relevant to the task. Use the server-operations skill and explicitly read remote `/opt/AGENTS.md` before deployment.

- Preserve uploaded bytes. Originals are immutable, SHA-256 addressed objects. Metadata, previews, and playback derivatives are separate.
- Exact byte or canonical pixel matches may be grouped automatically. Perceptual similarity only proposes review; it must never delete or merge originals automatically.
- A Live Photo is one library item containing its still image and paired motion resources. Use Apple content identifiers or explicit native resource grouping, never a global filename match.
- Keep upload and processing state durable. Acknowledged chunks must be flushed; final commits verify the complete server-side SHA-256.
- The Apple companion reads PhotoKit resources without recompressing. Browser uploads cannot promise background access to the iOS photo library.
- Build and deploy the server locally, following shared restricted release, portal declaration, icon, backup, and documentation synchronization contracts. GitHub hosts source, configuration, and client installation releases; keep credentials, runtime data, and backups outside GitHub.
- Apple client updates must also ship GitHub Release installers. Pushes to `main` affecting `apple/`, `scripts/client-release.py`, or the client workflow automatically build a universal Mac DMG and an unsigned iOS device IPA for AltStore/Sideloadly. Check workflow completion and remote asset hashes before reporting publication. `make client-release` retries or explicitly publishes client builds. Cloud builds contain no server deployment keys or user data; production server releases remain local.
- Validate the changed behavior with synthetic media and isolated data; production acceptance is read-only. Do not accumulate permanent tests by default.
- Default to English for maintenance documentation, Chinese for product UI. Avoid decorative slogans and unnecessary explanatory copy.
- Block ordinary Tab/Shift+Tab focus traversal and suppress focus-only decoration, preserving text input, composition, and modifier shortcuts.

Remote documentation: `/opt/aura/AGENTS.md`, `/opt/aura/docs/README.md`, and `/opt/server-context/`.
