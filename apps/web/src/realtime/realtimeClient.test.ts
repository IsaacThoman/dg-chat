import { describe, expect, it, vi } from "vitest";
import { RealtimeSessionController } from "./realtimeClient.ts";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  sent: string[] = [];
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
  server(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channel = new FakeDataChannel();
  addTrack() {}
  createDataChannel() {
    return this.channel as unknown as RTCDataChannel;
  }
  createOffer() {
    return Promise.resolve({ type: "offer" as const, sdp: "v=0\r\noffer" });
  }
  setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    return Promise.resolve();
  }
  setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    return Promise.resolve();
  }
  close() {
    this.connectionState = "closed";
  }
}

describe("RealtimeSessionController", () => {
  it("creates a WebRTC call, uses reliable JSON events, observes transcripts, and hangs up", async () => {
    const peer = new FakePeer();
    const stop = vi.fn();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });
      return Promise.resolve(
        url.endsWith("/hangup")
          ? new Response(JSON.stringify({ ok: true }))
          : new Response("v=0\r\nanswer", {
            status: 201,
            headers: {
              "content-type": "application/sdp",
              location: "/api/realtime/calls/local-call-token",
            },
          }),
      );
    });
    const controller = new RealtimeSessionController({
      fetch: request as unknown as typeof fetch,
      getUserMedia: () =>
        Promise.resolve({
          active: true,
          getTracks: () => [{ stop }],
        } as unknown as MediaStream),
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudio: () =>
        ({
          autoplay: false,
          srcObject: null,
          play: () => Promise.resolve(),
          pause: vi.fn(),
        }) as unknown as HTMLAudioElement,
      setTimeout,
      clearTimeout,
    });
    await controller.start("vendor/realtime");
    expect(requests[0].url).toBe("/api/realtime/calls");
    expect(requests[0].init?.credentials).toBe("include");
    const form = requests[0].init?.body as FormData;
    expect(await (form.get("sdp") as File).text()).toBe("v=0\r\noffer");
    expect(JSON.parse(await (form.get("session") as File).text())).toMatchObject({
      type: "realtime",
      model: "vendor/realtime",
      output_modalities: ["audio"],
      audio: { input: { turn_detection: { type: "semantic_vad", interrupt_response: true } } },
    });
    expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "v=0\r\nanswer" });

    peer.channel.open();
    expect(controller.state.phase).toBe("connected");
    controller.sendText("hello");
    controller.interrupt();
    expect(peer.channel.sent.map((value) => JSON.parse(value).type)).toEqual([
      "conversation.item.create",
      "response.create",
      "response.cancel",
    ]);
    peer.channel.server({ type: "response.output_audio_transcript.delta", delta: "Hi there" });
    expect(controller.state.transcript).toBe("Hi there");

    await controller.stop();
    expect(requests.at(-1)?.url).toBe("/api/realtime/calls/local-call-token/hangup");
    expect(requests.at(-1)?.init?.keepalive).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(controller.state.phase).toBe("idle");
  });

  it("fails closed on a cross-origin or malformed call-control location", async () => {
    const peer = new FakePeer();
    const controller = new RealtimeSessionController({
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response("answer", {
            status: 201,
            headers: { location: "https://attacker.example/call" },
          }),
        )
      ) as unknown as typeof fetch,
      getUserMedia: () =>
        Promise.resolve({
          active: true,
          getTracks: () => [],
        } as unknown as MediaStream),
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudio: () => ({ pause() {} }) as HTMLAudioElement,
      setTimeout,
      clearTimeout,
    });
    await controller.start("vendor/realtime");
    expect(controller.state).toMatchObject({
      phase: "error",
      error: "Realtime call control location is invalid.",
    });
  });
});
