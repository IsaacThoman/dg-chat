import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { canonicalJson, createApp, legacyModelHarnessAllowed } from "./app.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { DomainError, MemoryRepository } from "@dg-chat/database";
import { type IdentityMailer, TestIdentityMailer } from "./mail.ts";
import { TestObjectStore } from "./test-object-store.ts";
import { simulate } from "./models.ts";
import { sha256Hex } from "./crypto.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

// Deno's RequestInit and the Node-compatible FormData ambient types are structurally distinct,
// even though the runtime accepts the standards-compatible FormData object.
function formBody<T>(value: FormData): T {
  return value as unknown as T;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return cookie;
}

Deno.test("OpenAI endpoint registrations are unique", () => {
  const { app } = createApp({ setupToken: "route-uniqueness" });
  const openAIRoutes = app.routes.filter((route) =>
    route.method !== "ALL" && route.path.startsWith("/v1/")
  );
  const counts = new Map<string, number>();
  for (const route of openAIRoutes) {
    const key = `${route.method} ${route.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    // Every endpoint has exactly one scope middleware and one terminal handler. A second route
    // declaration creates four entries and can silently shadow the newer implementation.
    assertEquals(count, 2, `Duplicate or incomplete OpenAI route registration: ${key}`);
  }
  for (
    const expected of [
      "POST /v1/embeddings",
      "POST /v1/audio/transcriptions",
      "POST /v1/audio/translations",
    ]
  ) assertEquals(counts.has(expected), true, `Missing OpenAI route registration: ${expected}`);
});

Deno.test("production disables all legacy and built-in model harnesses", () => {
  assertEquals(legacyModelHarnessAllowed("production"), false);
  assertEquals(legacyModelHarnessAllowed("test"), true);
  assertEquals(legacyModelHarnessAllowed(undefined), true);
});

Deno.test("admin model-access group user route matches the web contract", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({ setupToken: "model-access-route", repository });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "model-access-route" },
    body: JSON.stringify({
      email: "model-access@example.com",
      password: "correct horse battery",
      name: "Model Access Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "model-access@example.com",
      password: "correct horse battery",
    }),
  });
  const headers = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const createdResponse = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Restricted", description: "Route contract" }),
  });
  assertEquals(createdResponse.status, 201);
  const group = await json(createdResponse);
  const replaced = await app.request(`/api/admin/model-access/groups/${group.id}/users`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ expectedVersion: group.version, ids: [] }),
  });
  assertEquals(replaced.status, 200);
  const replacedGroup = await json(replaced);
  assertEquals(replacedGroup.userIds, []);
  const staleShape = await app.request(`/api/admin/model-access/groups/${group.id}/users`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ expectedVersion: group.version, userIds: [] }),
  });
  assertEquals(staleShape.status, 422);
  const impact = await app.request(`/api/admin/model-access/groups/${group.id}/impact`, {
    method: "POST",
    headers,
    body: JSON.stringify({ proposal: null }),
  });
  assertEquals(impact.status, 200);
  assertEquals(Array.isArray((await json(impact)).modelIdsBecomingPublic), true);
  const policy = await app.request(`/api/admin/model-access/groups/${group.id}/policy`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      expectedVersion: replacedGroup.version,
      name: "Atomic restricted",
      description: "All membership changes together",
      userIds: [],
      modelIds: [],
      tokenIds: [],
    }),
  });
  assertEquals(policy.status, 200);
  assertEquals((await json(policy)).name, "Atomic restricted");
  const restrictedModelId = crypto.randomUUID();
  const now = new Date().toISOString();
  repository.providerModels.set(restrictedModelId, {
    id: restrictedModelId,
    providerId: crypto.randomUUID(),
    publicModelId: "restricted/legacy-route",
    upstreamModelId: "legacy-route",
    displayName: "Restricted legacy route",
    capabilities: ["chat"],
    contextWindow: 1024,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });
  const restricted = repository.replaceAccessGroupModels(
    group.id,
    [restrictedModelId],
    repository.listAccessGroups()[0].version,
  );
  const unacknowledged = await app.request(`/api/admin/model-access/groups/${group.id}/models`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ expectedVersion: restricted.version, ids: [] }),
  });
  assertEquals(unacknowledged.status, 409);
  assertEquals(
    (await json(unacknowledged)).error.code,
    "model_access_widening_acknowledgement_required",
  );
  assertEquals(repository.listAccessGroups()[0].modelIds, [restrictedModelId]);
  const acknowledged = await app.request(`/api/admin/model-access/groups/${group.id}/models`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      expectedVersion: restricted.version,
      ids: [],
      acknowledgePublicModelIds: [restrictedModelId],
    }),
  });
  assertEquals(acknowledged.status, 200, await acknowledged.clone().text());
  const restored = repository.replaceAccessGroupModels(
    group.id,
    [restrictedModelId],
    repository.listAccessGroups()[0].version,
  );
  const deleteWithoutAcknowledgement = await app.request(
    `/api/admin/model-access/groups/${group.id}`,
    {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expectedVersion: restored.version }),
    },
  );
  assertEquals(deleteWithoutAcknowledgement.status, 409);
  const deleted = await app.request(`/api/admin/model-access/groups/${group.id}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({
      expectedVersion: restored.version,
      acknowledgePublicModelIds: [restrictedModelId],
    }),
  });
  assertEquals(deleted.status, 204, await deleted.clone().text());
  const audit = await app.request("/api/admin/audit?limit=20", { headers });
  const actions = (await json(audit)).data.map((event: { action: string }) => event.action);
  assertEquals(actions.includes("model_access_group.created"), true);
  assertEquals(actions.includes("model_access_group.users_replaced"), true);
  assertEquals(actions.includes("model_access_group.policy_replaced"), true);
});

