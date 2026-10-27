#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
vips copy web/public/favicon.svg web/public/apple-touch-icon.png
vips thumbnail web/public/favicon.svg apple/Assets.xcassets/AppIcon.appiconset/AppIcon.png 1024
