#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bundle=apple/build/Aura.app
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources" apple/build/Aura.iconset
swiftc -swift-version 5 -parse-as-library -O -target arm64-apple-macosx14.0 apple/AuraApp.swift -o "$bundle/Contents/MacOS/Aura" -framework SwiftUI -framework Photos -framework WebKit -framework CryptoKit
cp apple/Info.plist "$bundle/Contents/Info.plist"
for size in 16 32 128 256 512; do
  vips thumbnail web/public/favicon.svg "apple/build/Aura.iconset/icon_${size}x${size}.png" "$size"
  double=$((size * 2))
  vips thumbnail web/public/favicon.svg "apple/build/Aura.iconset/icon_${size}x${size}@2x.png" "$double"
done
iconutil -c icns apple/build/Aura.iconset -o "$bundle/Contents/Resources/Aura.icns"
codesign --force --deep --sign - "$bundle"
mkdir -p web/public/downloads
ditto -c -k --sequesterRsrc --keepParent "$bundle" web/public/downloads/Aura-for-Mac.zip
codesign --verify --deep --strict "$bundle"
