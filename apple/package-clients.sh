#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 2 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! $2 =~ ^[0-9]+$ ]]; then
  echo 'Usage: package-clients.sh <version> <build-number>' >&2
  exit 64
fi
export AURA_CLIENT_VERSION=$1 AURA_CLIENT_BUILD=$2
output=.local/client-release
mkdir -p "$output" apple/build/dmg
if [[ -e "$output/Aura-macOS.dmg" || -e "$output/Aura-iOS.ipa" ]]; then
  echo 'The client package output already exists; use a fresh checkout.' >&2
  exit 1
fi
bash apple/build-mac.sh
ditto apple/build/Aura.app apple/build/dmg/Aura.app
ln -s /Applications apple/build/dmg/Applications
cat > apple/build/dmg/安装说明.txt <<'EOF'
将 Aura 拖入“Applications”即可安装。macOS 14 或更新版本，支持 Apple 芯片和 Intel。

首次运行时输入你的服务器 HTTPS 地址，在客户端内完成门户设备授权，并允许访问照片。

此个人应用没有 Apple 公证。如果 macOS 阻止打开，请在“系统设置 → 隐私与安全性”中选择“仍要打开”。
EOF
hdiutil create -volname "Aura $AURA_CLIENT_VERSION" -srcfolder apple/build/dmg -format UDZO "$output/Aura-macOS.dmg"
hdiutil verify "$output/Aura-macOS.dmg"

xcodebuild -project apple/Aura.xcodeproj -scheme Aura -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath apple/build/ios \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  MARKETING_VERSION="$AURA_CLIENT_VERSION" CURRENT_PROJECT_VERSION="$AURA_CLIENT_BUILD" \
  build > "$output/ios-build.log" 2>&1 || { tail -n 100 "$output/ios-build.log" >&2; exit 1; }
app=apple/build/ios/Build/Products/Release-iphoneos/Aura.app
[[ -x $app/Aura && -f $app/Info.plist ]] || { echo 'iOS device build was not produced.' >&2; exit 1; }
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $AURA_CLIENT_VERSION" "$app/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $AURA_CLIENT_BUILD" "$app/Info.plist"
mkdir -p apple/build/ipa/Payload
ditto "$app" apple/build/ipa/Payload/Aura.app
(
  cd apple/build/ipa
  zip -q -r ../../../"$output"/Aura-iOS.ipa Payload
)
python3 scripts/client-release.py verify --directory "$output" --version "$AURA_CLIENT_VERSION" --build "$AURA_CLIENT_BUILD"
