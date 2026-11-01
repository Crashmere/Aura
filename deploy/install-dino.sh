#!/usr/bin/env bash
# Provision the versioned DINO runtime without changing the application service.
set -euo pipefail
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime=${1:-/opt/aura/bin/dino}
reuse=${2:-}
python=${AURA_SYSTEM_PYTHON:-/usr/bin/python3}
lock="$scripts/dino-requirements.txt"
revision=7764ea0f912e53c92e82eb78a2a1631e92725fc8
source_hash=c27dcdaf50e9fb5bbdf2bb529da357716372e19c6afab17d5350f3f0094aed4b
weight_hash=b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9
command -v uv >/dev/null || { echo 'Install the official uv CLI first.' >&2; exit 1; }
"$python" -c 'import sys; assert sys.platform == "linux" and sys.version_info[:2] == (3,14), "This runtime targets Linux CPython 3.14"'
if [[ -f "$runtime/requirements.txt" ]] && ! cmp -s "$lock" "$runtime/requirements.txt"; then
  echo 'Use a new runtime directory for a changed lock; select it with AURA_DINO_RUNTIME.' >&2
  exit 1
fi
mkdir -p "$runtime"
if [[ ! -x "$runtime/.venv/bin/python" ]]; then
  if [[ -n "$reuse" ]]; then
    [[ -x "$reuse/.venv/bin/python" ]] || { echo 'Reusable environment not found.' >&2; exit 1; }
    # Reuse the evaluated environment only when every locked package is present.
    "$reuse/.venv/bin/python" - "$lock" <<'PY'
import importlib.metadata, re, sys
for line in open(sys.argv[1]):
    match = re.match(r"([a-zA-Z0-9-]+)==([^\s\\]+)", line)
    if match:
        name, version = match.groups()
        actual = importlib.metadata.version(name)
        assert actual == version, f"{name}: expected {version}, got {actual}"
print("Evaluated runtime dependencies match the lock")
PY
    ln -s "$reuse/.venv" "$runtime/.venv"
  else
    uv venv --python "$python" "$runtime/.venv"
  fi
fi
if [[ -z "$reuse" ]]; then
  uv pip sync --python "$runtime/.venv/bin/python" --require-hashes --only-binary :all: --link-mode copy "$lock"
fi
if [[ ! -d "$runtime/dinov2-main" ]]; then
  archive="$runtime/dinov2-source.tar.gz"
  if [[ -n ${AURA_DINO_SOURCE_ARCHIVE:-} ]]; then
    cp "$AURA_DINO_SOURCE_ARCHIVE" "$archive"
  else
    curl -fLsS --connect-timeout 20 --max-time 300 "https://github.com/facebookresearch/dinov2/archive/$revision.tar.gz" -o "$archive"
  fi
  printf '%s  %s\n' "$source_hash" "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$runtime"
  mv "$runtime/dinov2-$revision" "$runtime/dinov2-main"
fi
weights="$runtime/dinov2_vits14_pretrain.pth"
if [[ ! -f "$weights" ]]; then
  if [[ -n "$reuse" && -f "$reuse/dinov2_vits14_pretrain.pth" ]]; then
    cp "$reuse/dinov2_vits14_pretrain.pth" "$weights"
  else
    curl -fLsS --connect-timeout 20 --max-time 600 https://dl.fbaipublicfiles.com/dinov2/dinov2_vits14/dinov2_vits14_pretrain.pth -o "$weights"
  fi
fi
printf '%s  %s\n' "$weight_hash" "$weights" | sha256sum -c -
"$runtime/.venv/bin/python" -B - "$runtime" <<'PY'
import pathlib, sys, torch
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / "dinov2-main"))
from dinov2.hub.backbones import dinov2_vits14
torch.set_num_threads(4)
model = dinov2_vits14(pretrained=False).eval()
model.load_state_dict(torch.load(root / "dinov2_vits14_pretrain.pth", map_location="cpu", weights_only=True))
device = "cuda" if torch.cuda.is_available() else "cpu"
with torch.inference_mode():
    output = model.to(device)(torch.zeros(1, 3, 224, 224, device=device))
assert tuple(output.shape) == (1,384)
print("DINOv2 ViT-S/14", device, torch.__version__)
PY
cp "$lock" "$runtime/requirements.txt"
printf 'source_commit=%s\nsource_sha256=%s\nweights_sha256=%s\n' "$revision" "$source_hash" "$weight_hash" > "$runtime/SOURCE"
echo "DINO runtime ready: $runtime"
