import { assertEquals, assertFalse } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected session cookie");
  return cookie;
}

function providerFailure(request: ChatCompletionRequest): never {
  const hostile = JSON.stringify(request.messages).includes("hostile");
  throw new ProviderAttemptError("private provider detail must not leak", {
    category: "rate_limited",
    status: 429,
    retryAfterMs: 2_000,
    param: hostile ? "messages[0]\r\nx-private-provider-detail: leaked" : "messages[0].content",
  });
}

Deno.test("Chat provider failures project identically across streams and replay modes", async () => {
  const { app } = createApp({
    setupToken: "chat-provider-failure",
    providerComplete: (request) => Promise.reject(providerFailure(request)),
    providerStream: async function* (request) {
      await Promise.resolve();
      if (Date.now() < 0) yield "unreachable";
      providerFailure(request);
    },
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "chat-provider-failure",
    },
    body: JSON.stringify({
      email: "chat-provider-failure@example.test",
      password: "correct horse battery",
      name: "Chat provider failure",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "chat-provider-failure@example.test",
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
    body: JSON.stringify({ name: "Chat provider failure", scopes: ["chat:write"] }),
  });
  assertEquals(tokenResponse.status, 201);
  const token = (await tokenResponse.json() as { token: string }).token;

  for (const stream of [false, true]) {
    for (const idempotent of [false, true]) {
      for (const hostile of [false, true]) {
        const idempotencyKey = `chat-failure-${stream ? "stream" : "buffer"}-${
          idempotent ? "idem" : "direct"
        }-${hostile ? "hostile" : "safe"}`;
        const request = () =>
          app.request("/v1/chat/completions", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              ...(idempotent ? { "idempotency-key": idempotencyKey } : {}),
            },
            body: JSON.stringify({
              model: "openai/default",
              messages: [{
                role: "user",
                content: hostile ? "trigger hostile provider path" : "trigger safe provider path",
              }],
              stream,
            }),
          });
        const expected = {
          error: {
            message: "The provider rate limit was exceeded",
            type: "rate_limit_error",
            param: hostile ? null : "messages[0].content",
            code: "rate_limit_exceeded",
          },
        };
        const original = await request();
        const body = await original.text();
        assertEquals(original.status, stream ? 200 : 429);
        assertEquals(original.headers.get("retry-after"), "2");
        assertFalse(body.includes("private provider detail"));
        assertFalse(body.includes("x-private-provider-detail"));
        assertEquals(
          body,
          stream ? `data: ${JSON.stringify(expected)}\n\n` : JSON.stringify(expected),
        );

        if (idempotent) {
          const replay = await request();
          assertEquals(replay.status, original.status);
          assertEquals(replay.headers.get("retry-after"), original.headers.get("retry-after"));
          assertEquals(replay.headers.get("x-idempotent-replay"), "true");
          assertEquals(await replay.text(), body);
        } else assertEquals(original.headers.get("x-idempotent-replay"), null);
      }
    }
  }
});

Deno.test("midstream Chat failures preserve replay headers and settle authoritative usage", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({
    repository,
    setupToken: "chat-midstream-failure",
    providerStream: async function* () {
      yield JSON.stringify({
        id: "upstream-midstream",
        object: "chat.completion.chunk",
        created: 1,
        model: "upstream",
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 0,
          total_tokens: 10,
        },
      });
      throw new ProviderAttemptError("private midstream provider detail", {
        category: "rate_limited",
        status: 429,
        retryAfterMs: 2_000,
        param: "messages[0].content",
      });
    },
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "chat-midstream-failure",
    },
    body: JSON.stringify({
      email: "chat-midstream-failure@example.test",
      password: "correct horse battery",
      name: "Chat midstream failure",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const userId = (await bootstrap.json() as { user: { id: string } }).user.id;
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "chat-midstream-failure@example.test",
      password: "correct horse battery",
    }),
  });
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie: sessionCookie(login),
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Chat midstream failure", scopes: ["chat:write"] }),
  });
  const token = (await tokenResponse.json() as { token: string }).token;

  for (const idempotent of [false, true]) {
    const request = () =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(idempotent ? { "idempotency-key": "chat-midstream-replay" } : {}),
        },
        body: JSON.stringify({
          model: "openai/default",
          messages: [{ role: "user", content: "midstream failure" }],
          stream: true,
        }),
      });
    const balanceBefore = (await repository.usage(userId)).balanceMicros;
    const original = await request();
    const originalBody = await original.text();
    assertEquals(original.status, 200);
    // Retry metadata learned after the response starts cannot be part of the live response or replay.
    assertEquals(original.headers.get("retry-after"), null);
    assertFalse(originalBody.includes("private midstream provider detail"));
    assertEquals(originalBody.includes('"param":"messages[0].content"'), true);
    assertEquals((await repository.usage(userId)).balanceMicros < balanceBefore, true);

    if (idempotent) {
      const replay = await request();
      assertEquals(replay.status, original.status);
      assertEquals(replay.headers.get("retry-after"), null);
      assertEquals(replay.headers.get("x-idempotent-replay"), "true");
      assertEquals(await replay.text(), originalBody);
    }
  }
});
