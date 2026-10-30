# Aura Documentation

Aura owns the photo library, upload protocol, original storage, media processing, and Apple PhotoKit companion. ServerPortal owns device authentication, portal discovery, and resource inspection. Whole-server backup and recovery belong exclusively to server-operations agent tooling.

Read [Architecture](ARCHITECTURE.md) for data flow and duplicate semantics, [API](API.md) for integrations, [Apple](APPLE.md) for native import, [Client Releases](CLIENT-RELEASE.md) for installer publication, and [Operations](OPERATIONS.md) for server installation, recovery, and migration. [Validation](VALIDATION.md) records the initial contract checks and remaining device-specific verification.

The shared operational source is [server-operations](https://github.com/Crashmere/agent-config/tree/main/skills/server-operations). Remote entry points are `/opt/AGENTS.md`, `/opt/aura/AGENTS.md`, and `/opt/aura/docs/README.md`.
