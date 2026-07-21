/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { activeChatSession, bootstrap, createChat, login } from "./helpers.ts";

declare global {
  interface Window {
    __realtimeChannel?: EventTarget & { readyState: RTCDataChannelState };
    __realtimePeer?: EventTarget & { connectionState: RTCPeerConnectionState };
    __realtimeSent: string[];
    __realtimeTrackStops: number;
  }
}

test("Realtime voice connects, streams transcripts, interrupts, reconnects, and cleans up", async ({ page, request }) => {
  await bootstrap(request);
  await page.addInitScript(() => {
    globalThis.__realtimeSent = [];
    globalThis.__realtimeTrackStops = 0;
    const track = Object.assign(new EventTarget(), {
      kind: "audio",
      stop: () => globalThis.__realtimeTrackStops++,
    });
    const stream = {
      active: true,
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });

    class TestDataChannel extends EventTarget {
      readyState: RTCDataChannelState = "open";
      send(data: string) {
        globalThis.__realtimeSent.push(data);
      }
      close() {
        this.readyState = "closed";
      }
    }
    class TestPeerConnection extends EventTarget {
      iceGatheringState: RTCIceGatheringState = "complete";
      connectionState: RTCPeerConnectionState = "new";
      localDescription: RTCSessionDescription | null = null;
      createDataChannel() {
        const channel = new TestDataChannel();
        globalThis.__realtimeChannel = channel;
        queueMicrotask(() => channel.dispatchEvent(new Event("open")));
        return channel as unknown as RTCDataChannel;
      }
      addTrack() {}
      createOffer() {
        return Promise.resolve({ type: "offer" as const, sdp: "v=0\r\ne2e-offer" });
      }
      setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description as RTCSessionDescription;
        return Promise.resolve();
      }
      setRemoteDescription() {
        this.connectionState = "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
        return Promise.resolve();
      }
      close() {
        this.connectionState = "closed";
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: class extends TestPeerConnection {
        constructor() {
          super();
          globalThis.__realtimePeer = this;
        }
      },
    });
  });
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { data: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        data: [...payload.data, {
          id: "e2e/realtime",
          displayName: "E2E Realtime",
          provider: "e2e",
          capabilities: ["realtime"],
          contextWindow: 32_000,
        }],
      },
    });
  });
  let calls = 0;
  let hangups = 0;
  let multipart = "";
  await page.route("**/api/realtime/calls", async (route) => {
    calls += 1;
    multipart = route.request().postDataBuffer()?.toString("utf8") ?? "";
    await route.fulfill({
      status: 201,
      contentType: "application/sdp",
      headers: { location: `/api/realtime/calls/e2e-call-${calls}` },
      body: "v=0\r\ne2e-answer",
    });
  });
  await page.route("**/api/realtime/calls/*/hangup", async (route) => {
    hangups += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });

  await login(page);
  await createChat(page);
  const session = activeChatSession(page);
  const start = session.getByRole("button", { name: "Start realtime voice conversation" });
  await expect(start).toBeVisible();
  await start.click();
  const voice = session.getByRole("region", { name: "Realtime voice conversation" });
  await expect(voice.getByRole("status")).toHaveText("Live");
  expect(calls).toBe(1);
  expect(multipart).toContain("e2e/realtime");
  expect(multipart).toContain("semantic_vad");
  expect(multipart).toContain("e2e-offer");

  await page.evaluate(() => {
    globalThis.__realtimeChannel?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.output_audio_transcript.delta",
          delta: "Reliable transcript",
        }),
      }),
    );
  });
  await expect(session.getByText("Reliable transcript", { exact: true })).toBeVisible();
  await session.getByRole("button", { name: "Interrupt", exact: true }).click();
  expect(
    await page.evaluate(() => globalThis.__realtimeSent.map((event) => JSON.parse(event).type)),
  ).toContain("response.cancel");

  await page.evaluate(() => {
    if (!globalThis.__realtimePeer) return;
    globalThis.__realtimePeer.connectionState = "failed";
    globalThis.__realtimePeer.dispatchEvent(new Event("connectionstatechange"));
  });
  await expect(voice.getByRole("status")).toContainText("Reconnecting (1/3)");
  await expect.poll(() => calls).toBe(2);
  await expect(voice.getByRole("status")).toHaveText("Live");
  expect(hangups).toBe(1);

  await session.getByRole("button", { name: "End", exact: true }).click();
  await expect(start).toBeVisible();
  await expect.poll(() => hangups).toBe(2);
  expect(await page.evaluate(() => globalThis.__realtimeTrackStops)).toBe(1);
});