Deno.test("token rotation shares quota and family revoke invalidates overlap", async () => {
  const { app } = createApp({ setupToken: "token-governance-route" });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "token-governance-route" },
    body: JSON.stringify({
      email: "token-governance@example.com",
      password: "correct horse battery",
      name: "Token Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "token-governance@example.com",
      password: "correct horse battery",
    }),
  });
  const loggedIn = await json(login.clone());
  const sessionHeaders = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const createdResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      name: "Rotating SDK",
      scopes: ["models:read"],
      rpmLimit: 10,
      burstLimit: 1,
    }),
  });
  assertEquals(createdResponse.status, 201);
  const created = await json(createdResponse);
  const restrictedResponse = await app.request(
    `/api/admin/model-access/tokens/${created.id}/access-mode`,
    {
      method: "PUT",
      headers: sessionHeaders,
      body: JSON.stringify({
        ownerId: loggedIn.user.id,
        expectedVersion: created.version,
        accessMode: "restricted",
      }),
    },
  );
  assertEquals(restrictedResponse.status, 200);
  const restricted = await json(restrictedResponse);
  assertEquals(restricted.accessMode, "restricted");
  const firstUse = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${created.token}` },
  });
  assertEquals(firstUse.status, 200);
  assertEquals(
    (await json(firstUse)).data.some((model: { id: string }) => model.id === "simulated/dg-chat"),
    true,
  );
  const rotationResponse = await app.request(`/api/tokens/${created.id}/rotate`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ expectedVersion: restricted.version, overlapSeconds: 60 }),
  });
  assertEquals(rotationResponse.status, 201);
  const rotation = await json(rotationResponse);
  assertEquals(rotation.token.startsWith("dg_"), true);
  const sharedQuota = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${rotation.token}` },
  });
  assertEquals(sharedQuota.status, 429);
  assertEquals(sharedQuota.headers.get("x-ratelimit-limit"), "1");
  assertEquals(sharedQuota.headers.get("x-ratelimit-remaining"), "0");
  assertEquals(sharedQuota.headers.get("retry-after"), "1");

  const staleRotation = await app.request(`/api/tokens/${created.id}/rotate`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ expectedVersion: restricted.version, overlapSeconds: 0 }),
  });
  assertEquals(staleRotation.status, 409);
  const revoked = await app.request(`/api/tokens/${rotation.replacement.id}`, {
    method: "DELETE",
    headers: sessionHeaders,
    body: JSON.stringify({ expectedVersion: rotation.replacement.version }),
  });
  assertEquals(revoked.status, 204);
  for (const secret of [created.token, rotation.token]) {
    const denied = await app.request("/v1/models", {
      headers: { authorization: `Bearer ${secret}` },
    });
    assertEquals(denied.status, 401);
  }
});

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
  let userAuth = {
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
  const staleLimitedSession = await app.request("/api/conversations", {
    headers: userAuth,
  });
  assertEquals(staleLimitedSession.status, 401);
  const approvedLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "person@example.com", password: "correct horse battery" }),
  });
  assertEquals(approvedLogin.status, 200);
  assertEquals((await approvedLogin.clone().json()).limited, false);
  userAuth = {
    ...userAuth,
    cookie: sessionCookie(approvedLogin),
  };
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
  const auditResponse = await app.request("/api/admin/audit", { headers: adminAuth });
  assertEquals(auditResponse.headers.get("cache-control"), "private, no-store");
  const audit = await json(auditResponse);
  assertEquals(typeof audit.nextCursor === "string" || audit.nextCursor === null, true);
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
  const filteredAudit = await json(
    await app.request(
      `/api/admin/audit?limit=1&action=identity.password_reset_completed&targetId=${signed.user.id}`,
      { headers: adminAuth },
    ),
  );
  assertEquals(filteredAudit.data.length, 1);
  assertEquals(filteredAudit.data[0].action, "identity.password_reset_completed");
  assertEquals(filteredAudit.data[0].targetId, signed.user.id);
  assertEquals(
    (await app.request("/api/admin/audit?actorId=not-a-uuid", { headers: adminAuth })).status,
    422,
  );
  assertEquals(
    (await app.request("/api/admin/audit?from=2026-02-01&to=2026-01-01", {
      headers: adminAuth,
    })).status,
    422,
  );
  assertEquals(
    (await app.request("/api/admin/audit?cursor=not-a-cursor", { headers: adminAuth })).status,
    422,
  );
  await repository.recordAudit({
    action: '=HYPERLINK("https://invalid")',
    targetType: "+formula",
  });
  const csv = await app.request("/api/admin/audit.csv?limit=1", { headers: adminAuth });
  assertEquals(csv.status, 200);
  assertEquals(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assertStringIncludes(csv.headers.get("content-disposition") ?? "", "dg-chat-audit.csv");
  const csvBody = await csv.text();
  assertStringIncludes(csvBody, '"\'=HYPERLINK(""https://invalid"")"');
  assertStringIncludes(csvBody, '"\'+formula"');

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
    (await repository.listAudit()).data.some((event) =>
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

Deno.test("post-auth token family limiter outages fail closed", async () => {
  const limiter: RateLimiter = {
    consume: (key, limit) =>
      key.startsWith("token:")
        ? Promise.reject(new Error("family limiter unavailable"))
        : Promise.resolve({ allowed: true, limit, remaining: limit - 1, retryAfterSeconds: 60 }),
    health: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  };
  const { app } = createApp({ setupToken: "family-limiter-outage", rateLimiter: limiter });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "family-limiter-outage" },
    body: JSON.stringify({
      email: "family-limiter@example.com",
      password: "correct horse battery",
      name: "Limiter Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "family-limiter@example.com",
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
    body: JSON.stringify({ name: "Default quota", scopes: ["models:read"] }),
  });
  const token = await json(tokenResponse);
  const response = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${token.token}` },
  });
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "5");
  assertEquals((await json(response)).error.code, "service_unavailable");
});

Deno.test("completed embeddings replay reauthorizes model access without enumeration", async () => {
  const { app, repository } = createApp({ setupToken: "embedding-replay-access" });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "embedding-replay-access" },
    body: JSON.stringify({
      email: "embedding-replay@example.com",
      password: "correct horse battery",
      name: "Replay Admin",
    }),
  });
  const owner = (await json(bootstrap)).user;
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "embedding-replay@example.com",
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
    body: JSON.stringify({ name: "Replay token", scopes: ["chat:write"] }),
  });
  const token = await json(tokenResponse);
  const request = { model: "private/embedding", input: "secret source" };
  const requestHash = await sha256Hex(canonicalJson({ endpoint: "embeddings", request }));
  const completed = {
    id: crypto.randomUUID(),
    userId: owner.id,
    endpoint: "embeddings",
    idempotencyKey: "embedding-replay-denied",
    requestHash,
    stream: false,
    model: request.model,
    state: "completed",
    leaseToken: null,
    leaseExpiresAt: null,
    usageRunId: "embedding-replay-run",
    responseStatus: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBody: JSON.stringify({ object: "list", data: [] }),
    responseBodyEncoding: "utf8",
    failureStartedStream: false,
    observedInputTokens: 1,
    observedOutputTokens: 0,
    observedCostMicros: 1,
    observedLatencyMs: 1,
    retentionSeconds: 60,
    frames: [],
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  Object.assign(repository, {
    getApiRequest: () => completed,
    resolveEntitledProviderModel: () => undefined,
  });
  const denied = await app.request("/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.token}`,
      "content-type": "application/json",
      "idempotency-key": completed.idempotencyKey,
    },
    body: JSON.stringify(request),
  });
  assertEquals(denied.status, 404);
  assertEquals(await json(denied), {
    error: {
      message: "The requested model is unavailable",
      type: "invalid_request_error",
      param: null,
      code: "model_not_found",
    },
  });
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

