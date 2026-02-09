# Telepathy (visual speech prototype)

A simple Tauri desktop app for macOS that captures short front‑camera clips and sends encoded video to a local Python server for visual speech (lipreading) inference.

## Quick start

1. Install JS dependencies:

   ```bash
   npm install
   ```

2. Create the single Python environment (uv-managed):

   ```bash
   ./scripts/setup_python_env.sh
   ```

3. Download/prepare AutoAVSR assets (repo + checkpoints):

   ```bash
   ./scripts/setup_autoavsr_assets.sh
   ```

4. Run the Python server:

   ```bash
   .venv/bin/uvicorn server.main:app --reload
   ```

5. Run the Tauri app:

   ```bash
   npm run tauri dev
   ```

The UI will request camera permissions. Click **Capture & Transcribe** to send a 3s clip to the server and view the response.

## Model backend (AutoAVSR)

The backend now supports an AutoAVSR transcriber adapter in `server/model.py`.
It expects a local checkout of:

- `https://github.com/mpc001/Visual_Speech_Recognition_for_Multiple_Languages`

`server/model.py` auto-detects:
- `third_party/Visual_Speech_Recognition_for_Multiple_Languages`
- `.venv/bin/python` (the same uv environment used by the API server)

No extra environment variables are required for the default local setup.

Optional overrides:

```bash
export TELEPATHY_MODEL_BACKEND=autoavsr
export TELEPATHY_AUTOAVSR_REPO=/absolute/path/to/Visual_Speech_Recognition_for_Multiple_Languages
export TELEPATHY_AUTOAVSR_PYTHON=/absolute/path/to/your/model-env/bin/python
# Optional (defaults shown):
# export TELEPATHY_AUTOAVSR_CONFIG=configs/LRS3_V_WER19.1.ini
# export TELEPATHY_AUTOAVSR_DETECTOR=mediapipe
# export TELEPATHY_AUTOAVSR_GPU_IDX=-1
```

The UI now sends an encoded `videoDataUrl` clip (3s) to `/transcribe`, which the backend writes to a temporary video file and forwards to AutoAVSR `infer.py`.

## Model candidates (English)

- LipNet (GRID‑style sentence lipreading).
- AV‑HuBERT / fairseq (supports video‑only or AV fine‑tuning).
- Visual Speech Recognition for Multiple Languages (LRS2/LRS3/GRID models).
- deep_avsr (LRS2/LRS3 video‑only baselines).

## Notes

- This starter sends short encoded video clips (`videoDataUrl`) to the backend.
- For production, enable a CSP instead of leaving it disabled in `src-tauri/tauri.conf.json`.
- If you see `navigator.mediaDevices.getUserMedia` missing, rebuild/restart the Tauri app and allow camera access when prompted.
  On macOS, also verify Camera permission for Telepathy in System Settings -> Privacy & Security -> Camera.
