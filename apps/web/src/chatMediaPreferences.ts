import type { Model } from "./types.ts";

export const SPEECH_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

export type SpeechVoice = (typeof SPEECH_VOICES)[number];

export function isSpeechVoice(value: string): value is SpeechVoice {
  return SPEECH_VOICES.includes(value as SpeechVoice);
}

/**
 * Reconciles a persisted media-model preference with the current catalog. An empty catalog means
 * model discovery is still unresolved, so the persisted value must not be erased prematurely.
 */
export function availableMediaModel(
  models: readonly Model[],
  capability: "speech" | "transcription",
  selected: string,
): string {
  if (models.length === 0) return selected;
  const available = models.filter((model) => model.capabilities.includes(capability));
  return available.some((model) => model.id === selected) ? selected : available[0]?.id ?? "";
}