Deno.test("browser audio uses the generation bucket and ignores irrelevant bearer rotation", async () => {
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
  for (const bearer of ["first", "second"]) {
    await app.request("/api/audio/speech", {
      method: "POST",
      headers: {
        cookie: "dg_chat.session_token=stable-browser-session",
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
  }
  assertEquals(keys.length, 2);
  assertEquals(keys[0].startsWith("generation:"), true);
  assertEquals(keys[0], keys[1]);
});

Deno.test("OIDC initiation and callbacks avoid the shared unknown-account auth bucket", async () => {
  const consumed: Array<{ key: string; limit: number }> = [];
  const limiter: RateLimiter = {
    consume: (key, limit) => {
      consumed.push({ key, limit });
      return Promise.resolve({ allowed: true, limit, remaining: limit - 1, retryAfterSeconds: 60 });
    },
    health: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  const { app } = createApp({ rateLimiter: limiter });
  for (let index = 0; index < 6; index++) {
    await app.request("/api/auth/sign-in/oidc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  }
  await app.request("/api/auth/oidc/callback?state=first-browser-state", { method: "GET" });
  await app.request("/api/auth/oidc/callback?state=second-browser-state", { method: "GET" });
  assertEquals(consumed.length, 10);
  assertEquals(
    consumed.every(({ key }) => key.startsWith("oidc:") && !key.includes("account")),
    true,
  );
  assertEquals(consumed.slice(0, 6).every(({ limit }) => limit === 100), true);
  assertEquals(consumed[6].limit, 10);
  assertEquals(consumed[7].limit, 100);
  assertEquals(consumed[8].limit, 10);
  assertEquals(consumed[9].limit, 100);
  assertEquals(consumed[6].key === consumed[8].key, false);
  assertEquals(consumed[7].key, consumed[9].key);
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

Deno.test("disconnect settlement distinguishes role-only and tool-output streams", async () => {
  const providerStream = async function* (request: ChatCompletionRequest, signal: AbortSignal) {
    const toolOnly = JSON.stringify(request.messages).includes("tool output");
    yield JSON.stringify(
      toolOnly
        ? {
          id: "chatcmpl-tool-only",
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"query":"weather"}' },
              }],
            },
            finish_reason: null,
          }],
        }
        : {
          id: "chatcmpl-role-only",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
    );
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

  const toolResponse = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/default",
      messages: [{ role: "user", content: "disconnect after tool output" }],
      stream: true,
    }),
  });
  const toolReader = toolResponse.body?.getReader();
  assertExists(toolReader);
  assertEquals((await toolReader.read()).done, false);
  await toolReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterTool = await repository.usage(me.user.id);
  assertEquals(afterTool.calls, after.calls + 1);
  assertEquals(afterTool.balanceMicros < after.balanceMicros, true);
});

