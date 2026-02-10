from __future__ import annotations

import base64
import binascii
from configparser import ConfigParser
import importlib
import os
import re
import threading
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

TraceValue = Optional[int | float] | str

DEFAULT_MODEL_VIDEO_FPS = 25.0

DATA_URL_PATTERN = re.compile(
    r"^data:(?P<mime>[^;,]+)(?:;[^;,=]+=[^;,]+)*;base64,(?P<data>.+)$"
)
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
    ) -> tuple[str, dict[str, TraceValue]]:
        raise NotImplementedError


class StubTranscriber(BaseTranscriber):
    name = "stub"

    def transcribe(
        self,
        frames: Sequence[str],
        fps: float | None = None,
        video_data_url: str | None = None,
    ) -> tuple[str, dict[str, TraceValue]]:
        start = time.perf_counter()
        frame_count = len(frames)
        fps_info = f" at {fps:.1f} fps" if fps else ""
        text = f"[stub] Received {frame_count} frames{fps_info}."
        model_total_ms = int((time.perf_counter() - start) * 1000)
        return text, {
            "decodeVideoMs": None,
            "inferenceMs": 0,
            "parseOutputMs": None,
            "modelTotalMs": model_total_ms,
        }


@dataclass
class AutoAvsrConfig:
    repo_dir: Path
    config_filename: str
    detector: str
    device: str
    gpu_idx: int


