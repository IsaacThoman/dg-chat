import { useEffect, useRef, useSyncExternalStore } from "react";
import { SpeechPlaybackController, type SpeechPlaybackDependencies } from "./playback.ts";

export function useSpeechPlayback(dependencies?: SpeechPlaybackDependencies) {
  const controllerRef = useRef<SpeechPlaybackController | null>(null);
  if (!controllerRef.current) controllerRef.current = new SpeechPlaybackController(dependencies);
  const controller = controllerRef.current;
  const mountedRef = useRef(false);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // React Strict Mode immediately re-runs effects after a probe cleanup. Defer disposal by
      // one microtask so that probe can reclaim the same controller, while a real unmount still
      // releases its request, media element, listeners, and object URL.
      queueMicrotask(() => {
        if (!mountedRef.current) controller.dispose();
      });
    };
  }, [controller]);
  return { state, controller };
}
