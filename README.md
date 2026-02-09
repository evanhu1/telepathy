# Telepathy (visual speech prototype)

A Tauri desktop app for macOS that works as a hold-to-record hotkey overlay: while the hotkey is held, webcam video is captured; on release, the clip is sent to a local Python server for visual speech (lipreading) inference and pasted as text.

## Quick start

1. Install JS dependencies:

   ```bash
   npm install
   ```

2. Create the single Python environment (uv-managed):

```bash
./scripts/setup_python_env.sh
```

On macOS 26+, this script upgrades `torch`/`torchvision`/`torchaudio` from the
PyTorch nightly index and then prints MPS availability, to handle newer macOS
runtime compatibility before stable wheels catch up.

3. Download/prepare AutoAVSR assets (repo + checkpoints):

   ```bash
   ./scripts/setup_autoavsr_assets.sh
   ```

4. Run the Python server:

   ```bash
   .venv/bin/uvicorn server.main:app --reload
   ```

5. Run the app bundle in debug mode (recommended for macOS permissions onboarding):

   ```bash
   npm run tauri:dev-app
   ```

   This builds `src-tauri/target/debug/bundle/macos/Telepathy.app` and opens it.

   If you want pure hot-reload webview iteration, you can still run:

   ```bash
   npm run tauri dev
   ```

On startup, Telepathy opens a small onboarding UI to verify macOS permissions:

- Camera (required to capture video)
- Accessibility (required to auto-paste text via Cmd+V)

After onboarding, use the global hotkey:

- `CommandOrControl+Shift+Space` (press and hold to record, release to transcribe and paste).

A small overlay pill appears while recording/processing and auto-hides after completion.

## Model backend (AutoAVSR)

The backend now supports an AutoAVSR transcriber adapter in `server/model.py`.
It expects a local checkout of:

- `https://github.com/mpc001/Visual_Speech_Recognition_for_Multiple_Languages`

`server/model.py` auto-detects:
- `third_party/Visual_Speech_Recognition_for_Multiple_Languages`

No extra environment variables are required for the default local setup.

Optional overrides:

```bash
export TELEPATHY_MODEL_BACKEND=autoavsr
export TELEPATHY_AUTOAVSR_REPO=/absolute/path/to/Visual_Speech_Recognition_for_Multiple_Languages
# Optional (defaults shown):
# export TELEPATHY_AUTOAVSR_CONFIG=configs/LRS3_V_WER19.1.ini
# export TELEPATHY_AUTOAVSR_DETECTOR=mediapipe
# export TELEPATHY_AUTOAVSR_DEVICE=mps    # default: mps; options: auto|mps|cpu|cuda:0
# export TELEPATHY_AUTOAVSR_GPU_IDX=-1
```

The server now loads AutoAVSR weights during startup and keeps the model warm in-process for subsequent requests.
The app sends an encoded `videoDataUrl` clip to `/transcribe`, and polls `/health` to wait until the model is ready.

## Model candidates (English)

- LipNet (GRID‑style sentence lipreading).
- AV‑HuBERT / fairseq (supports video‑only or AV fine‑tuning).
- Visual Speech Recognition for Multiple Languages (LRS2/LRS3/GRID models).
- deep_avsr (LRS2/LRS3 video‑only baselines).

## Notes

- This starter sends short encoded video clips (`videoDataUrl`) to the backend.
- For production, enable a CSP instead of leaving it disabled in `src-tauri/tauri.conf.json`.
- If you see `navigator.mediaDevices.getUserMedia` missing, rebuild/restart the Tauri app and allow camera access when prompted.
  On macOS, verify Camera permission in System Settings -> Privacy & Security -> Camera.
- If paste automation fails, verify Accessibility permission in System Settings -> Privacy & Security -> Accessibility.
