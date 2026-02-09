#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Telepathy.app"
APP_PATH="$ROOT_DIR/src-tauri/target/debug/bundle/macos/$APP_NAME"

cd "$ROOT_DIR"

npm run tauri build -- --debug

if [[ ! -d "$APP_PATH" ]]; then
  echo "Expected app bundle not found at: $APP_PATH" >&2
  exit 1
fi

open "$APP_PATH"
