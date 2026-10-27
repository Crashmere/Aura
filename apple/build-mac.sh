#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=${AURA_CLIENT_VERSION:-$(python3 -c 'import json; print(json.load(open("apple/version.json"))["version"])')}
build_number=${AURA_CLIENT_BUILD:-1}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $build_number =~ ^[0-9]+$ ]] || { echo 'Invalid client version or build number.' >&2; exit 64; }
bundle=apple/build/Aura.app
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources" apple/build/Aura.iconset
for architecture in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -parse-as-library -O -target "${architecture}-apple-macosx14.0" apple/AuraApp.swift -o "apple/build/Aura-$architecture" -framework SwiftUI -framework Photos -framework WebKit -framework CryptoKit
done
lipo -create apple/build/Aura-arm64 apple/build/Aura-x86_64 -output "$bundle/Contents/MacOS/Aura"
cp apple/Info.plist "$bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$bundle/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$bundle/Contents/Info.plist"
python3 - "$bundle/Contents/Info.plist" <<'PY'
import plistlib,sys
p=sys.argv[1]
with open(p,'rb') as f: data=plistlib.load(f)
for key in ['BGTaskSchedulerPermittedIdentifiers','UIBackgroundModes','UILaunchScreen']:
    data.pop(key,None)
with open(p,'wb') as f: plistlib.dump(data,f)
PY
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" apple/Assets.xcassets/AppIcon.appiconset/AppIcon.png --out "apple/build/Aura.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" apple/Assets.xcassets/AppIcon.appiconset/AppIcon.png --out "apple/build/Aura.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns apple/build/Aura.iconset -o "$bundle/Contents/Resources/Aura.icns"
codesign --force --deep --sign - "$bundle"
mkdir -p web/public/downloads
ditto -c -k --sequesterRsrc --keepParent "$bundle" web/public/downloads/Aura-for-Mac.zip
codesign --verify --deep --strict "$bundle"
