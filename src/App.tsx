import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SERVER_BASE_URL = "http://127.0.0.1:8000";
const TRANSCRIBE_URL = `${SERVER_BASE_URL}/transcribe`;
const HEALTH_URL = `${SERVER_BASE_URL}/health`;
const HEALTH_POLL_MS = 1500;
const OVERLAY_HIDE_MS = 1300;
const HOTKEY_LABEL = "Cmd/Ctrl + Shift + Space";
const DEV_SKIP = import.meta.env.VITE_DEV_SKIP === "1";

type OverlayState =
  | "idle"
  | "waiting"
  | "recording"
  | "processing"
  | "pasted"
  | "error";
type ServerState = "checking" | "ready" | "loading" | "offline" | "error";

type TranscribeResponse = {
  text?: string;
};

type HealthResponse = {
  status?: string;
  ready?: boolean;
};

type HotkeyEventPayload = {
  state?: "pressed" | "released";
  shortcut?: string;
};

type PasteResult = {
  pasted: boolean;
};

type AccessibilityStatus = {
  granted: boolean;
  detail?: string | null;
};

function getUnavailableCameraMessage(): string {
  const protocol = window.location.protocol;
  const secureHint = window.isSecureContext
    ? ""
    : " This context is not secure, so camera APIs are blocked.";
  return `Camera API is unavailable (protocol: ${protocol}).${secureHint}`;
}

function formatCameraSetupError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Camera permission denied. Enable camera access for Telepathy.";
    }
    if (err.name === "NotFoundError") {
      return "No camera device was found.";
    }
    if (err.name === "NotReadableError" || err.name === "AbortError") {
      return "Camera is busy or unavailable.";
    }
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Unable to access the camera.";
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function statusTone(status: boolean): string {
  return status ? "text-emerald-200" : "text-amber-200";
}

