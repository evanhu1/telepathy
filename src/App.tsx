import { useEffect, useMemo, useRef, useState } from "react";

const SERVER_URL = "http://127.0.0.1:8000/transcribe";
const CAPTURE_SECONDS = 3;

type CaptureState = "loading" | "ready" | "capturing" | "sending" | "error";

type TranscribeResponse = {
  text?: string;
  meta?: {
    frames?: number | null;
    fps?: number | null;
    latencyMs?: number;
    backend?: string;
  };
};

function getUnavailableCameraMessage(): string {
  const protocol = window.location.protocol;
  const secureHint = window.isSecureContext
    ? ""
    : " This context is not secure, so camera APIs are blocked.";
  return `Camera API is unavailable (protocol: ${protocol}).${secureHint} Reopen the app, then allow camera access in system/browser settings.`;
}

function formatCameraSetupError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Camera permission denied. Enable camera access for Telepathy, then reopen the app.";
    }
    if (err.name === "NotFoundError") {
      return "No camera device was found.";
    }
    if (err.name === "NotReadableError" || err.name === "AbortError") {
      return "Camera is busy or unavailable. Close other camera apps and try again.";
    }
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Unable to access the camera. Check permissions and device availability.";
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<CaptureState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [meta, setMeta] = useState<TranscribeResponse["meta"]>(undefined);

  const statusLabel = useMemo(() => {
    switch (state) {
      case "loading":
        return "Requesting camera access…";
      case "capturing":
        return "Recording clip…";
      case "sending":
        return "Sending clip to model…";
      case "error":
        return "Camera or server error";
      default:
        return "Camera ready";
    }
  }, [state]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    const setupCamera = async () => {
      try {
        setState("loading");
        if (!navigator.mediaDevices?.getUserMedia) {
          setError(getUnavailableCameraMessage());
          setState("error");
          return;
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 960 },
            height: { ideal: 540 },
          },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setError(null);
        setState("ready");
      } catch (err) {
        setError(formatCameraSetupError(err));
        setState("error");
      }
    };

    setupCamera();

    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const handleCapture = async () => {
    if (!videoRef.current) return;
    setError(null);
    setTranscript("");
    setMeta(undefined);
    setState("capturing");

    if (typeof MediaRecorder === "undefined") {
      setError("MediaRecorder is not available in this environment.");
      setState("error");
      return;
    }

    try {
      const video = videoRef.current;
      const stream = video.srcObject;
      if (!(stream instanceof MediaStream)) {
        throw new Error("Camera stream is not active.");
      }

      const width = video.videoWidth || 960;
      const height = video.videoHeight || 540;
      const preferredMimeTypes = [
        "video/mp4;codecs=h264",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/mp4",
        "video/webm",
      ];
      const mimeType = preferredMimeTypes.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];

      const blobPromise = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onerror = () => {
          reject(new Error("Unable to record video clip."));
        };
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
        };
      });

      recorder.start(250);
      await new Promise((resolve) =>
        window.setTimeout(resolve, CAPTURE_SECONDS * 1000),
      );
      if (recorder.state !== "inactive") {
        recorder.stop();
      }

      const blob = await blobPromise;
      if (!blob.size) {
        throw new Error("Recorded clip is empty.");
      }

      const videoDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Unable to encode recorded clip."));
        reader.onload = () => {
          if (typeof reader.result !== "string") {
            reject(new Error("Recorded clip encoding failed."));
            return;
          }
          resolve(reader.result);
        };
        reader.readAsDataURL(blob);
      });

      setState("sending");
      const start = performance.now();
      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: [],
          width,
          height,
          videoDataUrl,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}.`);
      }

      const data = (await response.json()) as TranscribeResponse;
      setTranscript(data.text ?? "(No transcription returned)");
      setMeta({
        ...(data.meta ?? {}),
        latencyMs: data.meta?.latencyMs ?? Math.round(performance.now() - start),
      });
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reach server.");
      setState("error");
    }
  };

  const canCapture = state === "ready" || state === "error";

  return (
    <div className="min-h-screen px-6 py-10 text-graphite-900">
      <header className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-graphite-400">
          Telepathy Lab
        </p>
        <h1 className="font-display text-4xl font-semibold text-ink-900 sm:text-5xl">
          Visual speech capture for English lipreading models.
        </h1>
        <p className="max-w-2xl text-base text-graphite-700 sm:text-lg">
          Capture a short front-camera clip and send it to a local Python inference
          server. This starter UI keeps everything on-device while you iterate on
          model integration.
        </p>
      </header>

      <main className="mx-auto mt-10 grid w-full max-w-5xl gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="relative overflow-hidden rounded-3xl border border-white/70 bg-white/80 p-6 shadow-glow backdrop-blur">
          <div className="absolute -right-12 -top-12 h-44 w-44 rounded-full bg-ink-200/40 blur-3xl" />
          <div className="absolute -bottom-20 -left-12 h-48 w-48 rounded-full bg-ember-300/30 blur-3xl" />
          <div className="relative z-10 flex flex-col gap-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-graphite-700">Camera Preview</span>
              <span className="rounded-full border border-graphite-200 bg-white/80 px-3 py-1 text-xs font-semibold text-graphite-500">
                {statusLabel}
              </span>
            </div>
            <div className="relative aspect-video overflow-hidden rounded-2xl border border-graphite-200 bg-graphite-100">
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                autoPlay
                playsInline
                muted
              />
              {state === "capturing" && (
                <div className="absolute inset-0 flex items-center justify-center bg-graphite-900/40 text-sm font-semibold text-white">
                  Capturing {CAPTURE_SECONDS}s video clip
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="rounded-full bg-ink-600 px-5 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:bg-graphite-200 disabled:text-graphite-400"
                onClick={handleCapture}
                disabled={!canCapture}
              >
                Capture & Transcribe
              </button>
              <span className="text-xs text-graphite-500">
                {CAPTURE_SECONDS}s clip · encoded video · local server
              </span>
            </div>
            {error && (
              <div className="rounded-2xl border border-ember-300/60 bg-ember-300/10 px-4 py-3 text-sm text-ember-700">
                {error}
              </div>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-6">
          <div className="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-glow backdrop-blur">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-graphite-700">Transcription</h2>
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-graphite-300">
                English only
              </span>
            </div>
            <div className="mt-4 min-h-[180px] rounded-2xl border border-dashed border-graphite-200 bg-white/60 p-4 text-base text-graphite-700">
              {transcript || "Start a capture to see model output here."}
            </div>
            {meta && (
              <div className="mt-4 flex flex-wrap gap-3 text-xs text-graphite-500">
                {meta.frames !== undefined && meta.frames !== null && (
                  <span>{meta.frames} frames</span>
                )}
                {meta.fps !== undefined && meta.fps !== null && (
                  <span>{meta.fps} fps</span>
                )}
                {meta.latencyMs && <span>{meta.latencyMs} ms server time</span>}
                {meta.backend && <span>{meta.backend} backend</span>}
              </div>
            )}
          </div>
          <div className="rounded-3xl border border-graphite-200 bg-graphite-900 p-5 text-sm text-graphite-100">
            <p className="font-semibold text-white">Server status</p>
            <p className="mt-2 text-graphite-200">
              Run the Python server before capturing. It receives an encoded video
              clip and returns a text prediction from the model pipeline.
            </p>
            <div className="mt-4 rounded-2xl bg-graphite-800 px-4 py-3 font-mono text-xs text-graphite-100">
              python -m uvicorn server.main:app --reload
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
