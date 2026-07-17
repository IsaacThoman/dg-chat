import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { canonicalJson, createApp, legacyModelHarnessAllowed } from "./app.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { DomainError, MemoryRepository } from "@dg-chat/database";
import { type IdentityMailer, TestIdentityMailer } from "./mail.ts";
import { TestObjectStore } from "./test-object-store.ts";
import { simulate } from "./models.ts";
import { sha256, sha256Hex } from "./crypto.ts";

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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for asynchronous test condition");
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

Deno.test("soft-deleted active users cannot sign in, reuse sessions, or use API tokens", async () => {
  const repository = new MemoryRepository();
  const mailer = new TestIdentityMailer();
  const { app } = createApp({ repository, setupToken: "deleted-user-setup", mailer });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "deleted-user-setup" },
    body: JSON.stringify({
      email: "deleted-auth@example.com",
      password: "correct horse battery",
      name: "Deleted Auth",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const identity = await json(bootstrap);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "deleted-auth@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(login.status, 200);
  const cookie = sessionCookie(login);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Deleted user token", scopes: ["models:read"] }),
  });
  assertEquals(tokenResponse.status, 201);
  const token = (await json(tokenResponse)).token as string;

  repository.users.get(identity.user.id)!.deletedAt = new Date().toISOString();
  assertEquals(repository.users.get(identity.user.id)!.state, "active");

  const protectedAction = await app.request("/api/conversations", { headers: { cookie } });
  assertEquals(protectedAction.status, 401);
  assertEquals((await json(protectedAction)).error.code, "unauthorized");
  const openAIRequest = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(openAIRequest.status, 401);
  assertEquals((await json(openAIRequest)).error.code, "unauthorized");
  const relogin = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "deleted-auth@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(relogin.status, 403);
  assertEquals((await json(relogin)).error.code, "account_unavailable");
  const resetRequest = await app.request("/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "deleted-auth@example.com" }),
  });
  assertEquals(resetRequest.status, 202);
  assertEquals(mailer.messages.length, 0);
});

Deno.test("Chat stream replay fragment overflow terminalizes durably", async () => {
  const repository = new MemoryRepository();
  let providerCalls = 0;
  const providerStream = async function* () {
    providerCalls++;
    for (let index = 0; index < 4; index++) {
      yield JSON.stringify({
        id: "chatcmpl-upstream",
        object: "chat.completion.chunk",
        created: 1,
        model: "upstream",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      });
    }
    yield JSON.stringify({
      id: "chatcmpl-upstream",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    yield "[DONE]";
  };
  const { app } = createApp({
    repository,
    setupToken: "chat-fragment-setup",
    providerStream,
    replayQuota: { maxRequests: 10, maxBytes: 64 * 1024 * 1024, maxEvents: 4 },
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "chat-fragment-setup" },
    body: JSON.stringify({
      email: "chat-fragments@example.com",
      password: "correct horse battery",
      name: "Fragment Admin",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "chat-fragments@example.com",
      password: "correct horse battery",
    }),
  });
  const cookie = sessionCookie(login);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Fragment test", scopes: ["chat:write"] }),
  });
  const token = (await json(tokenResponse)).token;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "chat-fragment-overflow",
  };
  const body = JSON.stringify({
    model: "openai/default",
    messages: [{ role: "user", content: "produce too many empty chunks" }],
    stream: true,
  });
  const response = await app.request("/v1/chat/completions", { method: "POST", headers, body });
  const responseText = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(responseText, "provider_error");
  const admin = (await repository.listUsers())[0];
  const stored = await repository.getApiRequest(
    admin.id,
    "chat.completions",
    "chat-fragment-overflow",
  );
  assertEquals(stored?.state, "failed");
  assertEquals(stored?.frames.length, 4);
  const replay = await app.request("/v1/chat/completions", { method: "POST", headers, body });
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await replay.text(), responseText);
  assertEquals(providerCalls, 1);
});

