import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeech, SpeechApiError } from "./speechApi.ts";

afterEach(() => vi.unstubAllGlobals());

describe("createSpeech", () => {
  it("sends the OpenAI-compatible JSON contract and accepts the requested audio type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        expect(init.credentials).toBe("include");
        expect(init.headers).toEqual({ "Content-Type": "application/json" });
        expect(JSON.parse(String(init.body))).toEqual({
          model: "provider/voice",
          input: "Hello",
          voice: "alloy",
          response_format: "opus",
          speed: 1.2,
        });
        return Promise.resolve(
          new Response(new Uint8Array([1, 2]), {
            headers: { "content-type": "audio/ogg; codecs=opus" },
          }),
        );
      }),
    );
    await expect(createSpeech({
      model: "provider/voice",
      input: "Hello",
      voice: "alloy",
      responseFormat: "opus",
      speed: 1.2,
    })).resolves.toMatchObject({ size: 2 });
  });

  it("bounds OpenAI errors and rejects non-audio success bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "insufficient_credit", message: "Not enough credit" },
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          ),
        )
      ),
    );
    await expect(createSpeech({ model: "m", input: "x", voice: "v" })).rejects.toEqual(
      new SpeechApiError(402, "insufficient_credit", "Not enough credit"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("html", {
            headers: { "content-type": "text/html" },
          }),
        )
      ),
    );
    await expect(createSpeech({ model: "m", input: "x", voice: "v" })).rejects.toMatchObject({
      code: "invalid_speech_response",
      status: 502,
    });
  });

  it("passes AbortSignal through without translating AbortError", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        return Promise.reject(new DOMException("cancelled", "AbortError"));
      }),
    );
    const promise = createSpeech({ model: "m", input: "x", voice: "v", signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects invalid client input without issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSpeech({ model: "m", input: " ", voice: "v" })).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    await expect(createSpeech({ model: "m", input: "x", voice: "v", speed: 5 })).rejects
      .toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not parse oversized provider error objects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("x", {
            status: 503,
            headers: { "content-type": "application/json", "content-length": "40000" },
          }),
        )
      ),
    );
    await expect(createSpeech({ model: "m", input: "x", voice: "v" })).rejects.toEqual(
      new SpeechApiError(503, "speech_failed", "Speech generation failed (503)."),
    );
  });
});
