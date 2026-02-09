from __future__ import annotations

import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from .model import load_model

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TranscribeRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    frames: List[str] = Field(default_factory=list)
    fps: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    video_data_url: Optional[str] = Field(default=None, alias="videoDataUrl")


@app.on_event("startup")
def startup_event() -> None:
    load_start = time.perf_counter()
    model = load_model()
    app.state.model = model
    app.state.model_ready = True
    app.state.model_backend = getattr(model, "name", "unknown")
    app.state.model_device = getattr(model, "runtime_device", "cpu")
    app.state.model_device_reason = getattr(model, "runtime_device_reason", None)
    app.state.model_load_ms = int((time.perf_counter() - load_start) * 1000)
    app.state.model_error = None


@app.get("/health")
def health_check(response: Response) -> dict:
    ready = bool(getattr(app.state, "model_ready", False))
    if not ready:
        response.status_code = 503
    return {
        "status": "ok" if ready else "loading",
        "ready": ready,
        "backend": getattr(app.state, "model_backend", "unknown"),
        "device": getattr(app.state, "model_device", None),
        "deviceReason": getattr(app.state, "model_device_reason", None),
        "modelLoadMs": getattr(app.state, "model_load_ms", None),
        "error": getattr(app.state, "model_error", None),
    }


@app.post("/transcribe")
def transcribe_endpoint(payload: TranscribeRequest) -> dict:
    model = getattr(app.state, "model", None)
    if model is None:
        raise HTTPException(status_code=503, detail="Model is still loading.")

    request_start = time.perf_counter()
    model_start = time.perf_counter()
    try:
        text, model_trace = model.transcribe(
            frames=payload.frames,
            fps=payload.fps,
            video_data_url=payload.video_data_url,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    after_model = time.perf_counter()
    trace = {
        "beforeModelMs": int((model_start - request_start) * 1000),
        "modelCallMs": int((after_model - model_start) * 1000),
        "decodeVideoMs": model_trace.get("decodeVideoMs"),
        "inferenceMs": model_trace.get("inferenceMs"),
        "parseOutputMs": model_trace.get("parseOutputMs"),
        "modelTotalMs": model_trace.get("modelTotalMs"),
        "landmarksMs": model_trace.get("landmarksMs"),
        "dataLoadMs": model_trace.get("dataLoadMs"),
        "encodeMs": model_trace.get("encodeMs"),
        "beamSearchMs": model_trace.get("beamSearchMs"),
        "postprocessMs": model_trace.get("postprocessMs"),
    }
    response_build_start = time.perf_counter()

    response = {
        "text": text,
        "meta": {
            "frames": len(payload.frames) if payload.frames else None,
            "fps": payload.fps,
            "backend": getattr(model, "name", "unknown"),
            "trace": trace,
        },
    }
    response_build_ms = int((time.perf_counter() - response_build_start) * 1000)
    total_ms = int((time.perf_counter() - request_start) * 1000)
    response["meta"]["latencyMs"] = total_ms
    response["meta"]["trace"]["responseBuildMs"] = response_build_ms
    return response
