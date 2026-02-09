from __future__ import annotations

import base64
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

DATA_URL_PATTERN = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$")
MIME_TO_EXT = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "image/gif": ".gif",
}


class BaseTranscriber:
    name = "unknown"

    def transcribe(
        self,
        frames: Sequence[str],
        fps: float | None = None,
        video_data_url: str | None = None,
    ) -> str:
        raise NotImplementedError


class StubTranscriber(BaseTranscriber):
    name = "stub"

    def transcribe(
        self,
        frames: Sequence[str],
        fps: float | None = None,
        video_data_url: str | None = None,
    ) -> str:
        frame_count = len(frames)
        fps_info = f" at {fps:.1f} fps" if fps else ""
        return f"[stub] Received {frame_count} frames{fps_info}."


@dataclass
class AutoAvsrConfig:
    repo_dir: Path
    python_bin: str
    config_filename: str
    detector: str
    gpu_idx: int
    timeout_sec: int


class AutoAvsrTranscriber(BaseTranscriber):
    name = "autoavsr"

    def __init__(self, config: AutoAvsrConfig) -> None:
        infer_script = config.repo_dir / "infer.py"
        if not infer_script.exists():
            raise FileNotFoundError(f"Missing AutoAVSR infer script: {infer_script}")
        self.config = config

    def transcribe(
        self,
        frames: Sequence[str],
        fps: float | None = None,
        video_data_url: str | None = None,
    ) -> str:
        if not video_data_url:
            raise ValueError(
                "AutoAVSR requires `videoDataUrl` in the request payload."
            )

        with tempfile.TemporaryDirectory(prefix="telepathy-avsr-") as tmp_dir:
            video_path = self._write_video_file(video_data_url, Path(tmp_dir))
            cmd = [
                self.config.python_bin,
                "infer.py",
                f"config_filename={self.config.config_filename}",
                f"data_filename={video_path}",
                f"detector={self.config.detector}",
                f"gpu_idx={self.config.gpu_idx}",
            ]
            proc = subprocess.run(
                cmd,
                cwd=self.config.repo_dir,
                capture_output=True,
                text=True,
                timeout=self.config.timeout_sec,
            )
            if proc.returncode != 0:
                tail = self._tail_lines(proc.stderr or proc.stdout)
                raise RuntimeError(f"AutoAVSR inference failed: {tail}")
            return self._parse_transcript(proc.stdout, proc.stderr)

    @staticmethod
    def _write_video_file(video_data_url: str, out_dir: Path) -> str:
        match = DATA_URL_PATTERN.match(video_data_url.strip())
        if not match:
            raise ValueError("`videoDataUrl` must be a valid base64 data URL.")

        mime_type = match.group("mime")
        payload = match.group("data")
        ext = MIME_TO_EXT.get(mime_type, ".bin")
        out_path = out_dir / f"capture{ext}"
        out_path.write_bytes(base64.b64decode(payload))
        return str(out_path)

    @staticmethod
    def _parse_transcript(stdout: str, stderr: str) -> str:
        lines = [line.strip() for line in stdout.splitlines() if line.strip()]
        for line in reversed(lines):
            lower = line.lower()
            if (
                lower.startswith("prediction:")
                or lower.startswith("predicted text:")
                or lower.startswith("hyp:")
            ):
                return line.split(":", 1)[1].strip().strip('"')

        if lines:
            return lines[-1].strip().strip('"')

        err_lines = [line.strip() for line in stderr.splitlines() if line.strip()]
        if err_lines:
            return err_lines[-1]
        raise RuntimeError("AutoAVSR produced no parseable transcription output.")

    @staticmethod
    def _tail_lines(output: str, max_lines: int = 8) -> str:
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if not lines:
            return "no logs captured"
        return " | ".join(lines[-max_lines:])


def load_model() -> BaseTranscriber:
    backend = os.getenv("TELEPATHY_MODEL_BACKEND", "autoavsr").lower()
    if backend == "stub":
        return StubTranscriber()

    if backend == "autoavsr":
        repo_path = os.getenv("TELEPATHY_AUTOAVSR_REPO")
        if not repo_path:
            bundled_repo = (
                Path(__file__).resolve().parents[1]
                / "third_party"
                / "Visual_Speech_Recognition_for_Multiple_Languages"
            )
            if bundled_repo.exists():
                repo_path = str(bundled_repo)
        if not repo_path:
            print(
                "TELEPATHY_AUTOAVSR_REPO is not set; falling back to stub transcriber."
            )
            return StubTranscriber()

        python_bin = os.getenv("TELEPATHY_AUTOAVSR_PYTHON", sys.executable)

        config = AutoAvsrConfig(
            repo_dir=Path(repo_path).expanduser().resolve(),
            python_bin=python_bin,
            config_filename=os.getenv(
                "TELEPATHY_AUTOAVSR_CONFIG", "configs/LRS3_V_WER19.1.ini"
            ),
            detector=os.getenv("TELEPATHY_AUTOAVSR_DETECTOR", "mediapipe"),
            gpu_idx=int(os.getenv("TELEPATHY_AUTOAVSR_GPU_IDX", "-1")),
            timeout_sec=int(os.getenv("TELEPATHY_AUTOAVSR_TIMEOUT_SEC", "240")),
        )
        try:
            return AutoAvsrTranscriber(config)
        except Exception as exc:
            print(f"Unable to initialize AutoAVSR ({exc}); falling back to stub.")
            return StubTranscriber()

    print(f"Unknown TELEPATHY_MODEL_BACKEND={backend!r}; falling back to stub.")
    return StubTranscriber()