function App() {
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const stopPromiseRef = useRef<Promise<Blob> | null>(null);
  const hotkeyDownRef = useRef(false);
  const overlayModeRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const [overlayState, setOverlayState] = useState<OverlayState>("idle");
  const [overlayDetail, setOverlayDetail] = useState("");
  const [serverState, setServerState] = useState<ServerState>("checking");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [requestingCamera, setRequestingCamera] = useState(false);
  const [accessibilityGranted, setAccessibilityGranted] = useState(false);
  const [accessibilityDetail, setAccessibilityDetail] = useState<string>("");
  const [checkingAccessibility, setCheckingAccessibility] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string>("");
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [lastHotkey, setLastHotkey] = useState(HOTKEY_LABEL);

  const setTimedIdle = useCallback((ms: number) => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      setOverlayState("idle");
      setOverlayDetail("");
    }, ms);
  }, []);

  const setOverlayPassthrough = useCallback(async (enabled: boolean) => {
    if (!isTauriRuntime()) {
      return;
    }
    await invoke("set_overlay_passthrough", { ignoreCursorEvents: enabled });
  }, []);

  const checkAccessibility = useCallback(async () => {
    if (!isTauriRuntime()) {
      setAccessibilityGranted(false);
      setAccessibilityDetail("Run with `npm run tauri dev`.");
      return;
    }

    setCheckingAccessibility(true);
    try {
      const status = await invoke<AccessibilityStatus>("check_accessibility_permission");
      setAccessibilityGranted(status.granted);
      if (!status.granted) {
        setAccessibilityDetail(
          status.detail?.trim() ||
            "Accessibility permission is required to auto-paste into other apps.",
        );
      } else {
        setAccessibilityDetail("");
      }
    } catch (err) {
      setAccessibilityGranted(false);
      setAccessibilityDetail(err instanceof Error ? err.message : "Unable to verify permission.");
    } finally {
      setCheckingAccessibility(false);
    }
  }, []);

  const requestCamera = useCallback(async () => {
    if (cameraReady) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(getUnavailableCameraMessage());
      return;
    }

    setRequestingCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 960 },
          height: { ideal: 540 },
        },
        audio: false,
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      setCameraReady(true);
      setCameraError(null);
    } catch (err) {
      setCameraReady(false);
      setCameraError(formatCameraSetupError(err));
    } finally {
      setRequestingCamera(false);
    }
  }, [cameraReady]);

  const openPermissionSettings = useCallback(async (panel: "camera" | "accessibility") => {
    try {
      await invoke("open_system_settings", { panel });
      setOnboardingError("");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setOnboardingError(
        `Unable to open System Settings automatically. Open Privacy & Security manually.${detail ? ` (${detail})` : ""}`,
      );
    }
  }, []);

  const showError = useCallback(
    (message: string) => {
      setOverlayState("error");
      setOverlayDetail(message);
      setTimedIdle(2600);
    },
    [setTimedIdle],
  );

  const encodeBlob = useCallback((blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
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
  }, []);

  const startRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) {
      throw new Error("Camera stream is not active.");
    }
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not available in this environment.");
    }

    chunksRef.current = [];
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

    stopPromiseRef.current = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => reject(new Error("Unable to record video clip."));
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" }));
      };
    });

    recorder.start(120);
    recorderRef.current = recorder;
  }, []);

  const handleHotkeyPressed = useCallback(() => {
    if (!overlayModeRef.current) {
      return;
    }
    if (overlayState === "processing" || overlayState === "recording") {
      return;
    }
    if (!cameraReady) {
      showError(cameraError ?? "Camera is still initializing.");
      return;
    }
    if (serverState !== "ready") {
      const message =
        serverState === "loading"
          ? "Model loading. Keep backend running."
          : serverState === "offline"
            ? "Server offline. Start uvicorn."
            : "Server not ready.";
      setOverlayState("waiting");
      setOverlayDetail(message);
      return;
    }

    try {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
      startRecorder();
      setLastTranscript("");
      setOverlayState("recording");
      setOverlayDetail("Recording. Release to transcribe.");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Unable to start recording.");
    }
  }, [cameraError, cameraReady, overlayState, serverState, showError, startRecorder]);

  const handleHotkeyReleased = useCallback(async () => {
    if (!overlayModeRef.current) {
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder) {
      if (overlayState === "waiting") {
        setTimedIdle(500);
      }
      return;
    }

    try {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      recorderRef.current = null;
      const blob = await stopPromiseRef.current;
      stopPromiseRef.current = null;

      if (!blob || blob.size === 0) {
        throw new Error("Recorded clip is empty.");
      }

      setOverlayState("processing");
      setOverlayDetail("Transcribing...");

      const videoDataUrl = await encodeBlob(blob);
      const track = streamRef.current?.getVideoTracks()[0];
      const settings = track?.getSettings();
      const response = await fetch(TRANSCRIBE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: [],
          width: settings?.width ?? null,
          height: settings?.height ?? null,
          videoDataUrl,
        }),
      });

      if (!response.ok) {
        let detail = "";
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const errorBody = (await response.json()) as { detail?: string };
          detail = typeof errorBody.detail === "string" ? errorBody.detail : "";
        } else {
          detail = (await response.text()).trim();
        }
        throw new Error(
          detail
            ? `Server responded with ${response.status}: ${detail}`
            : `Server responded with ${response.status}.`,
        );
      }

      const payload = (await response.json()) as TranscribeResponse;
      const text = (payload.text ?? "").trim() || "(No transcription returned)";
      setLastTranscript(text);

      let pasted = false;
      if (isTauriRuntime()) {
        const pasteResult = await invoke<PasteResult>("paste_text", { text });
        pasted = pasteResult.pasted;
      }

      setOverlayState("pasted");
      setOverlayDetail(pasted ? "Pasted into active app." : "Copied to clipboard.");
      setTimedIdle(OVERLAY_HIDE_MS);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Transcription failed.");
    }
  }, [encodeBlob, overlayState, setTimedIdle, showError]);

  useEffect(() => {
    let cancelled = false;
    let timerId: number | undefined;

    const pollHealth = async () => {
      try {
        const response = await fetch(HEALTH_URL, { cache: "no-store" });
        const contentType = response.headers.get("content-type") ?? "";
        const data = contentType.includes("application/json")
          ? ((await response.json()) as HealthResponse)
          : null;

        if (!cancelled) {
          if (response.ok && data?.ready) {
            setServerState("ready");
          } else if (response.status === 503 || data?.status === "loading") {
            setServerState("loading");
          } else {
            setServerState("error");
          }
        }
      } catch {
        if (!cancelled) {
          setServerState("offline");
        }
      } finally {
        if (!cancelled) {
          timerId = window.setTimeout(pollHealth, HEALTH_POLL_MS);
        }
      }
    };

    pollHealth();
    return () => {
      cancelled = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setOnboardingError("Run this with `npm run tauri dev` for global hotkey support.");
      return;
    }

    let active = true;
    let unlisten: (() => void) | undefined;
    const bind = async () => {
      unlisten = await listen<HotkeyEventPayload>("telepathy://hotkey", ({ payload }) => {
        if (!active) {
          return;
        }
        if (payload.shortcut) {
          setLastHotkey(payload.shortcut);
        }
        if (payload.state === "pressed") {
          if (!hotkeyDownRef.current) {
            hotkeyDownRef.current = true;
            void handleHotkeyPressed();
          }
        } else if (payload.state === "released") {
          hotkeyDownRef.current = false;
          void handleHotkeyReleased();
        }
      });
    };

    void bind();
    return () => {
      active = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleHotkeyPressed, handleHotkeyReleased]);

  useEffect(() => {
    void checkAccessibility();
  }, [checkAccessibility]);

  useEffect(() => {
    overlayModeRef.current = onboardingComplete;
  }, [onboardingComplete]);

  useEffect(() => {
    const initWindowMode = async () => {
      try {
        await setOverlayPassthrough(false);
      } catch {
        setOnboardingError("Unable to initialize overlay window interaction mode.");
      }
    };
    void initWindowMode();
  }, [setOverlayPassthrough]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const startOverlayMode = useCallback(async () => {
    setOnboardingError("");
    if (!cameraReady) {
      setOnboardingError("Camera permission is still required.");
      return;
    }
    if (!accessibilityGranted) {
      setOnboardingError("Accessibility permission is still required for paste automation.");
      return;
    }

    try {
      await setOverlayPassthrough(true);
      setOnboardingComplete(true);
      setOverlayState("waiting");
      setOverlayDetail(`Hold ${HOTKEY_LABEL} to record.`);
      setTimedIdle(900);
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : "Unable to start overlay mode.");
    }
  }, [accessibilityGranted, cameraReady, setOverlayPassthrough, setTimedIdle]);

  const skipOnboarding = useCallback(async () => {
    try {
      await setOverlayPassthrough(true);
      setOnboardingComplete(true);
      setOverlayState("idle");
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : "Unable to skip onboarding.");
    }
  }, [setOverlayPassthrough]);

  const visible = overlayState !== "idle";
  const stateUi = useMemo(() => {
    switch (overlayState) {
      case "recording":
        return {
          label: "Listening",
          tone: "border-emerald-300/70 bg-emerald-500/20 text-emerald-100",
          dot: "bg-emerald-300 animate-pulse",
        };
      case "processing":
        return {
          label: "Transcribing",
          tone: "border-sky-300/70 bg-sky-500/20 text-sky-100",
          dot: "bg-sky-200 animate-pulse",
        };
      case "pasted":
        return {
          label: "Done",
          tone: "border-lime-300/70 bg-lime-500/20 text-lime-100",
          dot: "bg-lime-200",
        };
      case "waiting":
        return {
          label: "Waiting",
          tone: "border-amber-300/70 bg-amber-500/20 text-amber-100",
          dot: "bg-amber-200",
        };
      case "error":
        return {
          label: "Error",
          tone: "border-rose-300/70 bg-rose-500/20 text-rose-100",
          dot: "bg-rose-200",
        };
      default:
        return {
          label: "Idle",
          tone: "border-white/0 bg-white/0 text-white/0",
          dot: "bg-white/0",
        };
    }
  }, [overlayState]);

  const metaLine = overlayState === "pasted" && lastTranscript ? lastTranscript : overlayDetail;
  const cameraStatusLabel = cameraReady ? "Granted" : "Missing";
  const accessibilityStatusLabel = accessibilityGranted ? "Granted" : "Missing";

  return (
    <div className="h-full w-full text-slate-100">
      {!onboardingComplete && (
        <div className="h-full w-full rounded-2xl bg-slate-950/95">
          <div className="h-full overflow-y-auto px-4 py-4">
            <p
              data-tauri-drag-region
              className="cursor-grab text-xs font-semibold uppercase tracking-[0.18em] text-slate-300"
            >
              Telepathy Setup
            </p>
            <h1 className="mt-1 text-lg font-semibold">Permissions onboarding</h1>
            <p className="mt-2 text-sm text-slate-300">
              Grant macOS permissions once, then hold {lastHotkey || HOTKEY_LABEL} to record and
              release to paste transcription.
            </p>

            <div className="mt-4 space-y-3 text-sm">
              <div className="rounded-2xl border border-slate-500/30 bg-slate-800/80 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Camera</span>
                  <span className={statusTone(cameraReady)}>{cameraStatusLabel}</span>
                </div>
                <p className="mt-1 text-xs text-slate-300">
                  Needed to capture silent lip movement while the hotkey is held.
                </p>
                {cameraError && <p className="mt-2 text-xs text-rose-200">{cameraError}</p>}
                <div className="mt-2 flex gap-2">
                  <button
                    className="rounded-full bg-sky-500 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-400 disabled:opacity-60"
                    onClick={() => {
                      void requestCamera();
                    }}
                    disabled={requestingCamera}
                  >
                    {cameraReady ? "Re-check camera" : "Grant camera"}
                  </button>
                  <button
                    className="rounded-full border border-slate-400/50 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700/70"
                    onClick={() => {
                      void openPermissionSettings("camera");
                    }}
                  >
                    Open settings
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-500/30 bg-slate-800/80 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Accessibility</span>
                  <span className={statusTone(accessibilityGranted)}>
                    {accessibilityStatusLabel}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-300">
                  Needed to trigger Cmd+V paste into the active app after transcription.
                </p>
                {!accessibilityGranted && accessibilityDetail && (
                  <p className="mt-2 text-xs text-amber-100">{accessibilityDetail}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    className="rounded-full bg-sky-500 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-400"
                    onClick={() => {
                      void openPermissionSettings("accessibility");
                    }}
                  >
                    Open settings
                  </button>
                  <button
                    className="rounded-full border border-slate-400/50 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700/70 disabled:opacity-60"
                    onClick={() => {
                      void checkAccessibility();
                    }}
                    disabled={checkingAccessibility}
                  >
                    {checkingAccessibility ? "Checking..." : "Check access"}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-500/30 bg-slate-800/80 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Backend</span>
                  <span
                    className={
                      serverState === "ready" ? "text-emerald-200" : "text-amber-200"
                    }
                  >
                    {serverState}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-300">
                  Run `.venv/bin/uvicorn server.main:app --reload` before using hotkey capture.
                </p>
              </div>
            </div>

            {onboardingError && <p className="mt-3 text-xs text-rose-200">{onboardingError}</p>}

            <button
              className="mt-4 w-full rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
              onClick={() => {
                void startOverlayMode();
              }}
              disabled={!cameraReady || !accessibilityGranted}
            >
              Start Overlay Mode
            </button>
            {DEV_SKIP && (
              <button
                className="mt-2 w-full rounded-full border border-slate-500/50 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-700/70"
                onClick={() => {
                  void skipOnboarding();
                }}
              >
                Skip (dev)
              </button>
            )}
          </div>
        </div>
      )}

      <div
        className={`pointer-events-none fixed inset-0 flex items-start justify-center pt-6 transition duration-150 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div
          className={`w-[420px] rounded-full border px-4 py-3 shadow-2xl backdrop-blur-xl ${stateUi.tone}`}
        >
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${stateUi.dot}`} />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold uppercase tracking-[0.2em]">
                {stateUi.label}
              </p>
              <p className="truncate text-sm font-medium">{metaLine}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="sr-only">
        Hotkey: {lastHotkey || HOTKEY_LABEL} | Server: {serverState}
      </div>
    </div>
  );
}

export default App;
