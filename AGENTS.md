# Repository Guidelines

## Project Structure & Module Organization
- `src/`: React + TypeScript frontend (entry: `src/main.tsx`, main UI: `src/App.tsx`).
- `server/`: FastAPI inference service (`server/main.py`) and model integration stub (`server/model.py`).
- `src-tauri/`: Rust/Tauri desktop wrapper (`src-tauri/src/*.rs`, app config in `src-tauri/tauri.conf.json`).
- `public/`: static assets served by Vite.
- Root config files (`vite.config.ts`, `tailwind.config.ts`, `tsconfig.json`) define build and style behavior.

## Build, Test, and Development Commands
- `npm install`: install frontend + Tauri JS dependencies.
- `npm run dev`: run the Vite web UI locally.
- `npm run build`: TypeScript check (`tsc`) and production bundle.
- `npm run preview`: preview the built web app.
- `npm run tauri dev`: launch the desktop app in development mode.
- `./scripts/setup_python_env.sh`: create/update the single uv-managed Python environment at `.venv`.
- `./scripts/setup_autoavsr_assets.sh`: clone/download AutoAVSR checkpoints into `third_party/`.
- `.venv/bin/uvicorn server.main:app --reload`: run backend API on `127.0.0.1:8000`.
- Optional Rust validation: `cd src-tauri && cargo check`.

## Coding Style & Naming Conventions
- TypeScript runs in strict mode; do not leave unused locals/parameters.
- Frontend style follows existing code: 2-space indentation, `PascalCase` components, `camelCase` functions/variables, `UPPER_SNAKE_CASE` constants.
- Python follows PEP 8 with type hints; use `snake_case` for functions and variables.
- Keep request/response field names consistent across UI and API (for example `latencyMs`).

## Testing Guidelines
- No automated test suite is configured yet.
- Minimum validation before opening a PR:
  - Run `npm run build`.
  - Start backend and verify `GET /health`.
  - Run `npm run tauri dev` and exercise the capture/transcribe flow.
- For new logic, add focused tests with the framework you introduce and document how to run them.

## Commit & Pull Request Guidelines
- This repository currently has no commit history; use Conventional Commit style from now on (for example `feat: add health check logging`).
- Keep commits small and single-purpose.
- PRs should include: change summary, verification steps/commands, linked issue (if any), and screenshots for UI changes.

## Security & Configuration Tips
- `SERVER_URL` in `src/App.tsx` targets local backend by default; keep non-local endpoints configurable.
- Do not commit secrets, tokens, or model artifacts.
- Revisit Tauri CSP settings in `src-tauri/tauri.conf.json` before production release.
