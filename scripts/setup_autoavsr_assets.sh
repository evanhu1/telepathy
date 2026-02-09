#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PY="$ROOT_DIR/.venv/bin/python"
MODEL_REPO="$ROOT_DIR/third_party/Visual_Speech_Recognition_for_Multiple_Languages"

if [[ ! -x "$VENV_PY" ]]; then
  echo "Missing $VENV_PY. Run ./scripts/setup_python_env.sh first."
  exit 1
fi

mkdir -p "$ROOT_DIR/third_party"

if [[ ! -d "$MODEL_REPO/.git" ]]; then
  git clone --depth=1 \
    https://github.com/mpc001/Visual_Speech_Recognition_for_Multiple_Languages.git \
    "$MODEL_REPO"
fi

cd "$MODEL_REPO"

if [[ ! -f "benchmarks/LRS3/models/LRS3_V_WER19.1/model.pth" ]]; then
  "$VENV_PY" -m gdown --fuzzy \
    "https://drive.google.com/file/d/1t8RHhzDTTvOQkLQhmK1LZGnXRRXOXGi6/view?usp=share_link" \
    -O LRS3_V_WER19.1.bin
  unzip -o LRS3_V_WER19.1.bin -d benchmarks/LRS3/models
fi

if [[ ! -f "benchmarks/LRS3/language_models/lm_en_subword/model.pth" ]]; then
  "$VENV_PY" -m gdown --fuzzy \
    "https://drive.google.com/file/d/1g31HGxJnnOwYl17b70ObFQZ1TSnPvRQv/view?usp=share_link" \
    -O lm_en_subword.zip
  unzip -o lm_en_subword.zip -d benchmarks/LRS3/language_models
fi

echo "AutoAVSR assets are ready in $MODEL_REPO"
