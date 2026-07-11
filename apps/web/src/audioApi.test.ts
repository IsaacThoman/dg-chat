import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioApiError, extensionForMime, transcribeAudio } from "./audioApi.ts";

afterEach(() => vi.unstubAllGlobals());

describe("transcribeAudio", () => {
  it("sends the OpenAI-compatible multipart request", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      expect(body.get("model")).toBe("provider/transcribe");
      expect(body.get("response_format")).toBe("json");
      expect(body.get("file")).toBeInstanceOf(Blob);
      expect(init.credentials).toBe("include");
      return Promise.resolve(
        new Response(JSON.stringify({ text: " hello " }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      transcribeAudio({
        audio: new Blob(["audio"], { type: "audio/webm" }),
        model: "provider/transcribe",
      }),
    ).resolves.toBe("hello");
  });

  it("preserves normalized OpenAI errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: "Not enough credit", code: "insufficient_credit" },
            }),
            { status: 402 },
          ),
        )
      ),
    );
    await expect(transcribeAudio({ audio: new Blob(["a"]), model: "m" })).rejects.toEqual(
      new AudioApiError(402, "insufficient_credit", "Not enough credit"),
    );
  });
});

it("chooses safe filename extensions from audio MIME types", () => {
  expect(extensionForMime("audio/ogg;codecs=opus")).toBe("ogg");
  expect(extensionForMime("audio/mp4")).toBe("m4a");
  expect(extensionForMime("")).toBe("webm");
});
