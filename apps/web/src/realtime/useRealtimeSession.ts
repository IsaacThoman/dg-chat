import { useEffect, useMemo, useState } from "react";
import { RealtimeSessionController } from "./realtimeClient.ts";

export function useRealtimeSession() {
  const controller = useMemo(() => new RealtimeSessionController(), []);
  const [state, setState] = useState(controller.state);
  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);
  return { controller, state };
}
