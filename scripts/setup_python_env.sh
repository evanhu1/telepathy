#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

uv python install 3.10
uv venv --python 3.10 .venv
uv sync

echo "Python environment ready at $ROOT_DIR/.venv"