Deno.test("buffered Responses replay admits large output limits bounded by provider payloads", async () => {
  let providerCalls = 0;
  let providerStreamCalls = 0;
  const { app } = createApp({
    setupToken: "responses-buffered-bound",
    replayQuota: { maxRequests: 256, maxBytes: 128 * 1024 * 1024, maxEvents: 20_000 },
    providerComplete: () => {
      providerCalls++;
      return Promise.resolve({ text: "bounded result", inputTokens: 1, outputTokens: 2 });
    },
    providerStream: async function* () {
      providerStreamCalls++;
      yield JSON.stringify({
        id: "chatcmpl-high-output-bound",
        object: "chat.completion.chunk",
        created: 1,
        model: "upstream",
        choices: [{ index: 0, delta: { content: "bounded stream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
      yield "[DONE]";
    },
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "responses-buffered-bound",
    },
    body: JSON.stringify({
      email: "responses-buffered@example.com",
      password: "correct horse battery",
      name: "Responses Buffered",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "responses-buffered@example.com",
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
    body: JSON.stringify({ name: "Responses buffered", scopes: ["chat:write"] }),
  });
  const token = (await json(tokenResponse)).token;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "responses-buffered-large-output",
  };
  const body = JSON.stringify({
    model: "openai/default",
    input: "The normalized provider payload is the real buffered boundary",
    max_output_tokens: 8_192,
  });
  const response = await app.request("/v1/responses", { method: "POST", headers, body });
  const responseBody = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(responseBody, "bounded result");
  const replay = await app.request("/v1/responses", { method: "POST", headers, body });
  assertEquals(replay.status, 200);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await replay.text(), responseBody);
  assertEquals(providerCalls, 1);

  const streamHeaders = {
    ...headers,
    "idempotency-key": "responses-stream-high-output",
  };
  const streamBody = JSON.stringify({
    model: "openai/default",
    input: "Provider transport caps the actual streaming terminal",
    max_output_tokens: 131_072,
    stream: true,
  });
  const stream = await app.request("/v1/responses", {
    method: "POST",
    headers: streamHeaders,
    body: streamBody,
  });
  const streamText = await stream.text();
  assertEquals(stream.status, 200);
  assertStringIncludes(streamText, "response.completed");
  const streamReplay = await app.request("/v1/responses", {
    method: "POST",
    headers: streamHeaders,
    body: streamBody,
  });
  assertEquals(streamReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await streamReplay.text(), streamText);
  assertEquals(providerStreamCalls, 1);
});

Deno.test("Responses citation streams replay completely and overflow terminalizes durably", async () => {
  let providerCalls = 0;
  const providerStream = async function* (request: ChatCompletionRequest) {
    providerCalls++;
    const messages = JSON.stringify(request.messages);
    const overflow = messages.includes("overflow citations");
    const invalidRange = messages.includes("invalid citation range");
    const annotations = Array.from({ length: overflow ? 22 : 12 }, (_, index) => ({
      type: "url_citation",
      url_citation: {
        start_index: 0,
        end_index: invalidRange ? 2 : 1,
        title: "\u0000".repeat(8_192),
        url: `https://example.test/${index}/` + "a".repeat(16_000),
      },
    }));
    yield JSON.stringify({
      id: "chatcmpl-citations",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "x", annotations },
        finish_reason: null,
      }],
    });
    yield JSON.stringify({
      id: "chatcmpl-citations",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    yield "[DONE]";
  };
  const repository = new MemoryRepository();
  const { app } = createApp({
    repository,
    setupToken: "responses-citation-bound",
    providerStream,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "responses-citation-bound",
    },
    body: JSON.stringify({
      email: "responses-citations@example.com",
      password: "correct horse battery",
      name: "Responses Citations",
    }),
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "responses-citations@example.com",
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
    body: JSON.stringify({ name: "Responses citations", scopes: ["chat:write"] }),
  });
  const token = (await json(tokenResponse)).token;
  const request = async (input: string, key: string) => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    };
    const body = JSON.stringify({
      model: "openai/default",
      input,
      stream: true,
      max_output_tokens: 1,
    });
    return await app.request("/v1/responses", { method: "POST", headers, body });
  };

  const success = await request("near-limit citations", "responses-citations-success");
  const successBody = await success.text();
  assertEquals(success.status, 200);
  assertStringIncludes(successBody, "response.output_text.annotation.added");
  assertStringIncludes(successBody, "response.content_part.done");
  assertStringIncludes(successBody, "response.output_item.done");
  assertStringIncludes(successBody, "response.completed");
  const successReplay = await request("near-limit citations", "responses-citations-success");
  assertEquals(successReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await successReplay.text(), successBody);
  assertEquals(providerCalls, 1);

  const overflow = await request("overflow citations", "responses-citations-overflow");
  const overflowBody = await overflow.text();
  assertEquals(overflow.status, 200);
  assertStringIncludes(overflowBody, '"type":"error"');
  assertEquals(overflowBody.includes("replay_persistence_error"), false);
  const overflowReplay = await request("overflow citations", "responses-citations-overflow");
  assertEquals(overflowReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await overflowReplay.text(), overflowBody);
  assertEquals(providerCalls, 2);
  const owner = (await repository.listUsers())[0];
  assertEquals(
    (await repository.getApiRequest(owner.id, "responses", "responses-citations-overflow"))
      ?.state,
    "failed",
  );

  const invalidRange = await request(
    "invalid citation range",
    "responses-citations-invalid-range",
  );
  const invalidRangeBody = await invalidRange.text();
  assertEquals(invalidRange.status, 200);
  assertStringIncludes(invalidRangeBody, '"type":"error"');
  assertEquals(invalidRangeBody.includes("replay_persistence_error"), false);
  const invalidRangeReplay = await request(
    "invalid citation range",
    "responses-citations-invalid-range",
  );
  assertEquals(invalidRangeReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await invalidRangeReplay.text(), invalidRangeBody);
  assertEquals(providerCalls, 3);
});

