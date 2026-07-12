import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import {
  providerDiagnosticBody,
  providerDiagnosticError,
  ProviderStreamDiagnostic,
} from "./provider-payload-capture.ts";

Deno.test("provider diagnostics remove credentials, URLs, and encoded media", () => {
  const body = providerDiagnosticBody({
    model: "public/chat",
    headers: { authorization: "Bearer should-never-persist" },
    nested: {
      api_key: "sk-test-secret-value",
      image_url: "https://objects.example/image.png?X-Signature=secret",
      audio: `data:audio/wav;base64,${"A".repeat(512)}`,
    },
    output: "safe response text",
    embedded: "prefix Bearer embedded-secret suffix",
    embeddedUrl: "diagnostic source https://example.test/path?X-Amz-Signature=secret suffix",
    connection: "connect with postgres://user:password@db.example/database",
    signedFragment: "relative/path?X-Goog-Signature=secret",
    signedShort: "relative/path?sig=secret",
    base64url: `prefix ${"a_b-".repeat(79)}abcd suffix`,
  });
  assertStringIncludes(body!, "safe response text");
  assertEquals(body!.includes("should-never-persist"), false);
  assertEquals(body!.includes("sk-test"), false);
  assertEquals(body!.includes("X-Signature"), false);
  assertEquals(body!.includes("data:audio"), false);
  for (
    const secret of [
      "embedded-secret",
      "https://example.test",
      "password@db.example",
      "X-Goog-Signature",
      "sig=secret",
      "a_b-a_b-",
    ]
  ) assertEquals(body!.includes(secret), false, secret);
});

Deno.test("stream diagnostics process many small frames with bounded linear work", () => {
  const stream = new ProviderStreamDiagnostic();
  const started = performance.now();
  for (let index = 0; index < 8_000; index++) {
    stream.observe(JSON.stringify({ index, choices: [{ delta: { content: "ok" } }] }));
  }
  const body = stream.body();
  const elapsed = performance.now() - started;
  assertEquals((JSON.parse(body!) as { events: unknown[] }).events.length, 8_000);
  // This intentionally generous ceiling catches the former quadratic whole-buffer serialization
  // while remaining stable on slower CI runners.
  assertEquals(elapsed < 5_000, true, `8,000 frames took ${elapsed.toFixed(0)}ms`);

  stream.observe("one frame beyond the configured count budget");
  for (let index = 8_001; index <= 10_000; index++) stream.observe(String(index));
  assertEquals(stream.body(), null);
});

Deno.test("provider error diagnostics expose only bounded normalized fields", () => {
  const error = Object.assign(new Error("Bearer embedded-error-secret"), {
    status: 503,
    code: "upstream_unavailable",
    headers: { authorization: "Bearer header-secret" },
    stack: "private stack",
    response: { body: "private raw response" },
  });
  const body = providerDiagnosticBody({ error: providerDiagnosticError(error) })!;
  assertEquals(Object.keys(JSON.parse(body).error), ["name", "status", "code", "message"]);
  assertEquals(body.includes("private stack"), false);
  assertEquals(body.includes("private raw response"), false);
  assertEquals(body.includes("embedded-error-secret"), false);
  assertStringIncludes(body, "upstream_unavailable");
});

Deno.test("provider diagnostics omit oversized complete and streaming bodies", () => {
  assertEquals(providerDiagnosticBody({ text: "large text ".repeat(120_000) }), null);
  const stream = new ProviderStreamDiagnostic();
  stream.observe(
    JSON.stringify({ choices: [{ delta: { content: "large text ".repeat(120_000) } }] }),
  );
  assertEquals(stream.body(), null);
});
