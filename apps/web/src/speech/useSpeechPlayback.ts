import { useEffect, useRef, useSyncExternalStore } from "react";
import { SpeechPlaybackController, type SpeechPlaybackDependencies } from "./playback.ts";

export function useSpeechPlayback(dependencies?: SpeechPlaybackDependencies) {
  const controllerRef = useRef<SpeechPlaybackController | null>(null);
  if (!controllerRef.current) controllerRef.current = new SpeechPlaybackController(dependencies);
  const controller = controllerRef.current;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => () => controller.dispose(), [controller]);
  return { state, controller };
}
