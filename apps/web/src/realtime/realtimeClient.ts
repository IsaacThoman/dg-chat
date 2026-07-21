export type RealtimeConnectionPhase =
  | "idle"
  | "requesting_microphone"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopping"
  | "error";

export interface RealtimeConnectionState {
  phase: RealtimeConnectionPhase;
  model: string;
  transcript: string;
  error?: string;
  reconnectAttempt: number;
}

export interface RealtimeClientDependencies {
  fetch: typeof fetch;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
  createAudio: () => HTMLAudioElement;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

const defaultDependencies = (): RealtimeClientDependencies => ({
  fetch: globalThis.fetch.bind(globalThis),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createPeerConnection: () => new RTCPeerConnection(),
  createAudio: () => document.createElement("audio"),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});

const MAX_RECONNECT_ATTEMPTS = 3;
const ICE_GATHER_TIMEOUT_MS = 5_000;

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message.slice(0, 500);
  } catch {
    // The stable fallback does not reflect arbitrary HTML/provider response bodies.
  }
  return `Realtime connection failed (${response.status}).`;
}

function waitForIce(
  peer: RTCPeerConnection,
  dependencies: RealtimeClientDependencies,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = dependencies.setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    function finish() {
      dependencies.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === "complete") finish();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

function realtimeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Microphone permission was denied.";
    if (error.name === "NotFoundError") return "No microphone was found.";
    if (error.name === "NotReadableError") return "The microphone is busy or unavailable.";
  }
  return error instanceof Error ? error.message.slice(0, 500) : "Realtime connection failed.";
}

