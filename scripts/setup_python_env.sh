#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

uv python install 3.10
uv venv --python 3.10 .venv
uv sync

if [[ "$(uname -s)" == "Darwin" ]]; then
  MACOS_VERSION="$(sw_vers -productVersion)"
  MACOS_MAJOR="${MACOS_VERSION%%.*}"
  if [[ "$MACOS_MAJOR" -ge 26 ]]; then
    echo "macOS ${MACOS_VERSION} detected. Upgrading torch stack from PyTorch nightly for Apple Silicon compatibility..."
    UV_CACHE_DIR="${ROOT_DIR}/.uv-cache" uv pip install \
      --python .venv/bin/python \
      --upgrade --pre \
      torch torchvision torchaudio \
      --index-url https://download.pytorch.org/whl/nightly/cpu
  fi
fi

echo "Verifying torch/MPS runtime..."
.venv/bin/python - <<'PY'
import platform
import torch

print("torch:", torch.__version__)
print("platform:", platform.platform())
print("mps built:", torch.backends.mps.is_built())
print("mps avail:", torch.backends.mps.is_available())
PY

echo "Python environment ready at $ROOT_DIR/.venv"
