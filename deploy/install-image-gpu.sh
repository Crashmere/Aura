#!/usr/bin/env bash
# Install Aura's pinned NVIDIA image runtime into its protected program tree.
set -euo pipefail
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime=${1:-/opt/aura/bin/image-gpu}
python=${AURA_SYSTEM_PYTHON:-/usr/bin/python3}
lock="$scripts/image-gpu-requirements.txt"
command -v uv >/dev/null || { echo 'Install the official uv CLI first.' >&2; exit 1; }
"$python" -c 'import sys; assert sys.platform == "linux" and sys.version_info[:2] == (3, 14), "This lock targets Linux CPython 3.14"'
if [[ -f "$runtime/requirements.txt" ]] && ! cmp -s "$lock" "$runtime/requirements.txt"; then
  echo 'Use a new runtime directory for a changed lock, then select it with AURA_IMAGE_PYTHON.' >&2
  exit 1
fi
if [[ ! -x "$runtime/bin/python" ]]; then
  uv venv --python "$python" "$runtime"
fi
uv pip sync --python "$runtime/bin/python" --require-hashes --only-binary :all: --link-mode copy "$lock"
"$runtime/bin/python" -B -c 'import cvcuda; from nvidia import nvimgcodec; print("CV-CUDA", cvcuda.__version__, "nvImageCodec", nvimgcodec.__version__)'
cp "$lock" "$runtime/requirements.txt"
echo "Installed GPU image runtime: $runtime/bin/python"
