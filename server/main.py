from __future__ import annotations

import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .model import load_model

app = FastAPI()
model = load_model()


class TranscribeRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    frames: List[str] = Field(default_factory=list)
    fps: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    video_data_url: Optional[str] = Field(default=None, alias="videoDataUrl")


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}


@app.post("/transcribe")
def transcribe_endpoint(payload: TranscribeRequest) -> dict:
    start = time.time()
    try:
        text = model.transcribe(
            frames=payload.frames,
            fps=payload.fps,
            video_data_url=payload.video_data_url,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    latency_ms = int((time.time() - start) * 1000)

    return {
        "text": text,
        "meta": {
            "frames": len(payload.frames) if payload.frames else None,
            "fps": payload.fps,
            "latencyMs": latency_ms,
            "backend": getattr(model, "name", "unknown"),
        },
    }
