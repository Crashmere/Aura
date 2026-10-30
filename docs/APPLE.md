# Apple Companion

The companion accesses the user's system Photos library through PhotoKit and sends original resources to Aura. It uses the existing Portal login page in its own WebKit view and copies only that app's authorized cookie into its URLSession cookie storage. It does not read Safari or another browser's cookies.

## Mac

Download `Aura-macOS.dmg` from [GitHub Releases](https://github.com/Crashmere/Aura/releases/latest) or Aura → 上传 → Apple 照片库. Open the DMG and drag Aura into Applications. The package supports Apple silicon and Intel; macOS 14 or newer is required. Local builds use `bash apple/build-mac.sh`; the output is `apple/build/Aura.app`, with a compatibility ZIP embedded in local server builds.

1. Open Aura and enter the server's HTTPS origin. The URL is supplied at runtime and never compiled into the public source.
2. Click 连接, complete Portal authorization, and return to the client. A new application WebKit container needs its own device authorization, just like a new browser.
3. Select a starting capture date and either an inclusive ending date or 持续上传此日期之后的照片.
4. Click 开始持续上传 and grant Photos access. Full access is required to discover every future asset; limited access imports only system-authorized assets.

The first pass discovers the selected range. PhotoKit changes then queue only inserted or changed assets; the 60-second timer retries pending assets and refreshes at most 32 processing originals per pass. Relaunching, starting a selected range, or a non-incremental PhotoKit change triggers full discovery again without re-exporting receipted resources. Original resources may first need to download from iCloud. Mac activity prevents idle system sleep during an active pass; normal sleep suspends work, which resumes on wake. Pausing cancels an active PhotoKit export and finishes an in-flight upload chunk before stopping. An authorized continuous job resumes when the app reopens.

`仅使用 Wi-Fi 或有线网络` is enabled by default. The client waits when the available network is cellular or disconnected, checks policy before exporting or transferring another chunk, and disables cellular access on its upload requests. `登录时启动 Aura` is an optional macOS login item managed through `SMAppService`; the client changes it only when the user toggles it and shows any required system approval. The installed app must remain available at its registered location.

The build is locally signed with an ad-hoc identity, not Developer ID notarized. A browser-downloaded copy can trigger macOS's standard unverified-developer prompt; use System Settings → Privacy & Security → Open Anyway for this personally built application, or build locally. Do not disable Gatekeeper globally. A locally installed copy built on the maintenance Mac does not acquire a browser quarantine attribute.

## iPhone and iPad

Download `Aura-iOS.ipa` from [GitHub Releases](https://github.com/Crashmere/Aura/releases/latest). This is an iOS 17+ device build intended for signing with your own Apple ID through [AltStore](https://altstore.io/) or [Sideloadly](https://sideloadly.io/). Import the IPA in the tool, follow its device pairing and signing prompts, and open the installed Aura app. A normal Safari download alone cannot install an unsigned IPA. Free Apple ID signatures generally expire after seven days; refresh according to the signing tool. Developer Mode or trust approval may be required by the device. No Apple ID, certificate, or device identifier is stored in the public release.

To build directly in Xcode, open `apple/Aura.xcodeproj`, select your own signing team, connect the device, and run the Aura target. If the bundle ID needs changing for your team, change `CFBundleIdentifier` in Info.plist and the target identifier together. Background task identifiers must remain consistent between Swift and Info.plist.

The source includes background URLSession chunk transfers, PhotoKit change observation, and a BGProcessingTask request. The background wake-up awaits the same scan task as the foreground client, and expiration cancels that task instead of starting a competing upload pass. Wi-Fi/non-cellular upload policy defaults to enabled. `仅在充电时上传` defaults to disabled; enabling it pauses new exports/chunks when the device stops charging and requires external power for the next background request. PhotoKit controls its own iCloud retrieval; the client gates resource requests and cancels active exports when policy stops allowing them.

iOS decides when background work runs based on device/network/battery conditions; no app can promise an unconditional continuous background schedule. Keep the app foregrounded for a first large import. A force-quit prevents normal background continuation until the user reopens the app.

GitHub Releases provide the universal Mac DMG and an unsigned, compiled iOS device IPA. The hosted build uses full Xcode; the maintenance Mac needs only Command Line Tools for its server/Mac workflow. Real-device installation, Photos authorization, and actual iOS background behavior still require user-device acceptance. TestFlight and App Store distribution are not configured.

## Resource and receipt semantics

Every PhotoKit resource is exported directly: original stills, original videos, paired videos, full-size edited variants, RAW alternatives, and adjustment data. Asset creation date, location, favorite state, and resource type are passed as hints. A stable client ID plus PhotoKit local asset identifier groups the resources; embedded Apple content IDs additionally link imports from different devices when available.

The local journal is `~/Library/Application Support/Aura/receipts.jsonl` on macOS, or the app's Application Support/Aura directory on iOS. Each record keys the server origin, asset ID, asset modification time, resource type, and original filename to a completed SHA-256. New records also retain the current server asset ID, processing status, trash state, and presence-check time. Existing `{key,hash}` records remain compatible. Journal appends are flushed before completion is recorded, and successful passes compact the journal atomically.

`client-state.json` in the same directory retains the connected origin's summary counts, last scan/check times, unresolved issues, and album-import state. Issues distinguish PhotoKit/iCloud export, original transfer, server processing, presence verification, album import, and settings. A successful retry clears the corresponding issue; pausing or relaunching does not erase it. Upload completion and preview readiness are separate counts. These receipts describe originals accepted by Aura, not an independent external backup.

After an authorized restoration of older NAS state, use `重新核对服务器` before resuming ordinary import. The client requires `capabilities.originalPresence`, checks each distinct receipted hash at the configured origin, and records confirmed present, missing, recently deleted, and unresolved results separately. A confirmed missing or incomplete original outside recently deleted invalidates only its affected receipts and queues its PhotoKit asset for repair. Starting or resuming continuous upload then exports available resources under the selected date/network/power policy. The server verifies the complete upload SHA-256 and retains existing item identity and visibility when the catalog record still exists.

Authentication, network, integrity, and unknown-response failures retain receipts and remain visible for review. Receipts for recently deleted items are retained even when an older catalog no longer recognizes them, preventing automatic resurrection; missing trash originals are reported without automatic repair or restore. Presence verification checks a regular file and its expected size, not a full-byte integrity scan. Full backup verification and production recovery remain the agent-operated workflow in [Operations](OPERATIONS.md). The client never deletes resources from the system Photos library.

## Album import

`导入 Apple 自建相册` is disabled by default and requires server capabilities for original presence and album import. When enabled, the client imports regular user-created PhotoKit albums containing uploaded, visible items within the selected range. It resolves current Aura asset IDs through upload status, which also handles resources grouped since their original upload. Membership requests are bounded to 1000 items, and unchanged source signatures skip redundant requests.

Import is additive: it preserves names edited in Aura, does not remove memberships, and never propagates a Photos asset or album deletion. An album explicitly deleted in Aura is not recreated by later imports; the client records that source as blocked and shows the server's deletion decision. `更新相册关系` refreshes eligible relationships without overriding blocked deletions. Source mapping uses the stable client-library ID and PhotoKit collection ID, so different clients can import separate album mappings.

## Browser import

Browser file selection can import originals and exported HEIC/JPEG + MOV pairs; embedded content identifiers establish pairing. The iPhone system picker may convert a photo or omit its motion component. For complete Live Photos and ongoing date-based system-library import, use the native companion. Safari does not grant continuous Photos-library access to a website.

Chrome's persistent folder option monitors a user-selected directory while the page remains running. After a browser restart, reconnect the saved directory handle; ordinary files can simply be selected again to resume from server offsets. Browser uploads use original supplied bytes and never recompress them in JavaScript.