Deno.test("preferences folders and tags are authenticated owner-scoped versioned APIs", async () => {
  let upstreamRequest: ChatCompletionRequest | undefined;
  const { app } = createApp({
    setupToken: "workspace-route",
    webComplete: (request) => {
      upstreamRequest = request;
      return Promise.resolve({ text: "done", inputTokens: 4, outputTokens: 1 });
    },
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "workspace-route" },
    body: JSON.stringify({
      email: "workspace-route@example.com",
      password: "correct horse battery",
      name: "Workspace",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "workspace-route@example.com",
      password: "correct horse battery",
    }),
  });
  const headers = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const preferencesResponse = await app.request("/api/preferences", { headers });
  assertEquals(preferencesResponse.status, 200);
  const preferences = await json(preferencesResponse);
  const updated = await app.request("/api/preferences", {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedVersion: preferences.version,
      theme: "dark",
      customInstructions: "Be exact.",
    }),
  });
  assertEquals(updated.status, 200, await updated.clone().text());
  const stale = await app.request("/api/preferences", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: preferences.version, theme: "light" }),
  });
  assertEquals(stale.status, 409);
  const chatResponse = await app.request("/api/conversations", {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ title: "Filed" }),
  });
  const chat = await json(chatResponse);
  const generated = await app.request(`/api/conversations/${chat.id}/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "hello",
      model: "simulated/dg-chat",
      parentId: null,
      supersedesId: null,
      expectedVersion: chat.version,
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  assertEquals(generated.status, 201, await generated.clone().text());
  assertEquals(upstreamRequest?.messages[0], { role: "system", content: "Be exact." });
  const first = await json(
    await app.request("/api/folders", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "folder-first-route" },
      body: JSON.stringify({ name: "First" }),
    }),
  );
  const firstReplay = await app.request("/api/folders", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "folder-first-route" },
    body: JSON.stringify({ name: "First" }),
  });
  assertEquals(firstReplay.status, 201);
  assertEquals((await json(firstReplay)).id, first.id);
  const folderDrift = await app.request("/api/folders", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "folder-first-route" },
    body: JSON.stringify({ name: "Different" }),
  });
  assertEquals(folderDrift.status, 409);
  const second = await json(
    await app.request("/api/folders", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "folder-second-route" },
      body: JSON.stringify({ name: "Second" }),
    }),
  );
  const filed = await app.request(`/api/folders/${first.id}/conversations`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      conversationIds: [chat.id],
      expectedMembershipVersions: { [first.id]: 0 },
    }),
  });
  assertEquals(filed.status, 200, await filed.clone().text());
  const unsafeMove = await app.request(`/api/folders/${second.id}/conversations`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      conversationIds: [chat.id],
      expectedMembershipVersions: { [second.id]: 0 },
    }),
  });
  assertEquals(unsafeMove.status, 409);
  const tag = await json(
    await app.request("/api/tags", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "tag-important-route" },
      body: JSON.stringify({ name: "Important", color: "#ff0000" }),
    }),
  );
  const tagReplay = await app.request("/api/tags", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "tag-important-route" },
    body: JSON.stringify({ name: "Important", color: "#ff0000" }),
  });
  assertEquals(tagReplay.status, 201);
  assertEquals((await json(tagReplay)).id, tag.id);
  const tagDrift = await app.request("/api/tags", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "tag-important-route" },
    body: JSON.stringify({ name: "Important", color: "#00ff00" }),
  });
  assertEquals(tagDrift.status, 409);
  const tagged = await app.request(`/api/conversations/${chat.id}/tags`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ tagIds: [tag.id], expectedVersion: 0 }),
  });
  assertEquals(tagged.status, 200, await tagged.clone().text());
  assertEquals((await json(tagged)).tagSet.version, 1);
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
    body: JSON.stringify({ status: "approved", expectedVersion: signed.user.version }),
  });
  assertEquals(approval.status, 200);
  const staleLimitedSession = await app.request("/api/conversations", {
    headers: userAuth,
  });
  assertEquals(staleLimitedSession.status, 403);
  assertEquals((await json(staleLimitedSession)).error.code, "session_refresh_required");
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
    body: JSON.stringify({
      title: "  Renamed chat  ",
      expectedVersion: generation.conversation.version,
    }),
  });
  assertEquals(renamedConversation.status, 200);
  assertEquals((await json(renamedConversation)).title, "Renamed chat");
  const oversizedTitle = await app.request(`/api/conversations/${conversation.id}`, {
    method: "PATCH",
    headers: userAuth,
    body: JSON.stringify({
      title: "x".repeat(201),
      expectedVersion: generation.conversation.version + 1,
    }),
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

  const oversizedMetadata = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "responses-metadata-too-large",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: "must fail before dispatch",
      stream: true,
      metadata: { trace: "x".repeat(513) },
    }),
  });
  assertEquals(oversizedMetadata.status, 422);
  assertEquals((await repository.usage(signed.user.id)).calls, 3);
  const oversizedProjectedTerminal = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "responses-terminal-too-large",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: "must fail before dispatch too",
      stream: true,
      max_output_tokens: 131_072,
    }),
  });
  assertEquals(oversizedProjectedTerminal.status, 413);
  assertEquals((await repository.usage(signed.user.id)).calls, 3);
  const { app: constrainedReplayApp } = createApp({
    repository,
    replayQuota: { maxRequests: 256, maxBytes: 1_048_576, maxEvents: 20_000 },
  });
  const constrainedChatReplay = await constrainedReplayApp.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "chat-constrained-replay",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "must fail before simulated provider work" }],
      stream: true,
    }),
  });
  assertEquals(constrainedChatReplay.status, 413);
  assertEquals((await repository.usage(signed.user.id)).calls, 3);
  const constrainedReplay = await constrainedReplayApp.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken.token}`,
      "content-type": "application/json",
      "idempotency-key": "responses-constrained-replay",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: "default output limit cannot fit this configured replay quota",
      stream: true,
    }),
  });
  assertEquals(constrainedReplay.status, 413);
  assertEquals((await repository.usage(signed.user.id)).calls, 3);

  let responseCompleteCalls = 0;
  let responseTerminalFrame: string | undefined;
  const completeApiStream = repository.completeApiStream.bind(repository);
  repository.completeApiStream = async (input) => {
    responseCompleteCalls++;
    responseTerminalFrame = input.terminalFrame;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
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
      metadata: { trace: "responses-stream-metadata" },
    }),
  });
  assertEquals(responseStream.status, 200);
  assertEquals(responseStream.headers.get("cache-control"), "no-cache");
  const responseEvents = await responseStream.text();
  assertStringIncludes(responseEvents, "event: response.created");
  assertStringIncludes(responseEvents, "event: response.output_text.delta");
  assertStringIncludes(responseEvents, "event: response.completed");
  assertStringIncludes(responseEvents, '"store":false');
  assertStringIncludes(responseEvents, '"trace":"responses-stream-metadata"');
  assertEquals(responseEvents.includes("[DONE]"), false);
  assertEquals(responseCompleteCalls, 1);
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
      metadata: { trace: "responses-stream-metadata" },
    }),
  });
  assertEquals(responseReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(responseReplay.headers.get("cache-control"), "no-cache");
  assertEquals(await responseReplay.text(), responseEvents);
  assertEquals((await repository.usage(signed.user.id)).calls, 4);
  const responseMetadataConflict = await app.request("/v1/responses", {
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
      metadata: { trace: "different-metadata" },
    }),
  });
  assertEquals(responseMetadataConflict.status, 409);
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
  assertEquals(failedPersistence.status, 200);
  assertStringIncludes(failedPersistence.headers.get("content-type") ?? "", "text/event-stream");
  assertStringIncludes(failedPersistenceBody, '"type":"error"');
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
  assertEquals(activeSession.current, true);
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

