import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import OpenAI from "npm:openai@6.16.0";
import { createApp } from "./app.ts";

async function json(response: Response) {
  return await response.json() as {
    error: { message: string; code: string | null; param: string | null; type: string };
  };
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected session cookie");
  return cookie;
}

Deno.test("OpenAI validation preserves exact parameter paths and exposes governance headers", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({
    repository,
    setupToken: "openai-param-setup",
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "openai-param-setup",
    },
    body: JSON.stringify({
      email: "openai-param@example.test",
      password: "correct horse battery",
      name: "OpenAI parameter test",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "openai-param@example.test",
      password: "correct horse battery",
    }),
  });
  assertEquals(login.status, 200);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie: sessionCookie(login),
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "OpenAI parameter test",
      scopes: ["models:read", "chat:write", "files:read", "files:write"],
    }),
  });
  assertEquals(tokenResponse.status, 201);
  const token = (await tokenResponse.json() as { token: string }).token;
  const headers = {
    authorization: `Bearer ${token}`,
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  const malformedChat = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "missing/model",
      messages: [{ role: "invalid", content: "hello" }],
    }),
  });
  assertEquals(malformedChat.status, 422);
  assertEquals(await json(malformedChat), {
    error: {
      message: "Request validation failed",
      type: "invalid_request_error",
      param: "messages[0].role",
      code: "validation_error",
    },
  });

  const unsupportedContinuation = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "missing/model",
      input: "hello",
      previous_response_id: "resp_previous",
    }),
  });
  assertEquals(unsupportedContinuation.status, 400);
  const continuationError = await json(unsupportedContinuation);
  assertEquals(continuationError.error.code, "unsupported_feature");
  assertEquals(continuationError.error.param, "request.previous_response_id");

  const unsupportedStore = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "missing/model",
      input: "hello",
      store: true,
    }),
  });
  assertEquals(unsupportedStore.status, 400);
  assertEquals((await json(unsupportedStore)).error.param, "store");

  const malformedResponse = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "missing/model",
      input: [{ role: "invalid", content: "hello" }],
    }),
  });
  assertEquals(malformedResponse.status, 422);
  assertEquals((await json(malformedResponse)).error.param, "input[0].role");

  const malformedEmbedding = await app.request("/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "missing/model",
      input: "hello",
      encoding_format: "hex",
    }),
  });
  assertEquals(malformedEmbedding.status, 422);
  assertEquals((await json(malformedEmbedding)).error.param, "encoding_format");

  const malformedFileList = await app.request("/v1/files?limit=0", { headers });
  assertEquals(malformedFileList.status, 400);
  assertEquals((await json(malformedFileList)).error.param, "limit");

  const malformedFileId = await app.request("/v1/files/not-a-file", { headers });
  assertEquals(malformedFileId.status, 400);
  assertEquals((await json(malformedFileId)).error.param, "id");

  const models = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${token}`, origin: "http://localhost:5173" },
  });
  assertEquals(models.status, 200);
  const exposed = models.headers.get("access-control-expose-headers") ?? "";
  for (
    const header of [
      "X-Request-Id",
      "Retry-After",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-Idempotent-Replay",
    ]
  ) assertStringIncludes(exposed.toLowerCase(), header.toLowerCase());

  const preflight = await app.request("/v1/chat/completions", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers":
        "authorization, content-type, idempotency-key, openai-beta, openai-organization, " +
        "openai-project, x-request-id, x-stainless-arch, x-stainless-custom-poll-interval, " +
        "x-stainless-helper-method, x-stainless-lang, x-stainless-os, " +
        "x-stainless-package-version, x-stainless-poll-helper, x-stainless-retry-count, " +
        "x-stainless-runtime, x-stainless-runtime-version, x-stainless-timeout",
    },
  });
  assertEquals(preflight.status, 204);
  const allowedRequestHeaders = (preflight.headers.get("access-control-allow-headers") ?? "")
    .toLowerCase();
  for (
    const header of [
      "authorization",
      "content-type",
      "idempotency-key",
      "openai-beta",
      "openai-organization",
      "openai-project",
      "x-request-id",
      "x-stainless-arch",
      "x-stainless-custom-poll-interval",
      "x-stainless-helper-method",
      "x-stainless-lang",
      "x-stainless-os",
      "x-stainless-package-version",
      "x-stainless-poll-helper",
      "x-stainless-retry-count",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
      "x-stainless-timeout",
    ]
  ) assertStringIncludes(allowedRequestHeaders, header);
  assertStringIncludes(
    (preflight.headers.get("access-control-expose-headers") ?? "").toLowerCase(),
    "x-idempotent-replay",
  );

  const oversized = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      ...headers,
      "content-length": String(4 * 1024 * 1024 + 1),
    },
    body: "{}",
  });
  assertEquals(oversized.status, 413);
  assertStringIncludes(
    (oversized.headers.get("access-control-expose-headers") ?? "").toLowerCase(),
    "retry-after",
  );
});

Deno.test("CORS accepts the metadata headers emitted by the official OpenAI JavaScript client", async () => {
  const observed = new Set<string>();
  const client = new OpenAI({
    apiKey: "browser-test-token",
    baseURL: "http://localhost:5173/v1",
    organization: "org_browser_test",
    project: "proj_browser_test",
    dangerouslyAllowBrowser: true,
    timeout: 12_000,
    fetch: (_input, init) => {
      new Headers(init?.headers).forEach((_value, name) => observed.add(name.toLowerCase()));
      return Promise.resolve(Response.json({ object: "list", data: [] }));
    },
  });
  await client.models.list();

  const sdkMetadataHeaders = [...observed].filter((name) =>
    name === "authorization" || name === "content-type" || name.startsWith("openai-") ||
    name.startsWith("x-stainless-")
  );
  for (
    const required of [
      "authorization",
      "openai-organization",
      "openai-project",
      "x-stainless-arch",
      "x-stainless-lang",
      "x-stainless-os",
      "x-stainless-package-version",
      "x-stainless-retry-count",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
    ]
  ) assertEquals(sdkMetadataHeaders.includes(required), true, `SDK omitted ${required}`);

  const { app } = createApp();
  const preflight = await app.request("/v1/models", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "GET",
      "access-control-request-headers": sdkMetadataHeaders.join(", "),
    },
  });
  assertEquals(preflight.status, 204);
  const allowed = new Set(
    (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/),
  );
  for (const name of sdkMetadataHeaders) {
    assertEquals(allowed.has(name), true, `CORS omitted SDK header ${name}`);
  }
});