Deno.test("OpenAI routes reject upstream models that are not explicitly configured", async () => {
  const previousAllowedModels = Deno.env.get("OPENAI_ALLOWED_MODELS");
  const previousBaseUrl = Deno.env.get("OPENAI_BASE_URL");
  const previousApiKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_ALLOWED_MODELS", "advertised-but-unconfigured");
  Deno.env.delete("OPENAI_BASE_URL");
  Deno.env.delete("OPENAI_API_KEY");
  try {
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

    const webCatalog = await json(await app.request("/api/models", { headers: auth }));
    assertEquals(
      webCatalog.data.some((model: { id: string }) => model.id === "openai/default"),
      false,
    );
    const openAICatalog = await json(await app.request("/v1/models", { headers }));
    assertEquals(
      openAICatalog.data.some((model: { id: string }) => model.id === "openai/default"),
      false,
    );
    assertEquals(
      openAICatalog.data.some((model: { id: string }) =>
        model.id === "openai/advertised-but-unconfigured"
      ),
      false,
    );

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
      body: JSON.stringify({
        model: "openai/not-configured",
        input: "must not reach the provider",
      }),
    });
    assertEquals(responses.status, 404);
    assertEquals((await json(responses)).error.code, "model_not_found");
  } finally {
    previousAllowedModels === undefined
      ? Deno.env.delete("OPENAI_ALLOWED_MODELS")
      : Deno.env.set("OPENAI_ALLOWED_MODELS", previousAllowedModels);
    previousBaseUrl === undefined
      ? Deno.env.delete("OPENAI_BASE_URL")
      : Deno.env.set("OPENAI_BASE_URL", previousBaseUrl);
    previousApiKey === undefined
      ? Deno.env.delete("OPENAI_API_KEY")
      : Deno.env.set("OPENAI_API_KEY", previousApiKey);
  }
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

