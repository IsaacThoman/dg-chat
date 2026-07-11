export interface AudioTranscriptVisibility {
  deltaCharacters: number;
  segmentCharacters: number;
  sawDelta: boolean;
}

export function createAudioTranscriptVisibility(): AudioTranscriptVisibility {
  return { deltaCharacters: 0, segmentCharacters: 0, sawDelta: false };
}

/**
 * Tracks one canonical transcript representation. Providers may emit both incremental deltas
 * and diarized segment snapshots for the same words; deltas win as soon as one is observed.
 */
export function observeAudioTranscriptFrame(
  frame: string,
  state: AudioTranscriptVisibility,
): { totalCharacters: number; newVisibleCharacters: number } {
  const previous = state.sawDelta ? state.deltaCharacters : state.segmentCharacters;
  try {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === "transcript.text.delta" && typeof event.delta === "string") {
      state.sawDelta = true;
      state.deltaCharacters = Math.min(33_554_432, state.deltaCharacters + event.delta.length);
    } else if (
      event.type === "transcript.text.segment" && typeof event.text === "string" &&
      !state.sawDelta
    ) {
      state.segmentCharacters = Math.min(
        33_554_432,
        state.segmentCharacters + event.text.length,
      );
    }
  } catch {
    // Frames are validated at the provider boundary. Zero is fail-safe for accounting callers.
  }
  const totalCharacters = state.sawDelta ? state.deltaCharacters : state.segmentCharacters;
  return {
    totalCharacters,
    newVisibleCharacters: Math.max(0, totalCharacters - previous),
  };
}