Deno.test("auth status keeps limited sessions pollable through approval and verification", async () => {
  const mailer = new TestIdentityMailer();
  const { app, repository } = createApp({
    mailer,
    requireEmailVerification: true,
  });
  const actor = await repository.bootstrapAdmin({
    email: "status-admin@example.com",
    name: "Status Administrator",
    passwordHash: "test-only-hash",
  }, 0);
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "status-transition@example.com",
      password: "correct horse battery",
      name: "Status Transition",
    }),
  });
  assertEquals(signup.status, 201);
  const signed = await json(signup);
  const limitedAuth = { cookie: sessionCookie(signup) };

  assertEquals(await json(await app.request("/api/auth/status", { headers: limitedAuth })), {
    approvalStatus: "pending",
    state: "active",
    emailVerified: false,
    emailVerificationRequired: true,
    sessionLimited: true,
    fullSessionEligible: false,
    fullAccess: false,
  });

  // Approved-but-unverified is a valid imported/configuration-transition state. Approval must
  // not elevate or destroy the status-only session.
  await repository.decideUserApproval({
    actorId: actor.id,
    targetUserId: signed.user.id,
    expectedVersion: signed.user.version,
    status: "approved",
    startingCreditMicros: 0,
    requireEmailVerification: false,
  });
  assertEquals(await json(await app.request("/api/auth/status", { headers: limitedAuth })), {
    approvalStatus: "approved",
    state: "active",
    emailVerified: false,
    emailVerificationRequired: true,
    sessionLimited: true,
    fullSessionEligible: false,
    fullAccess: false,
  });

  const verificationMessage = mailer.messages.findLast((message) =>
    message.kind === "email_verification"
  );
  assertExists(verificationMessage);
  assertStringIncludes(verificationMessage.url, "/verify-email#token=");
  const verificationToken = verificationMessage.token;
  assertExists(verificationToken);
  const verification = await app.request("/api/auth/verify-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: verificationToken }),
  });
  assertEquals(verification.status, 200);
  assertEquals(await json(await app.request("/api/auth/status", { headers: limitedAuth })), {
    approvalStatus: "approved",
    state: "active",
    emailVerified: true,
    emailVerificationRequired: true,
    sessionLimited: true,
    fullSessionEligible: true,
    fullAccess: false,
  });

  const blocked = await app.request("/api/conversations", { headers: limitedAuth });
  assertEquals(blocked.status, 403);
  assertEquals((await json(blocked)).error.code, "session_refresh_required");

  const freshLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "status-transition@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(freshLogin.status, 200);
  assertEquals(
    await json(
      await app.request("/api/auth/status", {
        headers: { cookie: sessionCookie(freshLogin) },
      }),
    ),
    {
      approvalStatus: "approved",
      state: "active",
      emailVerified: true,
      emailVerificationRequired: true,
      sessionLimited: false,
      fullSessionEligible: true,
      fullAccess: true,
    },
  );
});

Deno.test("rejected applicants retain only a status session", async () => {
  const { app, repository } = createApp();
  const actor = await repository.bootstrapAdmin({
    email: "rejection-admin@example.com",
    name: "Rejection Administrator",
    passwordHash: "test-only-hash",
  }, 0);
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "rejected-status@example.com",
      password: "correct horse battery",
      name: "Rejected Status",
    }),
  });
  const signed = await json(signup);
  const headers = { cookie: sessionCookie(signup) };
  await repository.decideUserApproval({
    actorId: actor.id,
    targetUserId: signed.user.id,
    expectedVersion: signed.user.version,
    status: "rejected",
    startingCreditMicros: 0,
    reason: "Exercise rejected status-session behavior",
  });
  assertEquals(await json(await app.request("/api/auth/status", { headers })), {
    approvalStatus: "rejected",
    state: "active",
    emailVerified: false,
    emailVerificationRequired: false,
    sessionLimited: true,
    fullSessionEligible: false,
    fullAccess: false,
  });
  const privileged = await app.request("/api/conversations", { headers });
  assertEquals(privileged.status, 403);
  assertEquals((await json(privileged)).error.code, "session_refresh_required");
});

