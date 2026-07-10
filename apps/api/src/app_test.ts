import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { createApp } from "./app.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { DomainError, MemoryRepository } from "@dg-chat/database";
import { type IdentityMailer, TestIdentityMailer } from "./mail.ts";

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
  const mailer = new TestIdentityMailer();
  const { app, repository } = createApp({
    setupToken: "setup-secret",
    startingCreditMicros: 5_000_000,
    mailer,
    requireEmailVerification: true,
    idempotencyHeartbeatMs: 20,
    idempotencyLeaseSeconds: 1,
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
  const verification = await app.request("/api/auth/verify-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: mailer.messages.at(-1)?.token }),
  });
  assertEquals(verification.status, 200);
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
  const invalidActiveLeaf = await app.request(
    `/api/conversations/${conversation.id}/active-leaf`,
    {
      method: "POST",
      headers: userAuth,
      body: JSON.stringify({ leafId: "not-a-uuid", expectedVersion: 0, ownerId: signed.user.id }),
    },
  );
  assertEquals(invalidActiveLeaf.status, 422);
  const renamedConversation = await app.request(`/api/conversations/${conversation.id}`, {
    method: "PATCH",
    headers: userAuth,
    body: JSON.stringify({ title: "  Renamed chat  " }),
  });
  assertEquals(renamedConversation.status, 200);
  assertEquals((await json(renamedConversation)).title, "Renamed chat");
  const oversizedTitle = await app.request(`/api/conversations/${conversation.id}`, {
    method: "PATCH",
    headers: userAuth,
    body: JSON.stringify({ title: "x".repeat(201) }),
  });
  assertEquals(oversizedTitle.status, 422);
  const unknownConversationPatch = await app.request(`/api/conversations/${conversation.id}`, {
    method: "PATCH",
    headers: userAuth,
    body: JSON.stringify({ ownerId: signed.user.id }),
  });
  assertEquals(unknownConversationPatch.status, 422);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: userAuth,
    body: JSON.stringify({ name: "SDK", scopes: ["models:read", "chat:write"] }),
  });
  const apiToken = await json(tokenResponse);
  assertStringIncludes(apiToken.token, "dg_");
  const completion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "chat-completion-replay",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const result = await json(completion);
  assertEquals(completion.status, 200);
  assertStringIncludes(result.choices[0].message.content, "hello");
  const completionReplay = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "chat-completion-replay",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assertEquals(completionReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await json(completionReplay), result);
  const conflictingReplay = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "chat-completion-replay",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "different" }],
    }),
  });
  assertEquals(conflictingReplay.status, 409);
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
  const streamEvents = await stream.text();
  assertStringIncludes(streamEvents, "[DONE]");
  const usageAfterStream = await repository.usage(signed.user.id);
  assertEquals(usageAfterStream.calls, 3);
  assertEquals(usageAfterStream.balanceMicros < balanceBeforeStream, true);
  const streamReplay = await app.request("/v1/chat/completions", {
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
  assertEquals(streamReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await streamReplay.text(), streamEvents);
  assertEquals((await repository.usage(signed.user.id)).calls, 3);

  let responseBatchCalls = 0;
  let responseBatchFrames: Array<{ sequence: number; frame: string }> = [];
  let responseTerminalFrame: string | undefined;
  const completeApiStream = repository.completeApiStream.bind(repository);
  repository.completeApiStream = async (input) => {
    if ((input.frames?.length ?? 0) > 1) {
      responseBatchCalls++;
      responseBatchFrames = input.frames ?? [];
      responseTerminalFrame = input.terminalFrame;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    return await completeApiStream(input);
  };
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
  assertEquals(responseStream.headers.get("cache-control"), "no-cache");
  const responseEvents = await responseStream.text();
  assertStringIncludes(responseEvents, "event: response.created");
  assertStringIncludes(responseEvents, "event: response.output_text.delta");
  assertStringIncludes(responseEvents, "event: response.completed");
  assertEquals(responseEvents.includes("[DONE]"), false);
  assertEquals(responseBatchCalls, 1);
  assertEquals(
    responseBatchFrames.some(({ frame }) => frame.includes("response.completed")),
    false,
  );
  assertStringIncludes(responseTerminalFrame ?? "", "response.completed");
  assertEquals((await repository.usage(signed.user.id)).calls, 4);
  const responseReplay = await app.request("/v1/responses", {
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
  assertEquals(responseReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(responseReplay.headers.get("cache-control"), "no-cache");
  assertEquals(await responseReplay.text(), responseEvents);
  assertEquals((await repository.usage(signed.user.id)).calls, 4);

  const completeApiJson = repository.completeApiJson.bind(repository);
  repository.completeApiJson = () => {
    throw new DomainError("response_too_large", "forced JSON replay persistence failure", 413);
  };
  const failedChatPersistence = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "chat-persistence-failure",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "terminalize this completed result" }],
    }),
  });
  assertEquals(failedChatPersistence.status, 413);
  assertEquals(
    (await repository.getApiRequest(
      signed.user.id,
      "chat.completions",
      "chat-persistence-failure",
    ))?.state,
    "failed",
  );
  assertEquals((await repository.usage(signed.user.id)).calls, 5);
  repository.completeApiJson = completeApiJson;

  repository.completeApiStream = () => {
    throw new DomainError("response_too_large", "forced replay persistence failure", 413);
  };
  const failedResponsesRequest = () =>
    app.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken.token}`,
        "content-type": "application/json",
        "idempotency-key": "responses-persistence-failure",
      },
      body: JSON.stringify({
        model: "simulated/dg-chat",
        input: "terminalize accounting after persistence fails",
        stream: true,
        max_output_tokens: 100,
      }),
    });
  const failedPersistence = await failedResponsesRequest();
  const failedPersistenceBody = await failedPersistence.text();
  assertEquals(failedPersistence.status, 413);
  const terminalized = await repository.getApiRequest(
    signed.user.id,
    "responses",
    "responses-persistence-failure",
  );
  assertEquals(terminalized?.state, "failed");
  assertEquals((await repository.usage(signed.user.id)).calls, 6);
  const failedPersistenceReplay = await failedResponsesRequest();
  assertEquals(failedPersistenceReplay.status, failedPersistence.status);
  assertEquals(
    failedPersistenceReplay.headers.get("content-type"),
    failedPersistence.headers.get("content-type"),
  );
  assertEquals(await failedPersistenceReplay.text(), failedPersistenceBody);

  const resetRequest = await app.request("/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "person@example.com" }),
  });
  assertEquals(resetRequest.status, 202);
  const resetToken = mailer.messages.findLast((message) => message.kind === "password_reset")
    ?.token;
  assertExists(resetToken);
  const reset = await app.request("/api/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: resetToken, password: "new correct horse battery" }),
  });
  assertEquals(reset.status, 204);
  const resetReplay = await app.request("/api/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: resetToken, password: "another correct horse battery" }),
  });
  assertEquals(resetReplay.status, 400);
  assertEquals(
    (await app.request("/v1/models", {
      headers: { authorization: `Bearer ${apiToken.token}` },
    })).status,
    401,
  );
  const newLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "person@example.com",
      password: "new correct horse battery",
    }),
  });
  assertEquals(newLogin.status, 200);
  const newUserAuth = {
    cookie: sessionCookie(newLogin),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const sessions = await json(await app.request("/api/sessions", { headers: newUserAuth }));
  const activeSession = sessions.data.find((session: { invalidatedAt: string | null }) =>
    session.invalidatedAt === null
  );
  assertExists(activeSession);
  assertEquals(
    (await app.request(`/api/sessions/${activeSession.id}`, {
      method: "DELETE",
      headers: newUserAuth,
    })).status,
    204,
  );
  const audit = await json(await app.request("/api/admin/audit", { headers: adminAuth }));
  assertEquals(
    audit.data.some((event: { action: string }) =>
      event.action === "identity.password_reset_completed"
    ),
    true,
  );
  assertEquals(
    (await app.request("/api/admin/audit?limit=2.5", { headers: adminAuth })).status,
    422,
  );
  assertEquals(
    (await app.request("/api/admin/audit?limit=201", { headers: adminAuth })).status,
    422,
  );

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

Deno.test("email verification defaults off and SMTP failures do not break identity requests", async () => {
  const failingMailer: IdentityMailer = {
    send: () => Promise.reject(new Error("delivery unavailable")),
  };
  const { app, repository } = createApp({
    setupToken: "setup-secret",
    mailer: failingMailer,
  });
  const status = await json(await app.request("/api/setup/status"));
  assertEquals(status.requireEmailVerification, false);
  assertEquals(status.emailEnabled, true);

  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "setup-secret" },
    body: JSON.stringify({
      email: "smtp-admin@example.com",
      password: "correct horse battery",
      name: "Admin",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const adminLogin = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "smtp-admin@example.com",
      password: "correct horse battery",
    }),
  });
  const adminHeaders = {
    cookie: sessionCookie(adminLogin),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const signup = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "smtp-user@example.com",
      password: "correct horse battery",
      name: "User",
    }),
  });
  assertEquals(signup.status, 201);
  const signed = await json(signup);
  assertEquals(signed.user.emailVerifiedAt, null);
  assertEquals(
    (await app.request(`/api/admin/users/${signed.user.id}/approval`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "approved" }),
    })).status,
    200,
  );
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "smtp-user@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals((await json(login)).limited, false);
  assertEquals(
    (await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "smtp-user@example.com" }),
    })).status,
    202,
  );
  assertEquals(
    (await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com" }),
    })).status,
    202,
  );
  assertEquals(
    (await repository.listAudit()).some((event) =>
      event.action === "identity.password_reset_delivery_failed"
    ),
    true,
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

Deno.test("rate limiter uses one bucket for equivalent Bearer header spellings", async () => {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    consume: (key, limit) => {
      keys.push(key);
      return Promise.resolve({ allowed: true, limit, remaining: limit - 1, retryAfterSeconds: 60 });
    },
    health: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  const { app } = createApp({ rateLimiter: limiter });
  await app.request("/v1/models", { headers: { authorization: "Bearer dg_same-token" } });
  await app.request("/v1/models", { headers: { authorization: "bearer    dg_same-token" } });
  assertEquals(keys.length, 2);
  assertEquals(keys[0], keys[1]);
});

Deno.test("authentication rate limits isolate account identities behind one proxy", async () => {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    consume: (key, limit) => {
      keys.push(key);
      return Promise.resolve({ allowed: true, limit, remaining: limit - 1, retryAfterSeconds: 60 });
    },
    health: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  const { app } = createApp({ rateLimiter: limiter });
  const signIn = (email: string) =>
    app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "not-the-password" }),
    });
  await signIn("First@Example.com");
  await signIn("first@example.com");
  await signIn("second@example.com");
  assertEquals(keys.length, 6);
  assertEquals(keys[0], keys[2]);
  assertEquals(keys[0] === keys[4], false);
  assertEquals(keys[1], "auth:client:untrusted-deployment");
  assertEquals(keys[1], keys[3]);
  assertEquals(keys[1], keys[5]);
});

Deno.test("trusted clients consume both account and higher client auth buckets", async () => {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    consume: (key, limit) => {
      keys.push(`${key}:${limit}`);
      return Promise.resolve({ allowed: true, limit, remaining: limit - 1, retryAfterSeconds: 60 });
    },
    health: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  const { app } = createApp({ rateLimiter: limiter, trustProxyHeaders: true });
  await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "198.51.100.20",
    },
    body: JSON.stringify({ email: "dual@example.com", password: "not-the-password" }),
  });
  assertEquals(keys.length, 2);
  assertEquals(keys.some((key) => key.startsWith("auth:account:") && key.endsWith(":10")), true);
  assertEquals(keys.includes("auth:client:198.51.100.20:100"), true);
});

Deno.test("untrusted deployments bound rotating authentication identities", async () => {
  const { app } = createApp({ authClientRateLimit: 2 });
  const attempt = (email: string) =>
    app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "not-the-password" }),
    });
  assertEquals((await attempt("rotate-1@example.com")).status, 401);
  assertEquals((await attempt("rotate-2@example.com")).status, 401);
  assertEquals((await attempt("rotate-3@example.com")).status, 429);
});

Deno.test("a chat stream failure before its first provider event replays its SSE error", async () => {
  const providerStream = async function* () {
    await Promise.resolve();
    if (Date.now() < 0) yield "unreachable";
    throw new Error("provider unavailable");
  };
  const { app } = createApp({ setupToken: "failure-setup", providerStream });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "failure-setup" },
    body: JSON.stringify({
      email: "failure@example.com",
      password: "correct horse battery",
      name: "Failure Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "failure@example.com",
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
    body: JSON.stringify({ name: "failure", scopes: ["chat:write"] }),
  });
  const token = (await json(tokenResponse)).token as string;
  const request = () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "stream-failure-before-first-event",
      },
      body: JSON.stringify({
        model: "openai/default",
        messages: [{ role: "user", content: "fail before streaming" }],
        stream: true,
      }),
    });

  const original = await request();
  const originalBody = await original.text();
  assertEquals(original.status, 200);
  assertStringIncludes(original.headers.get("content-type") ?? "", "text/event-stream");
  assertStringIncludes(originalBody, "provider_error");
  const replay = await request();
  assertEquals(replay.status, original.status);
  assertEquals(replay.headers.get("content-type"), original.headers.get("content-type"));
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await replay.text(), originalBody);

  const responsesRequest = () =>
    app.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "responses-failure-before-stream",
      },
      body: JSON.stringify({
        model: "openai/default",
        input: "fail before the Responses stream opens",
        stream: true,
      }),
    });
  const responsesOriginal = await responsesRequest();
  const responsesBody = await responsesOriginal.text();
  assertEquals(responsesOriginal.status, 502);
  assertEquals(responsesOriginal.headers.get("content-type"), "application/json");
  const responsesReplay = await responsesRequest();
  assertEquals(responsesReplay.status, responsesOriginal.status);
  assertEquals(
    responsesReplay.headers.get("content-type"),
    responsesOriginal.headers.get("content-type"),
  );
  assertEquals(responsesReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await responsesReplay.text(), responsesBody);
});

Deno.test("idempotent provider calls heartbeat while waiting for a slow first token", async () => {
  const providerStream = async function* () {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    yield JSON.stringify({
      id: "chatcmpl-slow",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "slow result" }, finish_reason: null }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
    yield "[DONE]";
  };
  const { app, repository } = createApp({
    setupToken: "heartbeat-setup",
    providerStream,
    idempotencyHeartbeatMs: 20,
    idempotencyLeaseSeconds: 1,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "heartbeat-setup" },
    body: JSON.stringify({
      email: "heartbeat@example.com",
      password: "correct horse battery",
      name: "Heartbeat Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "heartbeat@example.com",
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
    body: JSON.stringify({ name: "heartbeat", scopes: ["chat:write"] }),
  });
  const token = (await json(tokenResponse)).token as string;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "slow-provider-heartbeat",
    },
    body: JSON.stringify({
      model: "openai/default",
      messages: [{ role: "user", content: "wait for it" }],
      stream: true,
    }),
  });
  const body = response.text();
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assertEquals(await repository.reapStaleApiRequests(), 0);
  assertEquals(response.status, 200);
  assertStringIncludes(await body, "slow result");
});

Deno.test("disconnecting after a role-only provider chunk refunds the reservation", async () => {
  const providerStream = async function* (_request: ChatCompletionRequest, signal: AbortSignal) {
    yield JSON.stringify({
      id: "chatcmpl-role-only",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), {
        once: true,
      })
    );
    signal.throwIfAborted();
  };
  const { app, repository } = createApp({
    setupToken: "disconnect-setup",
    providerStream,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "disconnect-setup" },
    body: JSON.stringify({
      email: "disconnect@example.com",
      password: "correct horse battery",
      name: "Disconnect Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "disconnect@example.com",
      password: "correct horse battery",
    }),
  });
  const me = await json(login);
  const auth = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "disconnect", scopes: ["chat:write"] }),
  });
  const token = (await json(tokenResponse)).token as string;
  const before = await repository.usage(me.user.id);
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/default",
      messages: [{ role: "user", content: "disconnect now" }],
      stream: true,
    }),
  });
  const reader = response.body?.getReader();
  assertExists(reader);
  assertEquals((await reader.read()).done, false);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = await repository.usage(me.user.id);
  assertEquals(after.balanceMicros, before.balanceMicros);
  assertEquals(after.calls, before.calls);
});

Deno.test("OpenAI routes reject upstream models that are not explicitly configured", async () => {
  const { app } = createApp({ setupToken: "model-allowlist-setup" });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "model-allowlist-setup",
    },
    body: JSON.stringify({
      email: "model-allowlist@example.com",
      password: "correct horse battery",
      name: "Model Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "model-allowlist@example.com",
      password: "correct horse battery",
    }),
  });
  const auth = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "allowlist", scopes: ["models:read", "chat:write"] }),
  });
  const token = (await json(tokenResponse)).token as string;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const completion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/not-configured",
      messages: [{ role: "user", content: "must not reach the provider" }],
    }),
  });
  assertEquals(completion.status, 404);
  assertEquals((await json(completion)).error.code, "model_not_found");

  const responses = await app.request("/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "openai/not-configured", input: "must not reach the provider" }),
  });
  assertEquals(responses.status, 404);
  assertEquals((await json(responses)).error.code, "model_not_found");
});

Deno.test("expired web generation ownership is reclaimed once and fences the old worker", async () => {
  const pending: Array<
    (value: { text: string; inputTokens: number; outputTokens: number }) => void
  > = [];
  const webComplete = () =>
    new Promise<{ text: string; inputTokens: number; outputTokens: number }>((resolve) =>
      pending.push(resolve)
    );
  const repository = new MemoryRepository();
  const { app } = createApp({
    repository,
    setupToken: "generation-lease-setup",
    generationHeartbeatMs: 60_000,
    generationLeaseSeconds: 60,
    webComplete,
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "generation-lease-setup" },
    body: JSON.stringify({
      email: "generation-lease@example.com",
      password: "correct horse battery",
      name: "Lease Admin",
    }),
  });
  const owner = (await json(bootstrap)).user;
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "generation-lease@example.com",
      password: "correct horse battery",
    }),
  });
  const headers = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const created = await app.request("/api/conversations", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Lease" }),
  });
  const conversation = await json(created);
  const generationBody = JSON.stringify({
    content: "claim me",
    model: "simulated/dg-chat",
    parentId: null,
    expectedVersion: 0,
    idempotencyKey: "web-generation-fenced",
  });
  const request = () =>
    app.request(`/api/conversations/${conversation.id}/generate`, {
      method: "POST",
      headers,
      body: generationBody,
    });

  const oldWorker = request();
  while (pending.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const runId = `${owner.id}:web-generation:web-generation-fenced`;
  const run = repository.usageRuns.get(runId);
  assertExists(run);
  run.generationLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  const newWorker = request();
  while (pending.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));

  pending[0]({ text: "stale answer", inputTokens: 1, outputTokens: 2 });
  assertEquals((await oldWorker).status, 409);
  pending[1]({ text: "owned answer", inputTokens: 1, outputTokens: 2 });
  const completed = await newWorker;
  assertEquals(completed.status, 201);
  assertEquals((await json(completed)).assistant.content, "owned answer");
  const detail = await repository.detail(conversation.id, owner.id);
  assertEquals(detail.messages.filter((message) => message.role === "assistant").length, 1);
});
