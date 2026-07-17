import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Camera, Check, MonitorUp, RotateCcw } from "lucide-react";
import { ChatSessionActivityContext } from "../chatSessionActivity.ts";
import { Modal } from "../Modal.tsx";
import {
  captureDisplayFrame,
  screenCaptureErrorMessage,
  type ScreenCaptureResult,
  screenCaptureResultIsUsable,
  stopDisplayStream,
} from "./captureDisplay.ts";

type CapturePhase = "idle" | "requesting" | "preview" | "error";

export function ScreenCapture({
  disabled,
  visionCapable,
  targetKey,
  onCapture,
  onBusyChange,
}: {
  disabled?: boolean;
  visionCapable: boolean;
  targetKey: string;
  onCapture: (file: File) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const sessionActive = useContext(ChatSessionActivityContext);
  const supported = typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const eligible = sessionActive && !disabled && visionCapable && supported;
  const unavailableReason = !visionCapable
    ? "the selected model does not support images"
    : !supported
    ? "screen sharing is not supported by this browser"
    : undefined;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<CapturePhase>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScreenCaptureResult>();
  const [previewUrl, setPreviewUrl] = useState("");
  const previewUrlRef = useRef("");
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const requestRef = useRef(0);
  const targetKeyRef = useRef(targetKey);
  const eligibleRef = useRef(eligible);
  targetKeyRef.current = targetKey;
  eligibleRef.current = eligible;
  const captureIdentity = `${targetKey}:${visionCapable}:${Boolean(disabled)}:${supported}`;
  const previousCaptureIdentityRef = useRef(captureIdentity);
  const resultTargetRef = useRef("");
  const phaseActionRef = useRef<HTMLButtonElement>(null);
  const busyCallbackRef = useRef(onBusyChange);
  busyCallbackRef.current = onBusyChange;

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = "";
    setPreviewUrl("");
    setResult(undefined);
    resultTargetRef.current = "";
  }, []);

  const cancel = useCallback(() => {
    requestRef.current++;
    stopDisplayStream(streamRef.current);
    streamRef.current = undefined;
    clearPreview();
    setError("");
    setPhase("idle");
    setOpen(false);
  }, [clearPreview]);

  useEffect(() => () => {
    requestRef.current++;
    stopDisplayStream(streamRef.current);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    busyCallbackRef.current?.(false);
  }, []);
  useEffect(() => {
    onBusyChange?.(open);
  }, [onBusyChange, open]);
  useEffect(() => {
    if (sessionActive) return;
    cancel();
  }, [cancel, sessionActive]);
  useEffect(() => {
    if (previousCaptureIdentityRef.current === captureIdentity) return;
    previousCaptureIdentityRef.current = captureIdentity;
    cancel();
  }, [cancel, captureIdentity]);
  useEffect(() => {
    if (!open || !sessionActive) return;
    const frame = requestAnimationFrame(() => phaseActionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, phase, sessionActive]);

  const capture = async () => {
    if (!eligibleRef.current || phase === "requesting") return;
    clearPreview();
    setError("");
    setPhase("requesting");
    const request = ++requestRef.current;
    const requestedTargetKey = targetKeyRef.current;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1, max: 5 } },
        audio: false,
      });
      if (
        request !== requestRef.current ||
        !screenCaptureResultIsUsable(
          requestedTargetKey,
          targetKeyRef.current,
          eligibleRef.current,
        )
      ) return;
      streamRef.current = stream;
      const captured = await captureDisplayFrame(stream);
      if (
        request !== requestRef.current ||
        !screenCaptureResultIsUsable(
          requestedTargetKey,
          targetKeyRef.current,
          eligibleRef.current,
        )
      ) return;
      const url = URL.createObjectURL(captured.file);
      previewUrlRef.current = url;
      resultTargetRef.current = requestedTargetKey;
      setResult(captured);
      setPreviewUrl(url);
      setPhase("preview");
    } catch (reason) {
      if (
        request !== requestRef.current ||
        !screenCaptureResultIsUsable(
          requestedTargetKey,
          targetKeyRef.current,
          eligibleRef.current,
        )
      ) return;
      setError(screenCaptureErrorMessage(reason));
      setPhase("error");
    } finally {
      stopDisplayStream(stream);
      if (streamRef.current === stream) streamRef.current = undefined;
    }
  };

  const useCapture = () => {
    if (
      !result ||
      !screenCaptureResultIsUsable(
        resultTargetRef.current,
        targetKeyRef.current,
        eligibleRef.current,
      )
    ) {
      cancel();
      return;
    }
    const file = result.file;
    cancel();
    onCapture(file);
  };

  return (
    <>
      <button
        type="button"
        className="tool-pill"
        aria-label={unavailableReason
          ? `Capture screen unavailable: ${unavailableReason}`
          : "Capture screen"}
        title={unavailableReason ? `Screen capture unavailable: ${unavailableReason}.` : undefined}
        disabled={disabled || Boolean(unavailableReason)}
        onClick={() => {
          setError("");
          setPhase("idle");
          setOpen(true);
        }}
      >
        <MonitorUp size={16} aria-hidden="true" /> Capture
      </button>
      {open && (
        <Modal title="Capture your screen" close={cancel} variant="medium">
          <div className="screen-capture-dialog">
            {phase === "idle" && (
              <>
                <div className="screen-capture-intro" aria-hidden="true">
                  <Camera size={28} />
                </div>
                <p className="modal-description">
                  Choose a screen, window, or browser tab. DG Chat captures one still image, then
                  immediately stops screen sharing. You can review it before anything uploads.
                </p>
              </>
            )}
            {phase === "requesting" && (
              <div className="screen-capture-wait" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <strong>Waiting for your screen selection…</strong>
                <small>Use the browser prompt to choose what to share.</small>
              </div>
            )}
            {phase === "preview" && result && previewUrl && (
              <figure className="screen-capture-preview">
                <img src={previewUrl} alt="Preview of the captured screen" />
                <figcaption role="status" aria-live="polite">
                  Screenshot ready · {result.width} × {result.height} ·{" "}
                  {Math.max(1, Math.ceil(result.file.size / 1024))} KB
                </figcaption>
              </figure>
            )}
            {phase === "error" && (
              <div className="screen-capture-error" role="alert">
                <strong>Nothing was attached</strong>
                <span>{error}</span>
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button
              ref={phase === "requesting" ? phaseActionRef : undefined}
              type="button"
              className="secondary"
              onClick={cancel}
            >
              Cancel
            </button>
            {(phase === "idle" || phase === "error") && (
              <button
                ref={phaseActionRef}
                type="button"
                className="primary"
                data-autofocus
                onClick={() => void capture()}
              >
                {phase === "error" ? <RotateCcw size={15} /> : <MonitorUp size={15} />}
                {phase === "error" ? "Try again" : "Choose screen"}
              </button>
            )}
            {phase === "preview" && (
              <>
                <button type="button" className="secondary" onClick={() => void capture()}>
                  <RotateCcw size={15} /> Retake
                </button>
                <button
                  ref={phaseActionRef}
                  type="button"
                  className="primary"
                  onClick={useCapture}
                >
                  <Check size={15} /> Use screenshot
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
