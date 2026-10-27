# Apple Companion

The companion accesses the user's system Photos library through PhotoKit and sends original resources to Aura. It uses the existing Portal login page in its own WebKit view and copies only that app's authorized cookie into its URLSession cookie storage. It does not read Safari or another browser's cookies.

## Mac

Download the Apple silicon build from Aura → 上传 → Apple 照片库, or build it with `bash apple/build-mac.sh`. The output is `apple/build/Aura.app`; `web/public/downloads/Aura-for-Mac.zip` is packaged into the server build. macOS 14 or newer is required.

1. Open Aura and enter the server's HTTPS origin. The URL is supplied at runtime and never compiled into the public source.
2. Click 连接, complete Portal authorization, and return to the client. A new application WebKit container needs its own device authorization, just like a new browser.
3. Select a starting capture date and either an inclusive ending date or 持续上传此日期之后的照片.
4. Click 开始持续上传 and grant Photos access. Full access is required to discover every future asset; limited access imports only system-authorized assets.

The application checks the library every 60 seconds and also observes PhotoKit changes. Original resources may first need to download from iCloud. Mac activity prevents idle system sleep during an active pass; normal sleep suspends work, which resumes on wake. Pausing completes the current chunk and stops exporting more resources. The completion ledger survives restarts, and an authorized continuous job resumes when the app reopens.

The build is locally signed with an ad-hoc identity, not Developer ID notarized. A browser-downloaded copy can trigger macOS's standard unverified-developer prompt; use System Settings → Privacy & Security → Open Anyway for this personally built application, or build locally. Do not disable Gatekeeper globally. A locally installed copy built on the maintenance Mac does not acquire a browser quarantine attribute.

## iPhone and iPad

`apple/Aura.xcodeproj` targets iOS 17+. Open it in full Xcode, select your own signing team, connect the device, and run the Aura target. If the bundle ID needs changing for your team, change `CFBundleIdentifier` in Info.plist and the target identifier together. The background task identifiers are internal application identifiers and must stay consistent between the Swift source and Info.plist.

The source includes background URLSession chunk transfers, PhotoKit change observation, and a BGProcessingTask request. iOS decides when background work runs based on device/network/battery conditions; no app can promise an unconditional continuous background schedule. Keep the app foregrounded for a first large import. A force-quit prevents normal background continuation until the user reopens the app.

The initial delivery includes a compiled Mac app and iOS source/project. The maintenance computer has Command Line Tools but not full Xcode or an iOS signing identity; an iOS device build and real-device background behavior have not been verified. No signed IPA, TestFlight build, or App Store publication is implied.

## Resource and receipt semantics

Every PhotoKit resource is exported directly: original stills, original videos, paired videos, full-size edited variants, RAW alternatives, and adjustment data. Asset creation date, location, favorite state, and resource type are passed as hints. A stable client ID plus PhotoKit local asset identifier groups the resources; embedded Apple content IDs additionally link imports from different devices when available.

The local ledger is `~/Library/Application Support/Aura/receipts.jsonl` on macOS. Each record keys the server origin, asset ID, asset modification time, resource type, and original filename to a completed SHA-256. The server's immutable originals remain authoritative. After intentionally restoring an older server backup, pause the client and move its receipt file aside before reopening to recheck the whole selected range; server hashes prevent duplicate storage. Do not remove actual Photos-library files.

## Browser import

Browser file selection can import originals and exported HEIC/JPEG + MOV pairs; embedded content identifiers establish pairing. The iPhone system picker may convert a photo or omit its motion component. For complete Live Photos and ongoing date-based system-library import, use the native companion. Safari does not grant continuous Photos-library access to a website.

Chrome's persistent folder option monitors a user-selected directory while the page remains running. After a browser restart, reconnect the saved directory handle; ordinary files can simply be selected again to resume from server offsets. Browser uploads use original supplied bytes and never recompress them in JavaScript.
