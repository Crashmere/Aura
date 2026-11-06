# Operations

Aura's application target is `nas` at `/aura/`, with loopback listener `127.0.0.1:18087` and shared ServerPortal device authentication. `vps` supplies public HTTPS on port 8443; the temporary `ali` entrance forwards to the same NAS instance. NAS LAN access uses its local-CA HTTPS entrance. The runtime user is `aura`; restricted deployments use `aura-deploy`. Current activation is recorded in server-operations. GitHub repository: `Crashmere/Aura` (public), including public Apple-client installers. Keep addresses, credentials, originals, databases, and backups outside Git.

## Runtime and layout

| Path | Purpose |
| --- | --- |
| `/opt/aura/bin/aura` | Embedded-web Go program, including the generated Mac-client ZIP |
| `/opt/aura/bin/deploy-{ssh,release}.sh` | Root-maintained restricted release entry points |
| `/opt/aura/bin/dino/` | Pinned DINO source, weights, dependency manifest and isolated Python environment |
| `/opt/aura/config/` | systemd units, Nginx location, Portal declaration and source receipt |
| `/opt/aura/data/aura.sqlite` | Catalog, albums/memberships, uploads, media jobs, saved rotations and cover selections, deletion requests and hash/source guards |
| `/opt/aura/data/assets/` | Immutable SHA-256 originals until confirmed permanent deletion |
| `/opt/aura/data/derived/` | Rebuildable JPEG/MP4 previews, selected-frame covers, metadata-only rotation variants/source markers and versioned DINO vectors/candidates; included in NAS full cold backups |
| `/opt/aura/data/incoming/` | Durable acknowledged upload chunks; included in NAS full cold backups |
| `/opt/aura/data/work/` | Decoder work state; included in NAS full cold backups |
| `/opt/aura/backups/` | Native archive compatibility directory; no scheduled NAS snapshots |
| `/opt/aura/releases/` | Programs, hashes, release results and rollback records |
| `/opt/aura/docs/` | Synchronized maintenance documentation |

Go and Node are build dependencies on the maintenance computer only. Production uses official Ubuntu `libvips-tools`, `libheif-plugin-libde265`, `libimage-exiftool-perl`, and `ffmpeg`. Native libraries process files as the unprivileged application user. The service uses persistent disk for work files rather than `/tmp` capacity. TZ is `Asia/Shanghai`; update the unit for a different default interpretation of timezone-free capture dates.

Saved rotation uses the existing decision log without a schema migration. JPEG variants receive ExifTool orientation metadata; playback variants use FFmpeg's input `-display_rotation` option with stream copy, supported by the current `nas` FFmpeg 8 runtime. No GPU environment or media codec changes are required. Missing variants rebuild from their unedited derivatives and saved catalog direction; selected permanent deletion includes their files, source markers and interrupted rotation work. A rotation-unaware rollback preserves decisions but does not display them or remove these new variants during cleanup, so prefer a rotation-aware program when editing or purging the library.

Manual video covers and Live Photo key photos also use the existing decision log. Their JPEG derivatives are independent of canonical previews and rebuild from the selected original motion frame if missing. Saving, restoring, or reprocessing does not change original bytes, resource grouping, or source-derived similarity fingerprints. NAS full recovery packages retain the selections and stored derivatives; native archive restores retain the selections and regenerate derivatives on access. A cover-unaware rollback preserves the decisions but displays source previews and does not clean these variants during permanent deletion, so prefer a cover-aware program for library editing or purging. Frame extraction uses the existing NAS FFmpeg/GPU runtime, with no new installation or service.

### NVIDIA acceleration on NAS

NAS uses the RTX 3070 Laptop GPU with Ubuntu's signed NVIDIA 595 server open kernel module and matching compute/decode/encode libraries. The headless runtime requires `nvidia-headless-no-dkms-595-server-open`, `nvidia-utils-595-server`, `libnvidia-encode-595-server`, and signed `linux-modules-nvidia-595-server-open` packages matching the kernel; it requires no CUDA toolkit or build tools. Shared [NAS operations](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/nas-host.md) owns driver activation and kernel updates.

