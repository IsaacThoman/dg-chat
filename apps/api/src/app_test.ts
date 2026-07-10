import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { createApp } from "./app.ts";
import type { RateLimiter } from "./rate-limit.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return cookie;
}

Deno.test("bootstrap, signup, approval, immutable chat, API token and OpenAI completion", async () => {
  const { app, repository } = createApp({
    setupToken: "setup-secret",
    startingCreditMicros: 5_000_000,
  });
  const adminResponse = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "setup-secret" },
    body: JSON.stringify({
      email: "admin@example.com",
      password: "correct horse battery",
      name: "Admin",
    }),
  });
  assertEquals(adminResponse.status, 201);
  const loginAdmin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
  });
  const admin = await json(loginAdmin);
  assertEquals(admin.token, undefined);
  const adminAuth = {
    cookie: sessionCookie(loginAdmin),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "person@example.com",
      password: "correct horse battery",
      name: "Person",
    }),
  });
  const signed = await json(signup);
  assertEquals(signed.user.approvalStatus, "pending");
  assertEquals(signed.token, undefined);
  assertStringIncludes(signup.headers.get("set-cookie") ?? "", "HttpOnly");
  const userAuth = {
    cookie: sessionCookie(signup),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const blocked = await app.request("/api/conversations", {
    headers: userAuth,
  });
  assertEquals(blocked.status, 403);
  const approval = await app.request(`/api/admin/users/${signed.user.id}/approval`, {
    method: "PATCH",
    headers: adminAuth,
    body: JSON.stringify({ status: "approved" }),
  });
  assertEquals(approval.status, 200);
  const conversationResponse = await app.request("/api/conversations", {
    method: "POST",
    headers: { ...userAuth, "idempotency-key": "conversation-create-0001" },
    body: JSON.stringify({ title: "Test" }),
  });
  const conversation = await json(conversationResponse);
  assertExists(conversation.id);
  const replayedConversation = await app.request("/api/conversations", {
    method: "POST",
    headers: { ...userAuth, "idempotency-key": "conversation-create-0001" },
    body: JSON.stringify({ title: "Test" }),
  });
  assertEquals((await json(replayedConversation)).id, conversation.id);
  const generationRequest = () =>
    app.request(`/api/conversations/${conversation.id}/generate`, {
      method: "POST",
      headers: userAuth,
      body: JSON.stringify({
        content: "hello from the web",
        model: "simulated/dg-chat",
        parentId: null,
        supersedesId: null,
        expectedVersion: 0,
        idempotencyKey: "web-generation-0001",
      }),
    });
  const generationResponse = await generationRequest();
  const generation = await json(generationResponse);
  assertEquals(generationResponse.status, 201);
  assertEquals(generation.user.content, "hello from the web");
  assertStringIncludes(generation.assistant.content, "hello from the web");
  const generationReplay = await generationRequest();
  assertEquals(generationReplay.status, 200);
  assertEquals((await json(generationReplay)).assistant.id, generation.assistant.id);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: userAuth,
    body: JSON.stringify({ name: "SDK", scopes: ["models:read", "chat:write"] }),
  });
  const apiToken = await json(tokenResponse);
  assertStringIncludes(apiToken.token, "dg_");
  const completion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const result = await json(completion);
  assertEquals(completion.status, 200);
  assertStringIncludes(result.choices[0].message.content, "hello");
  const filesWithoutScope = await app.request("/v1/files", {
    headers: { authorization: `Bearer ${apiToken.token}` },
  });
  assertEquals(filesWithoutScope.status, 403);

  const balanceBeforeStream = (await repository.usage(signed.user.id)).balanceMicros;
  const stream = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "stream-pricing-regression",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "stream this response" }],
      stream: true,
    }),
  });
  assertEquals(stream.status, 200);
  assertStringIncludes(await stream.text(), "[DONE]");
  const usageAfterStream = await repository.usage(signed.user.id);
  assertEquals(usageAfterStream.calls, 3);
  assertEquals(usageAfterStream.balanceMicros < balanceBeforeStream, true);

  const responseStream = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "responses-stream-regression",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: "stream a Responses API result",
      stream: true,
      max_output_tokens: 100,
    }),
  });
  assertEquals(responseStream.status, 200);
  const responseEvents = await responseStream.text();
  assertStringIncludes(responseEvents, "event: response.created");
  assertStringIncludes(responseEvents, "event: response.output_text.delta");
  assertStringIncludes(responseEvents, "event: response.completed");
  assertEquals(responseEvents.includes("[DONE]"), false);
  assertEquals((await repository.usage(signed.user.id)).calls, 4);

  const missingOrigin = await app.request("/api/conversations", {
    method: "POST",
    headers: { cookie: sessionCookie(signup), "content-type": "application/json" },
    body: JSON.stringify({ title: "CSRF should fail" }),
  });
  assertEquals(missingOrigin.status, 403);
  assertStringIncludes(
    (await app.request("/health")).headers.get("content-security-policy") ?? "",
    "default-src 'self'",
  );
});

Deno.test("bootstrap is consumed once under concurrent requests", async () => {
  const { app, repository } = createApp({ setupToken: "one-time-token" });
  const bootstrap = (email: string) =>
    app.request("/api/setup/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-setup-token": "one-time-token" },
      body: JSON.stringify({ email, password: "correct horse battery", name: email }),
    });
  const responses = await Promise.all([
    bootstrap("first@example.com"),
    bootstrap("second@example.com"),
  ]);
  assertEquals(responses.map((response) => response.status).sort(), [201, 409]);
  assertEquals((await repository.listUsers()).filter((user) => user.role === "admin").length, 1);
});

Deno.test("rate limiter outages fail closed with a controlled service error", async () => {
  const unavailable: RateLimiter = {
    consume: () => Promise.reject(new Error("redis unavailable")),
    health: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  };
  const { app } = createApp({ rateLimiter: unavailable });
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
  });
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "5");
  assertEquals((await json(response)).error.code, "service_unavailable");
});