Deno.test("a rejected unverified applicant can verify before reconsideration", async () => {
  const mailer = new TestIdentityMailer();
  const { app, repository } = createApp({ mailer, requireEmailVerification: true });
  const actor = await repository.bootstrapAdmin({
    email: "reconsideration-admin@example.com",
    name: "Reconsideration Administrator",
    passwordHash: "test-only-hash",
  }, 0);
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "reconsidered-applicant@example.com",
      password: "correct horse battery",
      name: "Reconsidered Applicant",
    }),
  });
  assertEquals(signup.status, 201);
  const signed = await json(signup);
  const statusCookie = sessionCookie(signup);
  const rejected = await repository.decideUserApproval({
    actorId: actor.id,
    targetUserId: signed.user.id,
    expectedVersion: signed.user.version,
    status: "rejected",
    startingCreditMicros: 0,
    reason: "Exercise verification before reconsideration",
  });
  const deliveriesBeforeResend = mailer.messages.length;

  const resend = await app.request("/api/auth/verify-email/request", {
    method: "POST",
    headers: {
      cookie: statusCookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
  });
  assertEquals(resend.status, 202, await resend.clone().text());
  assertEquals(mailer.messages.length, deliveriesBeforeResend + 1);
  const verificationToken = mailer.messages.at(-1)?.token;
  assertExists(verificationToken);
  const verification = await app.request("/api/auth/verify-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: verificationToken }),
  });
  assertEquals(verification.status, 200, await verification.clone().text());

  const approved = await repository.decideUserApproval({
    actorId: actor.id,
    targetUserId: signed.user.id,
    expectedVersion: rejected.version,
    status: "approved",
    startingCreditMicros: 0,
    requireEmailVerification: true,
  });
  assertEquals(approved.approvalStatus, "approved");
  assertEquals(approved.emailVerifiedAt !== null, true);
});

Deno.test("legacy identity tokens return stable safe errors and reset requests do not enumerate", async () => {
  const mailer = new TestIdentityMailer();
  const { app, repository } = createApp({ mailer, requireEmailVerification: true });
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "safe-errors@example.com",
      password: "correct horse battery",
      name: "Safe Errors",
    }),
  });
  const signed = await json(signup);
  const verificationToken = mailer.messages.findLast((message) =>
    message.kind === "email_verification"
  )?.token;
  assertExists(verificationToken);
  const expiredVerification = "verify_expired_contract_token_000000000000";
  const storedUser = await repository.findUser(signed.user.id);
  assertExists(storedUser);
  await repository.createIdentityToken(
    signed.user.id,
    "email_verification",
    await sha256(expiredVerification),
    new Date(Date.now() - 1_000).toISOString(),
    storedUser.authorityEpoch,
  );
  const verificationRequest = (token: string) =>
    app.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  assertEquals((await verificationRequest(verificationToken)).status, 200);
  for (
    const token of [
      "verify_invalid_contract_token_000000000000",
      expiredVerification,
      verificationToken,
    ]
  ) {
    const response = await verificationRequest(token);
    assertEquals(response.status, 400);
    assertEquals(await json(response), {
      error: {
        code: "invalid_identity_token",
        message: "Verification token is invalid or expired",
      },
    });
  }

  const knownReset = await app.request("/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "safe-errors@example.com" }),
  });
  const unknownReset = await app.request("/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-a-user@example.com" }),
  });
  assertEquals(knownReset.status, unknownReset.status);
  assertEquals(knownReset.status, 202);
  assertEquals(await knownReset.text(), await unknownReset.text());

  const resetMessage = mailer.messages.findLast((message) => message.kind === "password_reset");
  assertExists(resetMessage);
  assertStringIncludes(resetMessage.url, "/reset-password#token=");
  const resetToken = resetMessage.token;
  assertExists(resetToken);
  const expiredReset = "reset_expired_contract_token_0000000000000";
  await repository.createIdentityToken(
    signed.user.id,
    "password_reset",
    await sha256(expiredReset),
    new Date(Date.now() - 1_000).toISOString(),
    storedUser.authorityEpoch,
  );
  const resetRequest = (token: string) =>
    app.request("/api/auth/password-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "replacement correct horse battery" }),
    });
  assertEquals((await resetRequest(resetToken)).status, 204);
  for (
    const token of [
      "reset_invalid_contract_token_0000000000000",
      expiredReset,
      resetToken,
    ]
  ) {
    const response = await resetRequest(token);
    assertEquals(response.status, 400);
    assertEquals(await json(response), {
      error: {
        code: "invalid_identity_token",
        message: "Reset token is invalid or expired",
      },
    });
  }
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
      body: JSON.stringify({ status: "approved", expectedVersion: signed.user.version }),
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
  await waitFor(async () =>
    (await repository.listAudit()).data.some((event) =>
      event.action === "identity.password_reset_delivery_failed"
    )
  );
  assertEquals(
    (await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com" }),
    })).status,
    202,
  );
  const deliveryFailure = (await repository.listAudit()).data.find((event) =>
    event.action === "identity.password_reset_delivery_failed"
  );
  assertExists(deliveryFailure);
  assertEquals(deliveryFailure.actorId, null);
  assertEquals(deliveryFailure.targetId, signed.user.id);
});

Deno.test("password reset acceptance never awaits identity delivery", async () => {
  let deliveryStarted = false;
  let releaseDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  const blockedMailer: IdentityMailer = {
    send: () => {
      deliveryStarted = true;
      return deliveryGate;
    },
  };
  const { app, drainIdentityDeliveries } = createApp({
    setupToken: "async-reset-delivery",
    mailer: blockedMailer,
  });
  assertEquals(
    (await app.request("/api/setup/bootstrap", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-setup-token": "async-reset-delivery",
      },
      body: JSON.stringify({
        email: "async-reset@example.com",
        password: "correct horse battery",
        name: "Async Reset",
      }),
    })).status,
    201,
  );
  const accepted = await Promise.race([
    app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "async-reset@example.com" }),
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
  ]);
  assertExists(accepted);
  assertEquals(accepted.status, 202);
  await waitFor(() => deliveryStarted);
  let drained = false;
  const draining = drainIdentityDeliveries().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(drained, false);
  releaseDelivery();
  await draining;
  assertEquals(drained, true);
});

