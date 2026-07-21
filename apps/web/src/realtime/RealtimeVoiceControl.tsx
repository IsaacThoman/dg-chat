import { AudioLines, Mic, PhoneOff, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { Model } from "../types.ts";
import { useRealtimeSession } from "./useRealtimeSession.ts";

export function RealtimeVoiceControl({ models, disabled = false }: {
  models: Model[];
  disabled?: boolean;
}) {
  const { controller, state } = useRealtimeSession();
  const [selected, setSelected] = useState(models[0]?.id || "");
  useEffect(() => {
    if (!models.some((model) => model.id === selected)) setSelected(models[0]?.id || "");
  }, [models, selected]);
  if (models.length === 0) return null;
  const active = !["idle", "error"].includes(state.phase);
  return (
    <div className={`realtime-voice ${active ? "active" : ""}`}>
      {!active && (
        <>
          {models.length > 1 && (
            <select
              aria-label="Realtime voice model"
              value={selected}
              disabled={disabled}
              onChange={(event) => setSelected(event.target.value)}
            >
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          )}
          <button
            type="button"
            className="tool-pill realtime-start"
            disabled={disabled || !selected}
            onClick={() => void controller.start(selected)}
            aria-label="Start realtime voice conversation"
          >
            <Mic size={16} /> Live voice
          </button>
        </>
      )}
      {active && (
        <div
          className="realtime-session-panel"
          role="region"
          aria-label="Realtime voice conversation"
        >
          <span className="realtime-pulse" aria-hidden="true">
            <AudioLines size={16} />
          </span>
          <span role="status" aria-live="polite">
            {state.phase === "connected"
              ? "Live"
              : state.phase === "requesting_microphone"
              ? "Microphone permission…"
              : state.phase === "reconnecting"
              ? `Reconnecting (${state.reconnectAttempt}/3)…`
              : "Connecting…"}
          </span>
          <button type="button" className="secondary" onClick={() => controller.interrupt()}>
            <Square size={14} /> Interrupt
          </button>
          <button type="button" className="danger" onClick={() => void controller.stop()}>
            <PhoneOff size={14} /> End
          </button>
          {state.transcript && <p aria-live="polite">{state.transcript}</p>}
        </div>
      )}
      {state.phase === "error" && <small role="alert">{state.error}</small>}
    </div>
  );
}
