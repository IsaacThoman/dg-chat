export const SCREEN_CAPTURE_MAX_DIMENSION = 4_096;
export const SCREEN_CAPTURE_MAX_PIXELS = 16_000_000;
export const SCREEN_CAPTURE_MAX_BYTES = 12 * 1024 * 1024;
const SCREEN_CAPTURE_MIN_DIMENSION = 320;
const FRAME_TIMEOUT_MS = 10_000;

export interface ScreenCaptureResult {
  file: File;
  width: number;
  height: number;
}

export function chatScreenCaptureTargetKey(input: {
  sessionActive: boolean;
  conversationId: string;
  leafId?: string | null;
  editId?: string | null;
  selectedModelId: string;
  visionCapable: boolean;
}): string {
  // JSON encoding prevents ambiguous delimiter collisions in provider/model and conversation IDs.
  return JSON.stringify([
    input.sessionActive,
    input.conversationId,
    input.leafId ?? "",
    input.editId ?? "",
    input.selectedModelId,
    input.visionCapable,
  ]);
}

export function stopDisplayStream(stream?: Pick<MediaStream, "getTracks"> | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // A browser may throw when an already-ended display track is stopped again.
    }
  }
}

export function boundedCaptureDimensions(
  sourceWidth: number,
  sourceHeight: number,
  scale = 1,
): { width: number; height: number } {
  if (
    !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 ||
    sourceHeight <= 0 || !Number.isFinite(scale) || scale <= 0 || scale > 1
  ) throw new Error("The shared screen did not provide a usable video frame.");
  const dimensionScale = Math.min(
    1,
    SCREEN_CAPTURE_MAX_DIMENSION / sourceWidth,
    SCREEN_CAPTURE_MAX_DIMENSION / sourceHeight,
    Math.sqrt(SCREEN_CAPTURE_MAX_PIXELS / (sourceWidth * sourceHeight)),
  );
  // Floor both axes: rounding either side upward can violate the exact decoded-pixel ceiling even
  // when the continuous scaling calculation is correct (for example 7999 × 8001).
  let width = Math.min(
    SCREEN_CAPTURE_MAX_DIMENSION,
    Math.max(1, Math.floor(sourceWidth * dimensionScale * scale)),
  );
  let height = Math.min(
    SCREEN_CAPTURE_MAX_DIMENSION,
    Math.max(1, Math.floor(sourceHeight * dimensionScale * scale)),
  );
  // Defend the invariant independently of floating-point behavior at the square-root boundary.
  if (width * height > SCREEN_CAPTURE_MAX_PIXELS) {
    if (width >= height) width = Math.max(1, Math.floor(SCREEN_CAPTURE_MAX_PIXELS / height));
    else height = Math.max(1, Math.floor(SCREEN_CAPTURE_MAX_PIXELS / width));
  }
  return { width, height };
}

export function screenCaptureResultIsUsable(
  capturedTargetKey: string,
  currentTargetKey: string,
  eligible: boolean,
): boolean {
  return eligible && capturedTargetKey === currentTargetKey;
}

export function screenCaptureErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Screen sharing was cancelled or denied. Nothing was captured.";
    }
    if (error.name === "NotFoundError") {
      return "No screen or window is available to share.";
    }
    if (error.name === "NotReadableError") {
      return "The selected screen could not be read. Close other capture tools and try again.";
    }
    if (error.name === "AbortError") return "Screen capture was cancelled.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "The screen could not be captured. Try again.";
}

function waitForVideoFrame(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("The shared screen did not produce a frame in time."));
    }, FRAME_TIMEOUT_MS);
    const ready = () => {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("The shared screen stopped before a frame was captured."));
    };
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("error", failed);
      for (const track of stream.getTracks()) track.removeEventListener("ended", failed);
    };
    video.addEventListener("loadeddata", ready);
    video.addEventListener("canplay", ready);
    video.addEventListener("error", failed);
    for (const track of stream.getTracks()) track.addEventListener("ended", failed, { once: true });
  });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The captured frame could not be encoded."));
    }, "image/png");
  });
}

function captureFilename(now: Date): string {
  return `screen-capture-${now.toISOString().replaceAll(":", "-").replace(".000Z", "Z")}.png`;
}

/**
 * Captures one frame from an already-authorized display stream. Ownership of the stream remains
 * with the caller, which must stop it in a finally block even if this function rejects.
 */
export async function captureDisplayFrame(
  stream: MediaStream,
  now = new Date(),
): Promise<ScreenCaptureResult> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    await waitForVideoFrame(video, stream);
    let scale = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { width, height } = boundedCaptureDimensions(
        video.videoWidth,
        video.videoHeight,
        scale,
      );
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser cannot encode a screen capture.");
      context.drawImage(video, 0, 0, width, height);
      const blob = await canvasPng(canvas);
      if (blob.size <= SCREEN_CAPTURE_MAX_BYTES) {
        return {
          file: new File([blob], captureFilename(now), {
            type: "image/png",
            lastModified: now.getTime(),
          }),
          width,
          height,
        };
      }
      if (Math.min(width, height) <= SCREEN_CAPTURE_MIN_DIMENSION) break;
      scale *= 0.72;
    }
    throw new Error(
      "The screenshot is too detailed to attach. Share a smaller window and try again.",
    );
  } finally {
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
  }
}