Deno.test("attachment and OpenAI Files routes enforce security, ownership, scopes, and immutable links", async () => {
  const objectStore = new TestObjectStore();
  const repository = new MemoryRepository();
  const providerRequests: ChatCompletionRequest[] = [];
  const streamProviderRequests: ChatCompletionRequest[] = [];
  const { app } = createApp({
    repository,
    setupToken: "files-setup",
    objectStore,
    attachmentContextMaxRawBytes: 128,
    webComplete: (request) => {
      providerRequests.push(structuredClone(request));
      const text = simulate(request);
      return Promise.resolve({
        text,
        inputTokens: 1,
        outputTokens: Math.max(1, Math.ceil(text.length / 4)),
      });
    },
    providerStream: async function* (request) {
      streamProviderRequests.push(structuredClone(request));
      yield JSON.stringify({
        id: "attachment-stream",
        model: request.model,
        choices: [{ index: 0, delta: { content: "streamed" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      yield "[DONE]";
    },
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "files-setup" },
    body: JSON.stringify({
      email: "files-admin@example.com",
      password: "correct horse battery",
      name: "Files Admin",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const admin = (await json(bootstrap)).user;
  const adminLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "files-admin@example.com",
      password: "correct horse battery",
    }),
  });
  const adminSession = {
    cookie: sessionCookie(adminLogin),
    origin: "http://localhost:5173",
  };
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "files-other@example.com",
      password: "correct horse battery",
      name: "Other Files User",
    }),
  });
  const other = (await json(signup)).user;
  let otherSession = {
    cookie: sessionCookie(signup),
    origin: "http://localhost:5173",
  };
  assertEquals(
    (await app.request(`/api/admin/users/${other.id}/approval`, {
      method: "PATCH",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    })).status,
    200,
  );
  const approvedOtherSignin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "files-other@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(approvedOtherSignin.status, 200);
  otherSession = {
    cookie: sessionCookie(approvedOtherSignin),
    origin: "http://localhost:5173",
  };

  const createToken = async (headers: Record<string, string>, scopes: string[]) => {
    const response = await app.request("/api/tokens", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: `Files ${scopes.join(" ")}`, scopes }),
    });
    assertEquals(response.status, 201);
    return (await json(response)).token as string;
  };
  const readOnly = await createToken(adminSession, ["files:read"]);
  const writeOnly = await createToken(adminSession, ["files:write"]);
  const adminToken = await createToken(adminSession, ["files:read", "files:write"]);
  const otherToken = await createToken(otherSession, ["files:read", "files:write"]);

  const deniedWrite = new FormData();
  deniedWrite.set("file", new File(["scope"], "scope.txt", { type: "text/plain" }));
  assertEquals(
    (await app.request("/v1/files", {
      method: "POST",
      headers: { authorization: `Bearer ${readOnly}` },
      body: formBody(deniedWrite),
    })).status,
    403,
  );
  assertEquals(
    (await app.request("/v1/files", {
      headers: { authorization: `Bearer ${writeOnly}` },
    })).status,
    403,
  );

  const webText = "immutable attachment bytes";
  const webForm = new FormData();
  webForm.set("file", new File([webText], "notes.txt", { type: "text/plain" }));
  const webUploadResponse = await app.request("/api/attachments", {
    method: "POST",
    headers: adminSession,
    body: formBody(webForm),
  });
  assertEquals(webUploadResponse.status, 201);
  const webUpload = (await json(webUploadResponse)).attachment;
  assertEquals(webUpload.filename, "notes.txt");
  assertEquals(webUpload.state, "ready");
  assertEquals(webUpload.ingestionStatus, "queued");
  assertEquals(JSON.stringify(webUpload).includes("objectKey"), false);
  assertEquals(JSON.stringify(webUpload).includes("sha256"), false);
  assertEquals(objectStore.objects.size, 1);
  assertEquals(
    (await app.request(`/api/attachments/${webUpload.id}/chunks`, { headers: adminSession }))
      .status,
    200,
  );
  assertEquals(
    (await app.request(`/api/attachments/${webUpload.id}/chunks`, { headers: otherSession }))
      .status,
    404,
  );
  repository.beginAttachmentIngestion(webUpload.id, admin.id);
  repository.failAttachmentIngestion(webUpload.id, admin.id, "missing object");
  const retry = await app.request(`/api/attachments/${webUpload.id}/ingestion/retry`, {
    method: "POST",
    headers: adminSession,
  });
  assertEquals(retry.status, 200);
  assertEquals((await json(retry)).attachment.ingestionStatus, "queued");
  assertEquals(
    (await app.request(`/api/attachments/${webUpload.id}/ingestion/retry`, {
      method: "POST",
      headers: otherSession,
    })).status,
    404,
  );

  const pngBytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  const imageForm = new FormData();
  imageForm.set("file", new File([pngBytes], "pixel.png", { type: "image/png" }));
  const imageUploadResponse = await app.request("/api/attachments", {
    method: "POST",
    headers: adminSession,
    body: formBody(imageForm),
  });
  assertEquals(imageUploadResponse.status, 201);
  const imageUpload = (await json(imageUploadResponse)).attachment;
  assertEquals(imageUpload.state, "ready");

  const scanFlood = new Uint8Array(200_000);
  scanFlood.set(pngBytes.slice(0, 24));
  for (let index = 0; index < 1_025; index++) {
    const offset = 64 + index * 64;
    scanFlood.set([0x4d, 0x5a], offset);
    new DataView(scanFlood.buffer).setUint32(offset + 0x3c, scanFlood.length - offset - 4, true);
  }
  const scanFloodForm = new FormData();
  scanFloodForm.set("file", new File([scanFlood], "scan-flood.png", { type: "image/png" }));
  const scanFloodResponse = await app.request("/api/attachments", {
    method: "POST",
    headers: adminSession,
    body: formBody(scanFloodForm),
  });
  assertEquals(scanFloodResponse.status, 201);
  const scanFloodAttachment = (await json(scanFloodResponse)).attachment;
  assertEquals(scanFloodAttachment.state, "quarantined");
  assertEquals(scanFloodAttachment.inspectionError, "security_scan_inconclusive");

  const webContent = await app.request(`/api/attachments/${webUpload.id}/content`, {
    headers: adminSession,
  });
  assertEquals(webContent.status, 200);
  assertEquals(await webContent.text(), webText);
  assertStringIncludes(webContent.headers.get("content-disposition") ?? "", "notes.txt");
  assertEquals(webContent.headers.get("x-content-type-options"), "nosniff");

  assertEquals(
    (await app.request(`/api/attachments/${webUpload.id}`, { headers: otherSession })).status,
    404,
  );
  assertEquals(
    (await app.request(`/v1/files/${webUpload.id}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })).status,
    404,
  );
  const otherFiles = await json(
    await app.request("/v1/files", {
      headers: { authorization: `Bearer ${otherToken}` },
    }),
  );
  assertEquals(otherFiles.data.some((file: { id: string }) => file.id === webUpload.id), false);

  const objectsBeforeRejectedUploads = objectStore.objects.size;
  const malicious = new FormData();
  malicious.set(
    "file",
    new File(["<!doctype html><script>alert(1)</script>"], "fake.txt", {
      type: "text/plain",
    }),
  );
  const maliciousResponse = await app.request("/api/attachments", {
    method: "POST",
    headers: adminSession,
    body: formBody(malicious),
  });
  assertEquals(maliciousResponse.status, 415);
  assertEquals((await json(maliciousResponse)).error.code, "unsupported_media_type");
  assertEquals(objectStore.objects.size, objectsBeforeRejectedUploads);

  const oversizeResponse = await app.request("/api/attachments", {
    method: "POST",
    headers: {
      ...adminSession,
      "content-type": "multipart/form-data; boundary=oversized-contract",
      "content-length": String(27 * 1024 * 1024),
    },
    body: "--oversized-contract--\r\n",
  });
  assertEquals(oversizeResponse.status, 413);
  assertEquals((await json(oversizeResponse)).error.code, "upload_too_large");
  assertEquals(objectStore.objects.size, objectsBeforeRejectedUploads);

  const conversationResponse = await app.request("/api/conversations", {
    method: "POST",
    headers: { ...adminSession, "content-type": "application/json" },
    body: JSON.stringify({ title: "Attachment branch" }),
  });
  const conversation = await json(conversationResponse);
  const emptyTextOnly = await app.request(`/api/conversations/${conversation.id}/generate`, {
    method: "POST",
    headers: { ...adminSession, "content-type": "application/json" },
    body: JSON.stringify({
      content: "   ",
      model: "simulated/dg-chat",
      parentId: null,
      expectedVersion: 0,
      idempotencyKey: "files-empty-text-only",
      attachmentIds: [],
    }),
  });
  assertEquals(emptyTextOnly.status, 422);

  const attachmentOnlyConversation = await json(
    await app.request("/api/conversations", {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({ title: "Attachment only" }),
    }),
  );
  const attachmentOnlyResponse = await app.request(
    `/api/conversations/${attachmentOnlyConversation.id}/generate`,
    {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({
        content: "   ",
        model: "simulated/dg-chat",
        parentId: null,
        expectedVersion: 0,
        idempotencyKey: "files-attachment-only",
        attachmentIds: [webUpload.id],
      }),
    },
  );
  assertEquals(attachmentOnlyResponse.status, 201);
  const attachmentOnly = await json(attachmentOnlyResponse);
  assertEquals(attachmentOnly.user.content, "");
  assertEquals(attachmentOnly.user.attachments.map((item: { id: string }) => item.id), [
    webUpload.id,
  ]);
  const attachmentOnlyParts = providerRequests[0].messages.at(-1)?.content;
  assertEquals(Array.isArray(attachmentOnlyParts), true);
  assertEquals(
    (attachmentOnlyParts as Array<{ type: string; text?: string }>).some((part) =>
      part.type === "text" && part.text === ""
    ),
    false,
  );
  const attachmentOnlyFollowup = await app.request(
    `/api/conversations/${attachmentOnlyConversation.id}/generate`,
    {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({
        content: "What is in it?",
        model: "simulated/dg-chat",
        parentId: attachmentOnly.assistant.id,
        expectedVersion: attachmentOnly.conversation.version,
        idempotencyKey: "files-attachment-only-followup",
        attachmentIds: [],
      }),
    },
  );
  assertEquals(attachmentOnlyFollowup.status, 201);
  const historicalAttachmentParts = providerRequests[1].messages.find((message) =>
    message.role === "user" && Array.isArray(message.content)
  )?.content;
  assertEquals(Array.isArray(historicalAttachmentParts), true);
  assertEquals(
    (historicalAttachmentParts as Array<{ type: string; text?: string }>).some((part) =>
      part.type === "text" && part.text === ""
    ),
    false,
  );

  const streamConversation = await json(
    await app.request("/api/conversations", {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({ title: "Stream attachment only" }),
    }),
  );
  const streamAttachmentOnly = await app.request(
    `/api/conversations/${streamConversation.id}/generate/stream`,
    {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "send",
        content: "   ",
        model: "simulated/dg-chat",
        parentId: null,
        expectedVersion: 0,
        idempotencyKey: "files-stream-attachment-only",
        attachmentIds: [webUpload.id],
      }),
    },
  );
  assertEquals(streamAttachmentOnly.status, 200);
  const streamEvents = (await streamAttachmentOnly.text()).split("\n")
    .filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const streamTerminal = streamEvents.at(-1);
  assertEquals(streamTerminal.type, "generation.completed");
  const streamCurrentParts = streamProviderRequests[0].messages.at(-1)?.content;
  assertEquals(Array.isArray(streamCurrentParts), true);
  assertEquals(
    (streamCurrentParts as Array<{ type: string; text?: string }>).some((part) =>
      part.type === "text" && part.text === ""
    ),
    false,
  );
  const streamFollowup = await app.request(
    `/api/conversations/${streamConversation.id}/generate/stream`,
    {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "send",
        content: "Describe it",
        model: "simulated/dg-chat",
        parentId: streamTerminal.assistant.id,
        expectedVersion: streamTerminal.conversation.version,
        idempotencyKey: "files-stream-attachment-followup",
        attachmentIds: [],
      }),
    },
  );
  assertEquals(streamFollowup.status, 200);
  await streamFollowup.text();
  const streamHistoricalParts = streamProviderRequests[1].messages.find((message) =>
    message.role === "user" && Array.isArray(message.content)
  )?.content;
  assertEquals(Array.isArray(streamHistoricalParts), true);
  assertEquals(
    (streamHistoricalParts as Array<{ type: string; text?: string }>).some((part) =>
      part.type === "text" && part.text === ""
    ),
    false,
  );

  const generationBody = JSON.stringify({
    content: "use the attachment",
    model: "simulated/dg-chat",
    parentId: null,
    expectedVersion: 0,
    idempotencyKey: "files-generation-link",
    attachmentIds: [webUpload.id, imageUpload.id],
  });
  const requestGeneration = () =>
    app.request(`/api/conversations/${conversation.id}/generate`, {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: generationBody,
    });
  const generationResponse = await requestGeneration();
  assertEquals(generationResponse.status, 201);
  const generation = await json(generationResponse);
  assertEquals(
    generation.user.attachments.map((item: { id: string }) => item.id).sort(),
    [webUpload.id, imageUpload.id].sort(),
  );
  assertEquals(JSON.stringify(generation.user.attachments).includes("objectKey"), false);
  assertStringIncludes(generation.assistant.content, webText);
  assertStringIncludes(generation.assistant.content, "[image]");
  assertEquals(providerRequests.length, 3);
  const immediateReplay = await requestGeneration();
  assertEquals(immediateReplay.status, 200);
  assertEquals(await json(immediateReplay), generation);

  assertEquals(
    (await app.request(`/api/attachments/${webUpload.id}`, {
      method: "DELETE",
      headers: adminSession,
    })).status,
    204,
  );
  assertEquals(
    (await app.request(`/api/attachments/${webUpload.id}/content`, {
      headers: adminSession,
    })).status,
    404,
  );
  const historicalContent = await app.request(
    `/api/messages/${generation.user.id}/attachments/${webUpload.id}/content`,
    { headers: adminSession },
  );
  assertEquals(historicalContent.status, 200);
  assertEquals(await historicalContent.text(), webText);
  const deletedAttachmentReplay = await requestGeneration();
  assertEquals(deletedAttachmentReplay.status, 200);
  const replayedAfterDelete = await json(deletedAttachmentReplay);
  assertEquals(replayedAfterDelete.user.id, generation.user.id);
  assertEquals(replayedAfterDelete.assistant.id, generation.assistant.id);
  assertEquals(
    replayedAfterDelete.user.attachments.find((item: { id: string }) => item.id === webUpload.id)
      ?.state,
    "deleted",
  );

  const followupResponse = await app.request(`/api/conversations/${conversation.id}/generate`, {
    method: "POST",
    headers: { ...adminSession, "content-type": "application/json" },
    body: JSON.stringify({
      content: "use the earlier attachment again",
      model: "simulated/dg-chat",
      parentId: generation.assistant.id,
      expectedVersion: generation.conversation.version,
      idempotencyKey: "files-generation-followup",
      attachmentIds: [],
    }),
  });
  assertEquals(followupResponse.status, 201);
  const followup = await json(followupResponse);
  assertEquals(providerRequests.length, 4);
  assertStringIncludes(JSON.stringify(providerRequests[3].messages), webText);
  assertStringIncludes(JSON.stringify(providerRequests[3].messages), "data:image/png;base64,");

  const aggregateOverflow = await app.request(`/api/conversations/${conversation.id}/generate`, {
    method: "POST",
    headers: { ...adminSession, "content-type": "application/json" },
    body: JSON.stringify({
      content: "attach the image again",
      model: "simulated/dg-chat",
      parentId: followup.assistant.id,
      expectedVersion: followup.conversation.version,
      idempotencyKey: "files-generation-aggregate-overflow",
      attachmentIds: [imageUpload.id],
    }),
  });
  assertEquals(aggregateOverflow.status, 413);
  assertEquals((await json(aggregateOverflow)).error.code, "attachment_context_too_large");
  assertEquals(providerRequests.length, 4);

  const overflowConversation = await json(
    await app.request("/api/conversations", {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({ title: "Context overflow" }),
    }),
  );
  const contextOverflow = await app.request(
    `/api/conversations/${overflowConversation.id}/generate`,
    {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({
        content: "x".repeat(128_001),
        model: "simulated/dg-chat",
        parentId: null,
        expectedVersion: 0,
        idempotencyKey: "files-generation-context-overflow",
        attachmentIds: [],
      }),
    },
  );
  assertEquals(contextOverflow.status, 422);
  assertEquals((await json(contextOverflow)).error.code, "context_length_exceeded");
  assertEquals(providerRequests.length, 4);

  const openAIText = "OpenAI file lifecycle bytes";
  const missingPurpose = new FormData();
  missingPurpose.set(
    "file",
    new File([openAIText], "missing-purpose.txt", {
      type: "text/plain",
    }),
  );
  const missingPurposeResponse = await app.request("/v1/files", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: formBody(missingPurpose),
  });
  assertEquals(missingPurposeResponse.status, 400);
  assertEquals((await json(missingPurposeResponse)).error.code, "missing_file_purpose");
  const unsupportedPurpose = new FormData();
  unsupportedPurpose.set("purpose", "fine-tune");
  unsupportedPurpose.set(
    "file",
    new File([openAIText], "unsupported.txt", { type: "text/plain" }),
  );
  const unsupportedPurposeResponse = await app.request("/v1/files", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: formBody(unsupportedPurpose),
  });
  assertEquals(unsupportedPurposeResponse.status, 400);
  assertEquals((await json(unsupportedPurposeResponse)).error.code, "unsupported_file_purpose");
  const openAIForm = new FormData();
  openAIForm.set("purpose", "assistants");
  openAIForm.set("file", new File([openAIText], "openai.txt", { type: "text/plain" }));
  const openAIUploadResponse = await app.request("/v1/files", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: formBody(openAIForm),
  });
  assertEquals(openAIUploadResponse.status, 201);
  const openAIUpload = await json(openAIUploadResponse);
  assertEquals(openAIUpload.object, "file");
  assertEquals(openAIUpload.status, "processed");
  assertEquals(openAIUpload.bytes, new TextEncoder().encode(openAIText).byteLength);
  assertEquals(JSON.stringify(openAIUpload).includes("objectKey"), false);
  assertEquals(JSON.stringify(openAIUpload).includes("sha256"), false);

  const listed = await json(
    await app.request("/v1/files", {
      headers: { authorization: `Bearer ${adminToken}` },
    }),
  );
  assertEquals(listed.object, "list");
  assertEquals(listed.has_more, false);
  assertEquals(listed.data.some((file: { id: string }) => file.id === openAIUpload.id), true);
  const retrieved = await json(
    await app.request(`/v1/files/${openAIUpload.id}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    }),
  );
  assertEquals(retrieved.id, openAIUpload.id);
  assertEquals(retrieved.filename, "openai.txt");
  const openAIContent = await app.request(`/v1/files/${openAIUpload.id}/content`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assertEquals(await openAIContent.text(), openAIText);
  const deletion = await app.request(`/v1/files/${openAIUpload.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assertEquals(deletion.status, 200);
  assertEquals(await json(deletion), { id: openAIUpload.id, object: "file", deleted: true });
  const afterDelete = await app.request(`/v1/files/${openAIUpload.id}/content`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assertEquals(afterDelete.status, 404);
  assertEquals((await json(afterDelete)).error.code, "not_found");
  assertEquals(objectStore.objects.size, 4);
  assertExists(admin.id);
});