/** Owns one browser WebRTC media session and its reliable ordered OpenAI event data channel. */
export class RealtimeSessionController {
  #state: RealtimeConnectionState = {
    phase: "idle",
    model: "",
    transcript: "",
    reconnectAttempt: 0,
  };
  #listeners = new Set<(state: RealtimeConnectionState) => void>();
  #peer: RTCPeerConnection | null = null;
  #channel: RTCDataChannel | null = null;
  #microphone: MediaStream | null = null;
  #audio: HTMLAudioElement | null = null;
  #callLocation = "";
  #desiredModel = "";
  #epoch = 0;
  #reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #disposed = false;

  constructor(private readonly dependencies = defaultDependencies()) {}

  get state(): RealtimeConnectionState {
    return this.#state;
  }

  subscribe(listener: (state: RealtimeConnectionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  async start(model: string): Promise<void> {
    const selected = model.trim();
    if (!selected || this.#disposed) return;
    this.#desiredModel = selected;
    this.#state = {
      phase: "requesting_microphone",
      model: selected,
      transcript: "",
      reconnectAttempt: 0,
    };
    this.#emit();
    await this.#connect(false);
  }

  interrupt(): void {
    this.#send({ type: "response.cancel" });
  }

  sendText(text: string): void {
    const value = text.trim();
    if (!value) return;
    this.#send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: value }] },
    });
    this.#send({ type: "response.create" });
  }

  async stop(): Promise<void> {
    this.#desiredModel = "";
    this.#epoch += 1;
    this.#set({ phase: "stopping", error: undefined });
    await this.#teardown(true);
    this.#set({ phase: "idle", model: "", transcript: "", reconnectAttempt: 0 });
  }

  dispose(): void {
    this.#disposed = true;
    this.#desiredModel = "";
    this.#epoch += 1;
    void this.#teardown(true);
    this.#listeners.clear();
  }

  async #connect(reconnecting: boolean): Promise<void> {
    const epoch = ++this.#epoch;
    try {
      if (!reconnecting) {
        this.#microphone = await this.dependencies.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } else if (!this.#microphone?.active) {
        this.#microphone = await this.dependencies.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }
      if (epoch !== this.#epoch || !this.#desiredModel) return;
      this.#set({ phase: reconnecting ? "reconnecting" : "connecting", error: undefined });
      const peer = this.dependencies.createPeerConnection();
      this.#peer = peer;
      for (const track of this.#microphone.getTracks()) peer.addTrack(track, this.#microphone);
      const audio = this.dependencies.createAudio();
      audio.autoplay = true;
      this.#audio = audio;
      peer.addEventListener("track", (event) => {
        if (epoch !== this.#epoch) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => undefined);
      });
      const channel = peer.createDataChannel("oai-events", { ordered: true });
      this.#channel = channel;
      channel.addEventListener("open", () => {
        if (epoch !== this.#epoch) return;
        this.#set({ phase: "connected", reconnectAttempt: 0, error: undefined });
      });
      channel.addEventListener("message", (event) => this.#serverEvent(event.data, epoch));
      channel.addEventListener("error", () => this.#scheduleReconnect(epoch));
      peer.addEventListener("connectionstatechange", () => {
        if (epoch !== this.#epoch) return;
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
          this.#scheduleReconnect(epoch);
        } else if (peer.connectionState === "connected") {
          this.#set({ phase: "connected", reconnectAttempt: 0, error: undefined });
        }
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer, this.dependencies);
      if (epoch !== this.#epoch) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("The browser did not produce a WebRTC offer.");
      const form = new FormData();
      form.set("sdp", new Blob([sdp], { type: "application/sdp" }), "offer.sdp");
      form.set(
        "session",
        new Blob([JSON.stringify({
          type: "realtime",
          model: this.#desiredModel,
          output_modalities: ["audio"],
          audio: {
            input: {
              turn_detection: {
                type: "semantic_vad",
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { voice: "alloy" },
          },
        })], { type: "application/json" }),
        "session.json",
      );
      const response = await this.dependencies.fetch("/api/realtime/calls", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const location = response.headers.get("location") ?? "";
      if (!location.startsWith("/api/realtime/calls/") || location.includes("..")) {
        throw new Error("Realtime call control location is invalid.");
      }
      this.#callLocation = location;
      const answer = await response.text();
      if (!answer.trim()) throw new Error("Realtime provider returned an empty WebRTC answer.");
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      if (epoch !== this.#epoch || !this.#desiredModel) return;
      await this.#teardown(false);
      this.#set({ phase: "error", error: realtimeError(error) });
    }
  }

  #serverEvent(data: unknown, epoch: number): void {
    if (epoch !== this.#epoch || typeof data !== "string" || data.length > 1_048_576) return;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      if (
        event.type === "response.output_audio_transcript.delta" && typeof event.delta === "string"
      ) {
        this.#set({ transcript: (this.#state.transcript + event.delta).slice(-20_000) });
      } else if (event.type === "error") {
        const error = event.error as { message?: unknown } | undefined;
        if (typeof error?.message === "string") this.#set({ error: error.message.slice(0, 500) });
      }
    } catch {
      // Invalid provider events are ignored by the UI; the server sideband enforces the protocol.
    }
  }

  #send(event: Record<string, unknown>): void {
    if (this.#channel?.readyState !== "open") return;
    this.#channel.send(JSON.stringify(event));
  }

  #scheduleReconnect(epoch: number): void {
    if (epoch !== this.#epoch || !this.#desiredModel || this.#reconnectTimer !== undefined) return;
    const attempt = this.#state.reconnectAttempt + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      this.#set({
        phase: "error",
        error: "Realtime connection was lost. Start it again to retry.",
      });
      return;
    }
    this.#set({ phase: "reconnecting", reconnectAttempt: attempt });
    this.#reconnectTimer = this.dependencies.setTimeout(async () => {
      this.#reconnectTimer = undefined;
      await this.#teardown(false);
      if (this.#desiredModel) await this.#connect(true);
    }, Math.min(4_000, 500 * 2 ** (attempt - 1)));
  }

  async #teardown(stopMicrophone: boolean): Promise<void> {
    if (this.#reconnectTimer !== undefined) {
      this.dependencies.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#channel?.close();
    this.#channel = null;
    this.#peer?.close();
    this.#peer = null;
    if (this.#audio) {
      this.#audio.pause();
      this.#audio.srcObject = null;
      this.#audio = null;
    }
    const location = this.#callLocation;
    this.#callLocation = "";
    if (location) {
      await this.dependencies.fetch(`${location}/hangup`, {
        method: "POST",
        credentials: "include",
        keepalive: true,
      }).catch(() => undefined);
    }
    if (stopMicrophone) {
      for (const track of this.#microphone?.getTracks() ?? []) track.stop();
      this.#microphone = null;
    }
  }

  #set(patch: Partial<RealtimeConnectionState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }
}