Deno.test("timed-out identity delivery drains and records a durable failure audit", async () => {
  const blockedMailer: IdentityMailer = { send: () => new Promise(() => {}) };
  const { app, repository, drainIdentityDeliveries } = createApp({
    setupToken: "timed-out-reset-delivery",
    mailer: blockedMailer,
    identityDeliveryTimeoutMs: 5,
  });
  const created = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "timed-out-reset-delivery",
    },
    body: JSON.stringify({
      email: "timed-out-reset@example.com",
      password: "correct horse battery",
      name: "Timed Out Reset",
    }),
  });
  assertEquals(created.status, 201);
  const user = (await created.json()).user as { id: string };

  assertEquals(
    (await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "timed-out-reset@example.com" }),
    })).status,
    202,
  );
  await drainIdentityDeliveries();
  const failure = (await repository.listAudit()).data.find((event) =>
    event.action === "identity.password_reset_delivery_outcome_unknown"
  );
  assertExists(failure);
  assertEquals(failure.actorId, null);
  assertEquals(failure.targetId, user.id);
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

Deno.test("identity token rate limits isolate token digests behind one proxy", async () => {
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
  const verify = (token: string) =>
    app.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  await verify("verify_first_identity_token_0000000000000000");
  await verify("verify_second_identity_token_000000000000000");
  assertEquals(keys.length, 4);
  assertEquals(keys[0].startsWith("auth:account:token:"), true);
  assertEquals(keys[2].startsWith("auth:account:token:"), true);
  assertEquals(keys[0] === keys[2], false);
  assertEquals(keys[1], keys[3]);
});

