export interface ClipboardWriteCallbacks {
  onStart?: () => void;
  onSuccess: () => void;
  onFailure: () => void;
  onClearSuccess: () => void;
}

/**
 * Serializes clipboard feedback without serializing the browser clipboard itself.
 * Only the most recently started write may publish success/failure state, and an
 * older success timer can never clear feedback from a newer write.
 */
export class LatestClipboardOperation {
  #generation = 0;
  #successTimer: ReturnType<typeof setTimeout> | null = null;

  async write(
    text: string,
    writeText: (value: string) => Promise<void>,
    callbacks: ClipboardWriteCallbacks,
    successDurationMs = 1_500,
  ): Promise<void> {
    const generation = ++this.#generation;
    this.#clearTimer();
    callbacks.onStart?.();
    try {
      await writeText(text);
      if (generation !== this.#generation) return;
      callbacks.onSuccess();
      this.#successTimer = setTimeout(() => {
        this.#successTimer = null;
        if (generation === this.#generation) callbacks.onClearSuccess();
      }, successDurationMs);
    } catch {
      if (generation === this.#generation) callbacks.onFailure();
    }
  }

  dispose(): void {
    this.#generation += 1;
    this.#clearTimer();
  }

  #clearTimer(): void {
    if (this.#successTimer === null) return;
    clearTimeout(this.#successTimer);
    this.#successTimer = null;
  }
}
