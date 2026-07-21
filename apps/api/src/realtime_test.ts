import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  parseRealtimeEvent,
  proxyRealtimeHttp,
  REALTIME_MAX_EVENT_BYTES,
  realtimeProviderEndpoint,
  realtimeUsage,
  rewriteRealtimeModels,
} from "./realtime.ts";

Deno.test("Realtime endpoint construction preserves provider API roots and rejects path injection", () => {
  assertEquals(
    realtimeProviderEndpoint("https://provider.example/v1", "/realtime/calls").href,
    "https://provider.example/v1/realtime/calls",
  );
  assertThrows(() => realtimeProviderEndpoint("https://provider.example/v1", "/chat/completions"));
  assertThrows(() => realtimeProviderEndpoint("https://user@provider.example/v1", "/realtime"));
});

Deno.test("Realtime events are bounded JSON objects with a valid type", () => {
  assertEquals(parseRealtimeEvent('{"type":"response.create","event_id":"evt_1"}'), {
    type: "response.create",
    event_id: "evt_1",
  });
  assertThrows(() => parseRealtimeEvent("[]"));
  assertThrows(() => parseRealtimeEvent("{"));
  assertThrows(() => parseRealtimeEvent(JSON.stringify({ type: "x".repeat(161) })));
  assertThrows(() => parseRealtimeEvent(new Uint8Array(REALTIME_MAX_EVENT_BYTES + 1)));
});

Deno.test("Realtime model rewriting changes only exact model values", () => {
  assertEquals(
    rewriteRealtimeModels(
      {
        model: "public/realtime",
        session: { model: "public/realtime", instructions: "say public/realtime" },
        tools: [{ model: "different" }],
      },
      "public/realtime",
      "gpt-realtime",
    ),
    {
      model: "gpt-realtime",
      session: { model: "gpt-realtime", instructions: "say public/realtime" },
      tools: [{ model: "different" }],
    },
  );
});

Deno.test("Realtime terminal usage preserves text, audio, cached, and total token dimensions", () => {
  assertEquals(
    realtimeUsage({
      type: "response.done",
      response: {
        usage: {
          input_tokens: 12,
          input_token_details: { cached_tokens: 3, text_tokens: 4, audio_tokens: 8 },
          output_tokens: 7,
          output_token_details: { text_tokens: 2, audio_tokens: 5 },
        },
      },
    }),
    {
      inputTokens: 12,
      cachedInputTokens: 3,
      inputTextTokens: 4,
      inputAudioTokens: 8,
      outputTokens: 7,
      outputTextTokens: 2,
      outputAudioTokens: 5,
    },
  );
  assertEquals(realtimeUsage({ type: "response.audio.delta" }), undefined);
});

Deno.test("Realtime HTTP proxy injects provider auth, forbids redirects, and bounds bodies", async () => {
  let request: Request | undefined;
  const response = await proxyRealtimeHttp({
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-secret",
    path: "/realtime/calls",
    body: new TextEncoder().encode("offer"),
    headers: { "content-type": "application/sdp", authorization: "Bearer customer-token" },
    fetch: (input, init) => {
      request = new Request(input, init);
      return Promise.resolve(
        new Response("answer", {
          status: 201,
          headers: { "content-type": "application/sdp", location: "/v1/realtime/calls/call_1" },
        }),
      );
    },
  });
  assertEquals(request?.headers.get("authorization"), "Bearer provider-secret");
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("location"), "/v1/realtime/calls/call_1");
  assertEquals(await response.text(), "answer");

  await assertRejects(() =>
    proxyRealtimeHttp({
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      path: "/realtime/calls",
      fetch: () =>
        Promise.resolve(
          new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }),
        ),
    })
  );
});