Deno.test("verification resend rate limits isolate session identities behind one proxy", async () => {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    consume: (key, limit) => {
      keys.push(key);
      return Promise.resolve({ allowed: true, limit, remaining: limit - 1, retryAfterSeconds: 60 });
    },
    health: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  const { app } = createApp({ rateLimiter: limiter, trustProxyHeaders: true });
  for (const session of ["first-session-token", "second-session-token"]) {
    await app.request("/api/auth/verify-email/request", {
      method: "POST",
      headers: {
        cookie: `dg_session=${session}`,
        "x-real-ip": "198.51.100.44",
      },
    });
  }
  assertEquals(keys.length, 4);
  assertEquals(keys[0].startsWith("auth:account:session:"), true);
  assertEquals(keys[2].startsWith("auth:account:session:"), true);
  assertEquals(keys[0] === keys[2], false);
  assertEquals(keys[1], "auth:client:198.51.100.44");
  assertEquals(keys[1], keys[3]);
  assertEquals(keys.some((key) => key.includes("unknown-account")), false);
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
  assertEquals(responsesOriginal.status, 200);
  assertStringIncludes(responsesOriginal.headers.get("content-type") ?? "", "text/event-stream");
  assertStringIncludes(responsesBody, "event: response.created");
  assertStringIncludes(responsesBody, "event: response.in_progress");
  assertStringIncludes(responsesBody, '"type":"error"');
  assertStringIncludes(responsesBody, '"param":null');
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
  let openAIProviderDispatches = 0;
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
    providerComplete: (request) => {
      openAIProviderDispatches++;
      const text = simulate(request);
      return Promise.resolve({
        text,
        inputTokens: 1,
        outputTokens: Math.max(1, Math.ceil(text.length / 4)),
      });
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
      body: JSON.stringify({ status: "approved", expectedVersion: other.version }),
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
  const adminToken = await createToken(adminSession, ["files:read", "files:write", "chat:write"]);
  const otherToken = await createToken(otherSession, ["files:read", "files:write"]);

  for (const [method, suffix] of [["GET", ""], ["GET", "/content"], ["DELETE", ""]]) {
    const invalidFileId = await app.request(`/v1/files/not-a-uuid${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${method === "DELETE" ? writeOnly : readOnly}`,
      },
    });
    assertEquals(invalidFileId.status, 400);
    assertEquals(await json(invalidFileId), {
      error: {
        message: "id must be a valid file identifier",
        type: "invalid_request_error",
        param: "id",
        code: "invalid_file_id",
      },
    });
  }

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

  const storedWebObject = objectStore.objects.values().next().value!;
  const expectedSha256 = storedWebObject.metadata.sha256;
  storedWebObject.metadata.sha256 = "0".repeat(64);
  const corruptMetadata = await app.request(`/api/attachments/${webUpload.id}/content`, {
    headers: adminSession,
  });
  assertEquals(corruptMetadata.status, 503);
  assertEquals((await json(corruptMetadata)).error.code, "attachment_corrupt");
  storedWebObject.metadata.sha256 = expectedSha256;

  const expectedOwner = storedWebObject.metadata.owner;
  storedWebObject.metadata.owner = other.id;
  const corruptOwner = await app.request(`/api/attachments/${webUpload.id}/content`, {
    headers: adminSession,
  });
  assertEquals(corruptOwner.status, 503);
  assertEquals((await json(corruptOwner)).error.code, "attachment_corrupt");
  storedWebObject.metadata.owner = expectedOwner;

  const expectedContentType = storedWebObject.contentType;
  storedWebObject.contentType = "application/octet-stream";
  const corruptContentType = await app.request(`/v1/files/${webUpload.id}/content`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assertEquals(corruptContentType.status, 503);
  assertEquals((await json(corruptContentType)).error.code, "attachment_corrupt");
  storedWebObject.contentType = expectedContentType;

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

  const integrityGeneration = async (idempotencyKey: string) => {
    const integrityConversation = await json(
      await app.request("/api/conversations", {
        method: "POST",
        headers: { ...adminSession, "content-type": "application/json" },
        body: JSON.stringify({ title: "Attachment integrity" }),
      }),
    );
    return await app.request(`/api/conversations/${integrityConversation.id}/generate`, {
      method: "POST",
      headers: { ...adminSession, "content-type": "application/json" },
      body: JSON.stringify({
        content: "Read the stored attachment",
        model: "simulated/dg-chat",
        parentId: null,
        expectedVersion: integrityConversation.version,
        idempotencyKey,
        attachmentIds: [webUpload.id],
      }),
    });
  };
  const providerRequestsBeforeCorruption = providerRequests.length;
  storedWebObject.metadata.owner = other.id;
  const corruptProviderOwner = await integrityGeneration("files-provider-owner-corruption");
  assertEquals(corruptProviderOwner.status, 503);
  assertEquals((await json(corruptProviderOwner)).error.code, "attachment_corrupt");
  assertEquals(providerRequests.length, providerRequestsBeforeCorruption);
  storedWebObject.metadata.owner = expectedOwner;

  const originalWebBytes = storedWebObject.bytes.slice();
  storedWebObject.bytes[0] ^= 1;
  const corruptProviderBody = await integrityGeneration("files-provider-body-corruption");
  assertEquals(corruptProviderBody.status, 503);
  assertEquals((await json(corruptProviderBody)).error.code, "attachment_corrupt");
  assertEquals(providerRequests.length, providerRequestsBeforeCorruption);
  storedWebObject.bytes.set(originalWebBytes);

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
  const originalObjectGet = objectStore.get.bind(objectStore);
  let responseObjectGets = 0;
  let lyingObjectKey: string | undefined;
  let lyingBodyCancelled = false;
  objectStore.get = async (key) => {
    responseObjectGets++;
    const stored = await originalObjectGet(key);
    if (!stored || key !== lyingObjectKey) return stored;
    const source = objectStore.objects.get(key)!;
    return {
      ...stored,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(source.bytes.slice());
          controller.enqueue(new Uint8Array([0]));
        },
        cancel() {
          lyingBodyCancelled = true;
        },
      }),
    };
  };
  const openAIObjectKey = [...objectStore.objects.entries()].find(([, object]) =>
    new TextDecoder().decode(object.bytes) === openAIText
  )?.[0];
  assertExists(openAIObjectKey);
  const storedOpenAIObjectForOwnerCheck = objectStore.objects.get(openAIObjectKey);
  assertExists(storedOpenAIObjectForOwnerCheck);
  const expectedResponseOwner = storedOpenAIObjectForOwnerCheck.metadata.owner;
  delete storedOpenAIObjectForOwnerCheck.metadata.owner;
  const usageBeforeMissingOwner = repository.usageRuns.size;
  const dispatchesBeforeMissingOwner = openAIProviderDispatches;
  const missingOwner = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: [{
        role: "user",
        content: [{ type: "input_file", file_id: openAIUpload.id }],
      }],
    }),
  });
  assertEquals(missingOwner.status, 503);
  assertEquals((await json(missingOwner)).error.code, "attachment_corrupt");
  assertEquals(openAIProviderDispatches, dispatchesBeforeMissingOwner);
  assertEquals(repository.usageRuns.size, usageBeforeMissingOwner);
  storedOpenAIObjectForOwnerCheck.metadata.owner = expectedResponseOwner;
  lyingObjectKey = openAIObjectKey;
  const usageBeforeLyingBody = repository.usageRuns.size;
  const dispatchesBeforeLyingBody = openAIProviderDispatches;
  const lyingBody = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: [{
        role: "user",
        content: [{ type: "input_file", file_id: openAIUpload.id }],
      }],
    }),
  });
  assertEquals(lyingBody.status, 503);
  assertEquals((await json(lyingBody)).error.code, "attachment_corrupt");
  assertEquals(lyingBodyCancelled, true);
  assertEquals(openAIProviderDispatches, dispatchesBeforeLyingBody);
  assertEquals(repository.usageRuns.size, usageBeforeLyingBody);
  lyingObjectKey = undefined;
  const responseWithFilesRequest = {
    model: "simulated/dg-chat",
    store: false,
    metadata: { contract: "uploaded-files" },
    user: "files-contract-user",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Read these uploads" },
        { type: "input_file", file_id: openAIUpload.id },
        { type: "input_image", file_id: imageUpload.id, detail: "low" },
      ],
    }],
  };
  const responseWithFiles = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      "idempotency-key": "responses-uploaded-files-replay",
    },
    body: JSON.stringify(responseWithFilesRequest),
  });
  assertEquals(responseWithFiles.status, 200);
  const responseWithFilesBody = await json(responseWithFiles);
  assertStringIncludes(responseWithFilesBody.output_text, openAIText);
  assertStringIncludes(responseWithFilesBody.output_text, "[image]");
  assertEquals(responseWithFilesBody.store, false);
  assertEquals(responseWithFilesBody.metadata, { contract: "uploaded-files" });
  assertEquals(responseWithFilesBody.user, "files-contract-user");

  const storedOpenAIObject = objectStore.objects.get(openAIObjectKey);
  assertExists(storedOpenAIObject);
  objectStore.objects.delete(openAIObjectKey);
  const getsBeforeResponseReplay = responseObjectGets;
  const driftedResponseReplay = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      "idempotency-key": "responses-uploaded-files-replay",
    },
    body: JSON.stringify({ ...responseWithFilesRequest, user: "different-user" }),
  });
  assertEquals(driftedResponseReplay.status, 409);
  assertEquals((await json(driftedResponseReplay)).error.code, "idempotency_conflict");
  assertEquals(responseObjectGets, getsBeforeResponseReplay);
  const responseWithFilesReplay = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      "idempotency-key": "responses-uploaded-files-replay",
    },
    body: JSON.stringify(responseWithFilesRequest),
  });
  assertEquals(responseWithFilesReplay.status, responseWithFiles.status);
  assertEquals(responseWithFilesReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await json(responseWithFilesReplay), responseWithFilesBody);
  assertEquals(responseObjectGets, getsBeforeResponseReplay);

  const inProgressResponse = [...repository.apiIdempotencyRequests.values()].find((candidate) =>
    candidate.userId === admin.id && candidate.endpoint === "responses" &&
    candidate.idempotencyKey === "responses-uploaded-files-replay"
  );
  assertExists(inProgressResponse);
  const originalReplayState = inProgressResponse.state;
  const originalReplayModel = inProgressResponse.model;
  inProgressResponse.state = "in_progress";
  inProgressResponse.model = "deleted/model";
  inProgressResponse.leaseExpiresAt = new Date(Date.now() + 5_000).toISOString();
  const dispatchesBeforeInProgress = openAIProviderDispatches;
  const usageBeforeInProgress = repository.usageRuns.size;
  const inProgress = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      "idempotency-key": "responses-uploaded-files-replay",
    },
    body: JSON.stringify(responseWithFilesRequest),
  });
  assertEquals(inProgress.status, 409);
  assertEquals((await json(inProgress)).error.code, "idempotency_in_progress");
  assertEquals(Number(inProgress.headers.get("retry-after")) >= 1, true);
  assertEquals(responseObjectGets, getsBeforeResponseReplay);
  assertEquals(openAIProviderDispatches, dispatchesBeforeInProgress);
  assertEquals(repository.usageRuns.size, usageBeforeInProgress);
  inProgressResponse.state = originalReplayState;
  inProgressResponse.model = originalReplayModel;
  objectStore.objects.set(openAIObjectKey, storedOpenAIObject);

  const getsBeforeRepeatedFile = responseObjectGets;
  const dispatchesBeforeRepeatedFile = openAIProviderDispatches;
  const usageBeforeRepeatedFile = repository.usageRuns.size;
  const repeatedFile = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: [{
        role: "user",
        content: Array.from(
          { length: 3 },
          () => ({ type: "input_file", file_id: openAIUpload.id }),
        ),
      }],
    }),
  });
  assertEquals(repeatedFile.status, 200, await repeatedFile.clone().text());
  assertEquals(responseObjectGets - getsBeforeRepeatedFile, 1);
  assertEquals(openAIProviderDispatches - dispatchesBeforeRepeatedFile, 1);
  assertEquals(repository.usageRuns.size - usageBeforeRepeatedFile, 1);

  const getsBeforeReferenceOverflow = responseObjectGets;
  const dispatchesBeforeReferenceOverflow = openAIProviderDispatches;
  const usageBeforeReferenceOverflow = repository.usageRuns.size;
  const referenceOverflow = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: [{
        role: "user",
        content: Array.from(
          { length: 17 },
          () => ({ type: "input_file", file_id: crypto.randomUUID() }),
        ),
      }],
    }),
  });
  assertEquals(referenceOverflow.status, 413);
  assertEquals((await json(referenceOverflow)).error.code, "response_input_files_too_large");
  assertEquals(responseObjectGets, getsBeforeReferenceOverflow);
  assertEquals(openAIProviderDispatches, dispatchesBeforeReferenceOverflow);
  assertEquals(repository.usageRuns.size, usageBeforeReferenceOverflow);

  const largeText = "a".repeat(1_500_000);
  const largeForm = new FormData();
  largeForm.set("purpose", "assistants");
  largeForm.set("file", new File([largeText], "large.txt", { type: "text/plain" }));
  const largeUploadResponse = await app.request("/v1/files", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: formBody(largeForm),
  });
  assertEquals(largeUploadResponse.status, 201);
  const largeUpload = await json(largeUploadResponse);
  const getsBeforeExpandedOverflow = responseObjectGets;
  const dispatchesBeforeExpandedOverflow = openAIProviderDispatches;
  const usageBeforeExpandedOverflow = repository.usageRuns.size;
  const expandedOverflow = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      input: [{
        role: "user",
        content: Array.from(
          { length: 3 },
          () => ({ type: "input_file", file_id: largeUpload.id }),
        ),
      }],
    }),
  });
  assertEquals(expandedOverflow.status, 413);
  assertEquals((await json(expandedOverflow)).error.code, "response_input_files_too_large");
  assertEquals(responseObjectGets - getsBeforeExpandedOverflow, 1);
  assertEquals(openAIProviderDispatches, dispatchesBeforeExpandedOverflow);
  assertEquals(repository.usageRuns.size, usageBeforeExpandedOverflow);

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
  assertEquals(objectStore.objects.size, 5);
  assertExists(admin.id);
});