Aura uses an isolated Linux CPython 3.14 environment at `/opt/aura/bin/image-gpu`. Install the official `uv` CLI, then run `bash deploy/install-image-gpu.sh` from the trusted source deployment bundle. `deploy/image-gpu-requirements.txt` pins the NVIDIA nvImageCodec/nvJPEG, CV-CUDA, CUDA runtime and NumPy wheels with SHA-256 hashes. These are runtime libraries; no CUDA compiler, system-wide Python package installation, or additional network service is needed. Keep the environment root-owned and readable/executable by `aura`. Rebuild it from the pinned lock after recovery; model/runtime installations are outside the shared [data-protection scope](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/retention.md#data-protection-scope).

The Python worker pool is embedded in the Go program and receives private requests over standard input/output. Each child handles one image at a time, reuses GPU contexts and exits after 30 seconds idle. JPEGs use GPU/hybrid decoding; HEIC, PNG, RAW and color-managed inputs can use CPU decoding/color conversion before GPU resizing and JPEG encoding. Standard pixel hashing remains on libvips to preserve exact grouping semantics. Task steps identify the engine and CPU fallback reason. The 80-megapixel GPU working-set limit selects CPU processing for larger inputs without limiting accepted originals.

`AURA_IMAGE_PYTHON` selects a different interpreter when validating an isolated library or a replacement environment. The installer refuses an in-place change to an existing recorded dependency lock: create and validate a new environment, then update the application's configuration to select it. Reinstall from the pinned lock after recovery if the interpreter or OS differs; retain original files and the database independently of runtime compatibility. `AURA_GPU=cpu` disables both image and video acceleration. Restart only Aura after changing process configuration or activating a driver. Missing image dependencies or a failed GPU operation fall back to CPU, with diagnostics in the task and journal.

Video covers/playback probe CUDA scaling and NVENC on the first video job, with software-decoded GPU and full CPU fallbacks. Validate media operations with synthetic originals and isolated data under `aura`; production acceptance is read-only.

### Processing concurrency

The `nas` unit explicitly selects eight simultaneous original-processing jobs and four GPU image/video operations with `--workers 8 --gpu-slots 4`. A separate shared limit allows at most four ExifTool, libvips or CPU video operations, capped by the job count; capture-date extraction during upload uses the same CPU slots. The Ryzen 9 5900HX has 8 cores/16 threads, 64 GB installed RAM and an 8 GiB RTX 3070 Laptop GPU. Eight jobs overlap metadata, decoding, fingerprints and derivative generation; CPU and GPU slots bound native processing independently. A larger import adds durable queued rows rather than spawning more simultaneous processors. `Nice=5` keeps media processing below ordinary service priority. [Parallel validation](VALIDATION.md#parallel-processing-and-interruption) records the representative checks.

The unit sets `TasksMax=1024` for the complete service process tree. `VIPS_CONCURRENCY=2` limits libvips workers, but libheif and other codecs create additional pools: individual HEIC decoders have reached 15–28 threads. The former 128-task limit caused thread/fork failures and Go `newosproc` crashes during bulk imports. Native OpenMP, BLAS and ImageMagick helpers are limited to one thread. Serial RAW delegates also prevent the observed pixel variability in repeated RAF decoding; full-resolution pixel identity still uses standard libvips samples. FFmpeg uses two decoder/encoder threads and one filter thread; NVIDIA image workers and DINO retain their separate bounded CPU helpers. Keep the CPU processing bound and task budget together when evaluating another concurrency setting; libvips' worker setting does not represent total service threads.

`aura serve --workers N --gpu-slots M` overrides the limits before startup. Without overrides, the job count is one per four available CPU threads, bounded to 1–4; GPU operations default to at most two and never exceed the job count. `/api/info` reports effective `workers`, `gpuOperations` and `cpuOperations`, and startup logs record all three. Keep production overrides in `deploy/aura.service` and `/opt/aura/config/aura.service`, then reload systemd and restart only Aura. A configuration-only change uses the existing program and holds the shared maintenance lock followed by Aura's deployment lock; `current-commit` continues to identify the running program. Program releases do not install unit changes automatically. Use isolated HEIC/RAW and mixed-media batches and observe GPU memory, `TasksCurrent` and cgroup `pids.events` before increasing limits. The shared [native task-limit diagnosis](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/common-issues.md#native-media-processing-exhausts-a-service-task-limit) explains the kernel/systemd checks.

Jobs retain per-hash exclusion and durable progress. Catalog updates stay on the single SQLite connection; parallel exact matches and native Live Photo resources retain the existing grouping rules. Shutdown cancels and waits for all jobs before closing media workers and the database. Confirmed permanent deletion cancels and drains only its selected hashes, including jobs waiting for CPU or GPU slots; other jobs keep running. Interrupted jobs resume from the queue on restart. Metadata/header commands have a two-minute deadline, libvips commands and still-image GPU requests five minutes, and a complete media attempt thirty minutes. Video covers have a five-minute deadline; playback uses the attempt deadline. Cancellation stops a blocked Python request write as well as the response wait, and drains its callback before worker reuse. Native output-pipe cleanup is bounded after cancellation. Individual decoder failure becomes a failed resource for retry and releases its processing slot.

### DINO similarity runtime

`bash deploy/install-dino.sh` installs the pinned DINOv2 ViT-S/14 source and official weights into `/opt/aura/bin/dino`, with a Linux CPython 3.14 environment in `.venv`. `deploy/dino-requirements.txt` pins PyTorch/CUDA and preprocessing dependencies with distribution hashes. The installer verifies the pinned source archive and weight SHA-256, loads the model and executes a synthetic inference. It does not change the service or install global Python packages. Protection copies, temporary backup stages and new recovery packages exclude model weights/source, Python/CUDA environments, dependency caches and benchmark fixtures. The source installer and its hashes/lock provide reconstruction after recovery.

On the current nas instance, `.venv` reuses the retained, evaluated environment under `/opt/aura/bin/dino-eval-20261101/`. Both directories remain required until the environment is deliberately replaced; preserve the evaluation source/weights and dependency cache. `bash deploy/install-dino.sh /opt/aura/bin/dino /opt/aura/bin/dino-eval-20261101` validates dependency versions before reusing it. A new host can install a self-contained environment without the second argument. A changed dependency lock requires a new runtime directory. `AURA_DINO_RUNTIME` selects that directory; `AURA_DINO=off` pauses DINO only, while `AURA_GPU=cpu` also selects CPU DINO inference.

The model runs in one private child process under `aura`, outside upload and media processing. The SQLite `dino_tasks` queue persists pending work; `dino_dirty` records changed eligibility. Startup reconciles existing feature records once, and a five-minute scan recovers externally changed thumbnails. File/asset triggers and publication notifications wake the queue; idle operation does not scan the whole library every two seconds. Full batches run immediately; partial batches run ten seconds after first detection. Each batch occupies one existing GPU slot, with FP16 inference preferred and CPU fallback for CUDA failures. The child exits after 30 seconds idle. Runtime errors retry after one minute; per-image failures retry after five minutes. `/api/info.similarityIndex` and the `智能推荐` page show independent progress; DINO errors do not change accepted originals or media-job status.

Feature files in `data/derived/` contain the model/preprocessing version, thumbnail signature, vector and bounded neighbor list. NAS full packages include them. Legacy native snapshots retain originals/catalog and omit derivatives; after restore, thumbnails and DINO records rebuild independently. Confirmed permanent deletion cancels/drains the relevant batch and removes only selected feature files. Restoring/moving thumbnails changes their signature and queues recomputation. Startup adds rebuildable metadata/search/activity/deletion projections and the persistent DINO queue to the existing SQLite database. Existing business tables and rows remain compatible; schema version stays 1. Index initialization leaves existing business rows intact and has no destructive startup transformation. Model and original bytes remain in place.

## Initial installation

Use server-operations, explicitly read `/opt/AGENTS.md`, and check the whole inventory and live port allocation. This installation creates only the new application's identities, units, directories, and Nginx location. It inherits the shared authentication include and does not replace the shared Nginx server.

Build on the maintenance Mac, transfer the verified Linux binary, `deploy/`, and the existing deployment public key into a private staging directory, then run as administrator:

```sh
bash deploy/install.sh ./aura-linux-amd64 ./deploy-public-key.pub
```

The script requires an absent `/opt/aura`, unused application identity names, a free port, installed media tools, and ServerPortal. It explicitly initializes a new empty library, creates the restricted deployment account, starts the service, leaves the backup timer disabled by default, checks Nginx syntax, and adds the application location. It does not import an existing library; migration instead cold-copies verified complete state while the old application and clients are paused. Register the declaration through the normal release protocol afterward.

The only anonymous application resources are exact GET/HEAD requests for `favicon.svg` and `apple-touch-icon.png`. The PNG is an opaque 180×180 image generated by `scripts/icons.sh`. Mac downloads, JavaScript, pages, APIs, and media stay authenticated. No custom `add_header` overrides the shared cookie-renewal header.

## Release

Validate the affected behavior locally, commit and push `main`, then run:

```sh
make release
make deploy
```

The shared release tool exports the pushed commit, installs locked web dependencies, compiles the Mac client on the maintenance Mac, embeds frontend/client assets, and builds a static Linux amd64 program. Provenance and SHA-256 are retained under `.local/releases/<commit>/`. Deployment defaults to `nas` with its dedicated key; public acceptance checks `vps` HTTPS port 8443. See the [shared release guide](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/release.md) for overrides and the exact upgrade helper contract.

Temporary upgrade backups follow the shared [database-only policy](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/retention.md#temporary-upgrade-backups): skip them unless the change can delete or overwrite existing database data, and never include non-database files. The release helper records selected database paths and reasons; [database selection](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/retention.md#tool-alignment) owns capture and acceptance.

NAS releases hold shared maintenance and Aura deployment locks and stop Aura after upload/hash verification. Ordinary candidates run `check` on existing data as `aura`, then switch atomically and pass runtime health without temporary data copies or a second stop/start. A declared deletion/overwrite operation selects only affected SQLite databases under `/var/lib/server-upgrades/aura/<release>/`; originals, derivatives, upload chunks, jobs stored as files and configuration remain in place. The snapshot includes committed database BLOB/WAL content. Selected databases pass cold integrity/preservation checks and final runtime health before only the accepted protection is removed. Failure retains captured databases; program rollback does not restore data.

Use `make portal` for declaration-only changes. `make rollback COMMIT=<full-compatible-commit>` reuses a locally retained program through the same guarded flow. The core catalog schema remains version 1. Startup adds `albums` and `album_assets` plus the membership index without rewriting catalog rows or originals. Authorize schema changes separately and rehearse them against the independent candidate copy; `check` remains read-only.

Albums are included in the whole-database snapshot, with no new directory or backup format. Album-unaware programs can open/check and back up this additive schema, but their merge/split paths do not maintain album memberships. Prefer an album-aware rollback build; when reverting to an older program, pause library edits and imports until the album-aware program is restored.

Deletion requests, cleanup results, and minimal reimport guards use the existing decision log, without schema changes. Before a subsequent release, check `pendingDeletions` and drain or investigate pending cleanup. A confirmed request may remove files or rows during recovery, so the shared strict-preservation upgrade check can reject a release that overlaps unfinished deletion. Keep the retained upgrade protection and inspect the pending request instead of bypassing preservation checks. Rollback must use a deletion-aware program: older programs ignore deletion guards and can accept deliberately removed originals again. Program rollback does not restore removed bytes or undo a confirmed deletion.

Apple-client installation publication follows [Client Releases](CLIENT-RELEASE.md). Relevant client-source pushes build the Mac DMG and iOS IPA in GitHub Actions and publish the next version automatically. This workflow has no server access; `make deploy` continues to be a maintenance-computer operation.

`deploy/portal.json` is the source for resource browsing, original/derived distinctions, APIs, port, and units. Registration creates `/opt/serverportal/registry.d/aura.json` and verifies the loaded declaration hash. Synchronize managed documentation with `SYNC_HOST=nas .../sync-docs.sh shared Aura` from the pushed agent-config checkout.

## Backups and recovery

Use the agent-owned [backup and recovery runbook](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/backup-recovery.md), also at `/opt/server-context/references/backup-recovery.md` on NAS. Aura and Portal provide no web server-backup or production-restoration operation.

The shared agent workflow stages both hosts on NAS, creates one compressed package there, then copies/read-back verifies it on the known external disk. Aura coverage includes complete business data and recovery-critical private configuration: databases, originals, stored derivatives, acknowledged `incoming` chunks and persistent work/jobs. Use the read-only `server-recovery capture-plan` preflight to inspect selected source sizes; application `bin` and `staging` are excluded before scanning and copying. Active writers resume before compression; only successful temporary staging is removed after external verification. No insertion-triggered job, native daily backup, rotation or historic-backup deletion runs.

The native commands below remain for reading old packages and isolated recovery. Their narrower format contains a consistent SQLite image, immutable originals, and a SHA-256 manifest, but omits derivatives and incomplete uploads. They are not the NAS full-backup implementation. The legacy daily timer is disabled on NAS; existing ALI/cloud recovery materials remain untouched.

```sh
aura backup --data /path/to/data --out /path/to/new-snapshot
aura verify-backup --source /path/to/snapshot --full
aura restore --source /path/to/snapshot --out /path/to/new-data
aura check --data /path/to/new-data
```

Backup and restore destinations must not already exist. A `.part-<id>` staging directory becomes the final snapshot only when complete. Full verification checks SQLite integrity, database/manifest agreement, byte counts, and every original hash. Restore always targets a new directory; it never overwrites the live library. Derived previews regenerate on access/retry, and incomplete uploads must be resumed from the client's original files.

The native manifest follows the legacy media-backup contract (`version:1`, `files:{relative-path:sha256}`). NAS agent full packages cover declared business data and stored media-derived files plus recovery-critical private configuration. Model weights/source, runtime environments and dependency caches are reconstructed from pinned source rather than included in new copies. Upgrade snapshots live in the private shared directory and are removed immediately only after data/runtime acceptance; failed or uncertain snapshots have no automatic pruning.

Full cold copies also retain pending deletion intents and completed hash/source guards in SQLite. Partial cleanup can temporarily leave catalog rows whose original files have already been removed. Wait for `pendingDeletions == 0` before native snapshot or original-integrity acceptance; on an isolated restored copy, finish pending cleanup before those checks. New packages contain the live originals remaining at capture, while older packages may still contain subsequently deleted originals. Restoring an older recovery point can restore older deletion history as well as bytes; inspect these records before enabling upload clients. Never remove guards merely to make a retry succeed. Choosing a recovery point, replacing production data, or deliberately allowing a removed original again follows the shared authorization table. Deletion in Aura does not modify existing backups or the system Photos library.

Alibaba Cloud Backup belongs to `ali`, not NAS or VPS. Historical cloud/native backups are preserved until an explicitly scoped cleanup; disabling future ALI jobs follows the shared migration contract.

For migration, pause clients and the ALI application, transfer complete cold state preserving bytes into a new NAS directory, install media runtimes, and start a matching program behind authenticated gateways. Verify complete catalog/archive rows, Live Photo resources, original/derived checksums, persistent upload state, and authenticated downloads. Both gateways must reach the same NAS data. After restoring older NAS state, the agent compares server originals and deletion guards with the retained Origin-keyed Apple client receipts before resuming import. Preserve unresolved and recently deleted receipts; select repairs only for confirmed missing visible originals. Changing Origin requires its own Portal login and has a separate receipt namespace; see [Apple](APPLE.md). Real-data replacement and recovery-point selection follow the established authorization workflow.

## Diagnostics

For slow original transfers, follow [Upload throughput and request limits](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/conventions.md#upload-throughput-and-request-limits), also at `/opt/server-context/references/conventions.md` on NAS. It owns the shared HTTP/2 receive-window setting and comparison procedure. Aura's chunk limits, body deadlines and durable acknowledgment remain governed by its upload protocol below and [API](API.md#upload-protocol).

```sh
systemctl status aura
journalctl -u aura --since today
curl --fail http://127.0.0.1:18087/healthz
```

The web task center uses `GET /api/jobs?paged=true` for active work and the last 24 hours of completed/failed attempts, with 50-item current-page refresh, expandable durable steps, status counts, and errors, and `GET /api/uploads?paged=true` for acknowledged but incomplete uploads. It separates accepted originals from preview readiness and can batch-retry failed processing with `POST /api/files/retry`. Check installed decoders and the journal before retrying. RAW files without a supported full decoder can use their embedded JPEG preview. A missing derivative is disposable; a missing original is a recovery problem and must not be hidden by creating a new empty catalog.

Upload preparation/status verifies original presence and expected size before acknowledging a duplicate. A missing cataloged object can be repaired through the same full-SHA-256 upload protocol; repair preserves its catalog identity, source observations, and recently deleted visibility. An existing non-regular or wrong-size object returns `original_integrity_error` and is never overwritten. Inspect and preserve the object before selecting an authorized recovery action. This lightweight availability check does not detect same-size byte corruption; use full backup verification for integrity. Per-hash serialization isolates unrelated transfers. The server accepts chunks up to 128 MiB with a 600-second body-read deadline; clients allow 660 seconds and recover interrupted transfers from the last flushed offset. Aura's Nginx location permits 129 MiB request bodies on NAS and both public gateways.

Permanent deletion is a user-confirmed live-library operation restricted to selected trash items. `POST /api/assets/purge` first records an exact durable request; the worker resumes pending requests after interruption, cancels/drains their media work, flushes file removals, and records completion after catalog cleanup. `GET /api/deletions/{requestId}` distinguishes pending cleanup and its error from completion. A storage error does not restore the selection or falsely report that space was freed; repair the storage condition and let the existing worker retry. Pending items expose `deletionPending:true` and cannot be restored or regrouped while cleanup proceeds. Do not test this endpoint against real NAS photos during acceptance.

An intentionally removed hash returns 410 `original_deleted`, not `original_missing`. Source-scoped guards cover future native variants only when no retained split member or upload still uses that source. Updated clients preserve these intentional exclusions and do not retry them as network failures. Removing live filenames is not secure erasure: existing backups, browser caches, or in-progress downloads may retain bytes, and `bytes` in the cleanup response is a planned catalog amount rather than measured filesystem space released.

Use the shared `view-tunnel.sh` for read-only production browser checks. Run shared icon, authentication-boundary, and cookie-renewal checks when changing proxy rules. Test uploads, merges, and recovery only in isolated libraries; production acceptance does not add synthetic photos.
