# Apple Companion

The companion accesses the user's system Photos library through PhotoKit and sends original resources to Aura. It uses the existing Portal login page in its own WebKit view and copies only that app's authorized cookie into its URLSession cookie storage. It does not read Safari or another browser's cookies.

## Mac

Download `Aura-macOS.dmg` from [GitHub Releases](https://github.com/Crashmere/Aura/releases/latest) or Aura → 上传 → Apple 照片库. Open the DMG and drag Aura into Applications. The package supports Apple silicon and Intel; macOS 14 or newer is required. Local builds use `bash apple/build-mac.sh`; the output is `apple/build/Aura.app`, with a compatibility ZIP embedded in local server builds.

1. Open Aura and enter the server's HTTPS origin. The URL is supplied at runtime and never compiled into the public source.
2. Click 连接, complete Portal authorization, and return to the client. A new application WebKit container needs its own device authorization, just like a new browser.
3. Select a starting capture date and either an inclusive ending date or 持续上传此日期之后的照片.
4. Click 开始持续上传 and grant Photos access. Full access is required to discover every future asset; limited access imports only system-authorized assets.

The application checks the library every 60 seconds and also observes PhotoKit changes. Original resources may first need to download from iCloud. Mac activity prevents idle system sleep during an active pass; normal sleep suspends work, which resumes on wake. Pausing completes the current chunk and stops exporting more resources. The completion ledger survives restarts, and an authorized continuous job resumes when the app reopens.

The build is locally signed with an ad-hoc identity, not Developer ID notarized. A browser-downloaded copy can trigger macOS's standard unverified-developer prompt; use System Settings → Privacy & Security → Open Anyway for this personally built application, or build locally. Do not disable Gatekeeper globally. A locally installed copy built on the maintenance Mac does not acquire a browser quarantine attribute.

## iPhone and iPad

Download `Aura-iOS.ipa` from [GitHub Releases](https://github.com/Crashmere/Aura/releases/latest). This is an iOS 17+ device build intended for signing with your own Apple ID through [AltStore](https://altstore.io/) or [Sideloadly](https://sideloadly.io/). Import the IPA in the tool, follow its device pairing and signing prompts, and open the installed Aura app. A normal Safari download alone cannot install an unsigned IPA. Free Apple ID signatures generally expire after seven days; refresh according to the signing tool. Developer Mode or trust approval may be required by the device. No Apple ID, certificate, or device identifier is stored in the public release.

To build directly in Xcode, open `apple/Aura.xcodeproj`, select your own signing team, connect the device, and run the Aura target. If the bundle ID needs changing for your team, change `CFBundleIdentifier` in Info.plist and the target identifier together. Background task identifiers must remain consistent between Swift and Info.plist.

The source includes background URLSession chunk transfers, PhotoKit change observation, and a BGProcessingTask request. iOS decides when background work runs based on device/network/battery conditions; no app can promise an unconditional continuous background schedule. Keep the app foregrounded for a first large import. A force-quit prevents normal background continuation until the user reopens the app.

GitHub Releases provide the universal Mac DMG and an unsigned, compiled iOS device IPA. The hosted build uses full Xcode; the maintenance Mac needs only Command Line Tools for its server/Mac workflow. Real-device installation, Photos authorization, and actual iOS background behavior still require user-device acceptance. TestFlight and App Store distribution are not configured.

## Resource and receipt semantics

Every PhotoKit resource is exported directly: original stills, original videos, paired videos, full-size edited variants, RAW alternatives, and adjustment data. Asset creation date, location, favorite state, and resource type are passed as hints. A stable client ID plus PhotoKit local asset identifier groups the resources; embedded Apple content IDs additionally link imports from different devices when available.

The local ledger is `~/Library/Application Support/Aura/receipts.jsonl` on macOS. Each record keys the server origin, asset ID, asset modification time, resource type, and original filename to a completed SHA-256. The server's immutable originals remain authoritative. After intentionally restoring an older server backup, pause the client and move its receipt file aside before reopening to recheck the whole selected range; server hashes prevent duplicate storage. Do not remove actual Photos-library files.

## Browser import

Browser file selection can import originals and exported HEIC/JPEG + MOV pairs; embedded content identifiers establish pairing. The iPhone system picker may convert a photo or omit its motion component. For complete Live Photos and ongoing date-based system-library import, use the native companion. Safari does not grant continuous Photos-library access to a website.

Chrome's persistent folder option monitors a user-selected directory while the page remains running. After a browser restart, reconnect the saved directory handle; ordinary files can simply be selected again to resume from server offsets. Browser uploads use original supplied bytes and never recompress them in JavaScript.