class AutoAvsrTranscriber(BaseTranscriber):
    name = "autoavsr"

    def __init__(self, config: AutoAvsrConfig) -> None:
        if not config.repo_dir.exists():
            raise FileNotFoundError(f"Missing AutoAVSR repo: {config.repo_dir}")
        config_path = Path(config.config_filename)
        if not config_path.is_absolute():
            config_path = config.repo_dir / config_path
        self._config_path = config_path.expanduser().resolve()
        if not self._config_path.exists():
            raise FileNotFoundError(f"Missing AutoAVSR config: {self._config_path}")

        self.config = config
        self.model_video_fps = self._read_model_video_fps(self._config_path)
        self.runtime_device, self.runtime_device_reason = self._resolve_runtime_device(
            config.device,
            config.gpu_idx,
        )
        self._inference_lock = threading.Lock()
        self._pipeline = self._load_pipeline()

    def transcribe(
        self,
        frames: Sequence[str],
        fps: float | None = None,
        video_data_url: str | None = None,
    ) -> tuple[str, dict[str, TraceValue]]:
        model_start = time.perf_counter()
        if not video_data_url:
            raise ValueError(
                "AutoAVSR requires `videoDataUrl` in the request payload."
            )

        with tempfile.TemporaryDirectory(prefix="telepathy-avsr-") as tmp_dir:
            decode_start = time.perf_counter()
            video_path = self._write_video_file(video_data_url, Path(tmp_dir))
            decode_video_ms = int((time.perf_counter() - decode_start) * 1000)
            input_video_fps = (
                float(fps)
                if fps is not None and fps > 0
                else self._probe_video_fps(video_path)
            )
            inference_start = time.perf_counter()
            with self._inference_lock:
                applied_speed_rate = self._apply_input_fps(input_video_fps)
                text, inference_trace = self._pipeline(
                    video_path,
                    None,
                    return_trace=True,
                )
            inference_ms = int((time.perf_counter() - inference_start) * 1000)
            parse_start = time.perf_counter()
            parsed_text = str(text).strip()
            if not parsed_text:
                raise RuntimeError("AutoAVSR produced empty transcription output.")
            parse_output_ms = int((time.perf_counter() - parse_start) * 1000)
            model_total_ms = int((time.perf_counter() - model_start) * 1000)
            return parsed_text, {
                "decodeVideoMs": decode_video_ms,
                "inferenceMs": inference_ms,
                "parseOutputMs": parse_output_ms,
                "modelTotalMs": model_total_ms,
                "landmarksMs": inference_trace.get("landmarksMs"),
                "dataLoadMs": inference_trace.get("dataLoadMs"),
                "encodeMs": inference_trace.get("encodeMs"),
                "beamSearchMs": inference_trace.get("beamSearchMs"),
                "postprocessMs": inference_trace.get("postprocessMs"),
                "inputFps": round(input_video_fps, 2) if input_video_fps else None,
                "modelVfps": round(self.model_video_fps, 2),
                "speedRate": round(applied_speed_rate, 4),
            }

    @staticmethod
    def _write_video_file(video_data_url: str, out_dir: Path) -> str:
        match = DATA_URL_PATTERN.match(video_data_url.strip())
        if not match:
            raise ValueError("`videoDataUrl` must be a valid base64 data URL.")

        mime_type = match.group("mime").lower()
        payload = match.group("data")
        ext = MIME_TO_EXT.get(mime_type, ".bin")
        out_path = out_dir / f"capture{ext}"
        try:
            out_path.write_bytes(base64.b64decode(payload, validate=True))
        except binascii.Error as exc:
            raise ValueError("`videoDataUrl` contains invalid base64 data.") from exc
        return str(out_path)

    @staticmethod
    def _read_model_video_fps(config_path: Path) -> float:
        parser = ConfigParser()
        parser.read(config_path)
        try:
            model_v_fps = parser.getfloat("model", "v_fps")
            if model_v_fps > 0:
                return model_v_fps
        except Exception:
            pass
        return DEFAULT_MODEL_VIDEO_FPS

    @staticmethod
    def _probe_video_fps(video_path: str) -> float | None:
        try:
            import cv2
        except Exception:
            return None

        capture = cv2.VideoCapture(video_path)
        try:
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
            return fps if fps > 0 else None
        finally:
            capture.release()

    def _apply_input_fps(self, input_video_fps: float | None) -> float:
        if input_video_fps is None or input_video_fps <= 0 or self.model_video_fps <= 0:
            speed_rate = 1.0
        else:
            speed_rate = max(input_video_fps / self.model_video_fps, 0.05)
        transforms_module = importlib.import_module("pipelines.data.transforms")
        video_transform_cls = getattr(transforms_module, "VideoTransform")
        self._pipeline.dataloader.video_transform = video_transform_cls(speed_rate=speed_rate)
        return speed_rate

    def _load_pipeline(self):
        repo_dir = str(self.config.repo_dir)
        if repo_dir not in sys.path:
            sys.path.insert(0, repo_dir)
        pipeline_module = importlib.import_module("pipelines.pipeline")
        inference_cls = getattr(pipeline_module, "InferencePipeline")
        return inference_cls(
            str(self._config_path),
            detector=self.config.detector,
            face_track=True,
            device=self.runtime_device,
        )

    @staticmethod
    def _resolve_runtime_device(preferred: str, gpu_idx: int) -> tuple[str, str]:
        try:
            import torch
        except Exception:
            return "cpu", "torch-unavailable"

        requested = (preferred or "auto").strip().lower()
        if requested and requested != "auto":
            if requested.startswith("cuda"):
                if torch.cuda.is_available():
                    return requested, "user-requested"
                print(
                    f"Requested TELEPATHY_AUTOAVSR_DEVICE={requested}, but CUDA is unavailable."
                )
            elif requested == "mps":
                if torch.backends.mps.is_available():
                    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
                    return "mps", "user-requested"
                print(
                    "Requested TELEPATHY_AUTOAVSR_DEVICE=mps, but MPS is unavailable."
                )
            elif requested == "cpu":
                return "cpu", "user-requested"
            else:
                print(f"Unknown TELEPATHY_AUTOAVSR_DEVICE={requested!r}; using auto.")

        if torch.cuda.is_available() and gpu_idx >= 0:
            return f"cuda:{gpu_idx}", "auto-cuda"
        if torch.backends.mps.is_available():
            return "cpu", "auto-cpu-on-apple-silicon"
        return "cpu", "auto-cpu"


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

        config = AutoAvsrConfig(
            repo_dir=Path(repo_path).expanduser().resolve(),
            config_filename=os.getenv(
                "TELEPATHY_AUTOAVSR_CONFIG", "configs/LRS3_V_WER19.1.ini"
            ),
            detector=os.getenv("TELEPATHY_AUTOAVSR_DETECTOR", "mediapipe"),
            device=os.getenv("TELEPATHY_AUTOAVSR_DEVICE", "mps").strip().lower(),
            gpu_idx=int(os.getenv("TELEPATHY_AUTOAVSR_GPU_IDX", "-1")),
        )
        try:
            return AutoAvsrTranscriber(config)
        except Exception as exc:
            print(f"Unable to initialize AutoAVSR ({exc}); falling back to stub.")
            return StubTranscriber()

    print(f"Unknown TELEPATHY_MODEL_BACKEND={backend!r}; falling back to stub.")
    return StubTranscriber()
