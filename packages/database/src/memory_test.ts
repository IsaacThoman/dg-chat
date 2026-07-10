import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

Deno.test("message edits append immutable sibling branches", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "u@example.com",
    name: "User",
    passwordHash: "x",
    approvalStatus: "approved",
  });
  const conversation = repo.createConversation(user.id, "Branches");
  const original = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    role: "user",
    content: "first",
    expectedVersion: 0,
    idempotencyKey: "request-0001",
  });
  const edited = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    supersedesId: original.id,
    role: "user",
    content: "edited",
    expectedVersion: 1,
    idempotencyKey: "request-0002",
  });
  assertEquals(original.content, "first");
  assertEquals(edited.siblingIndex, 1);
  assertEquals(edited.supersedesId, original.id);
  assertEquals(repo.detail(conversation.id, user.id).messages.length, 2);
});

Deno.test("optimistic versioning prevents lost updates and idempotency replays safely", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "u@example.com", name: "User", passwordHash: "x" });
  const conversation = repo.createConversation(user.id, "Race");
  const input = {
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    role: "user" as const,
    content: "hello",
    expectedVersion: 0,
    idempotencyKey: "request-0001",
  };
  const first = repo.appendMessage(input);
  assertEquals(repo.appendMessage(input).id, first.id);
  assertThrows(
    () => repo.appendMessage({ ...input, idempotencyKey: "request-0002" }),
    DomainError,
    "another tab",
  );
});

Deno.test("archived and deleted conversations reject new graph mutations", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "readonly@example.com", name: "User", passwordHash: "x" });
  repo.credit(user.id, "readonly-grant", "grant", 1_000_000);
  const conversation = repo.createConversation(user.id, "Read only");
  const root = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    role: "user",
    content: "root",
    expectedVersion: 0,
    idempotencyKey: "readonly-root",
  });

  const assertReadOnly = () => {
    assertThrows(
      () =>
        repo.appendMessage({
          conversationId: conversation.id,
          ownerId: user.id,
          parentId: root.id,
          role: "user",
          content: "blocked",
          expectedVersion: conversation.version,
          idempotencyKey: `readonly-message-${conversation.version}`,
        }),
      DomainError,
      "read-only",
    );
    assertThrows(
      () =>
        repo.beginGeneration({
          message: {
            conversationId: conversation.id,
            ownerId: user.id,
            parentId: root.id,
            role: "user",
            content: "blocked generation",
            model: "simulated/dg-chat",
            expectedVersion: conversation.version,
            idempotencyKey: `readonly-generation-${conversation.version}`,
          },
          runId: `readonly-run-${conversation.version}`,
          provider: "simulated",
          reserveMicros: 1,
        }),
      DomainError,
      "read-only",
    );
    assertThrows(
      () => repo.setActiveLeaf(conversation.id, user.id, root.id, conversation.version),
      DomainError,
      "read-only",
    );
  };

  repo.updateConversation(user.id, conversation.id, { archived: true });
  assertReadOnly();
  repo.updateConversation(user.id, conversation.id, { archived: false, deleted: true });
  assertReadOnly();
});

Deno.test("generation leases allow one owner and fence expired workers", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "lease@example.com", name: "Lease", passwordHash: "x" });
  repo.credit(user.id, "lease-grant", "grant", 1_000_000);
  const conversation = repo.createConversation(user.id, "Lease");
  const input = {
    message: {
      conversationId: conversation.id,
      ownerId: user.id,
      parentId: null,
      role: "user" as const,
      content: "generate once",
      model: "simulated/dg-chat",
      expectedVersion: 0,
      idempotencyKey: "lease-user",
    },
    runId: "lease-run",
    provider: "simulated",
    reserveMicros: 100,
    leaseSeconds: 60,
  };
  const started = repo.beginGeneration(input);
  if (started.kind !== "started") throw new Error("generation did not start");
  assertEquals(repo.beginGeneration(input).kind, "in_progress");
  started.usageRun.generationLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  const claimed = repo.beginGeneration(input);
  if (claimed.kind !== "claimed") throw new Error("generation was not reclaimed");
  assertEquals(repo.beginGeneration(input).kind, "in_progress");
  assertThrows(
    () =>
      repo.completeGeneration({
        conversationId: conversation.id,
        ownerId: user.id,
        userMessageId: started.message.id,
        runId: input.runId,
        leaseToken: started.leaseToken,
        idempotencyKey: "lease-assistant-old",
        content: "stale",
        model: "simulated/dg-chat",
        costMicros: 10,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      }),
    DomainError,
    "lease",
  );
  repo.heartbeatGeneration(input.runId, user.id, claimed.leaseToken, 60);
  const completed = repo.completeGeneration({
    conversationId: conversation.id,
    ownerId: user.id,
    userMessageId: claimed.message.id,
    runId: input.runId,
    leaseToken: claimed.leaseToken,
    idempotencyKey: "lease-assistant",
    content: "owned",
    model: "simulated/dg-chat",
    costMicros: 10,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  });
  assertEquals(completed.message.content, "owned");
  assertEquals(completed.usageRun.generationLeaseToken, null);

  const second = repo.createConversation(user.id, "Reaper");
  const abandoned = repo.beginGeneration({
    ...input,
    message: {
      ...input.message,
      conversationId: second.id,
      expectedVersion: 0,
      idempotencyKey: "reaper-user",
    },
    runId: "reaper-run",
  });
  if (abandoned.kind !== "started") throw new Error("reaper generation did not start");
  abandoned.usageRun.generationLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  assertEquals(repo.reapStaleGenerations(), 1);
  assertEquals(repo.reapStaleGenerations(), 0);
  assertEquals(abandoned.usageRun.status, "failed");
});

Deno.test("ledger reserve settle and refund are idempotent", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "u@example.com", name: "User", passwordHash: "x" });
  repo.credit(user.id, "grant", "grant", 5_000_000);
  repo.reserve(user.id, "run-1", "simulated/dg-chat", 10_000);
  repo.settle("run-1", 100, 10, 20, 5);
  repo.settle("run-1", 100, 10, 20, 5);
  assertEquals(user.balanceMicros, 4_999_900);
  assertEquals(repo.usage(user.id).spentMicros, 100);
});

Deno.test("replays authorize and reject payload mismatch; active leaf must be terminal", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "owner@example.com", name: "Owner", passwordHash: "x" });
  const stranger = repo.createUser({
    email: "stranger@example.com",
    name: "Stranger",
    passwordHash: "x",
  });
  const chat = repo.createConversation(owner.id, "Chat", false, "create-key");
  assertEquals(repo.createConversation(owner.id, "Chat", false, "create-key").id, chat.id);
  assertThrows(() => repo.createConversation(owner.id, "Other", false, "create-key"), DomainError);
  const root = repo.appendMessage({
    conversationId: chat.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "one",
    expectedVersion: 0,
    idempotencyKey: "message-key",
  });
  assertThrows(
    () =>
      repo.appendMessage({
        conversationId: chat.id,
        ownerId: stranger.id,
        parentId: null,
        role: "user",
        content: "one",
        expectedVersion: 1,
        idempotencyKey: "message-key",
      }),
    DomainError,
  );
  assertThrows(
    () =>
      repo.appendMessage({
        conversationId: chat.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "different",
        expectedVersion: 1,
        idempotencyKey: "message-key",
      }),
    DomainError,
  );
  repo.appendMessage({
    conversationId: chat.id,
    ownerId: owner.id,
    parentId: root.id,
    role: "assistant",
    content: "two",
    expectedVersion: 1,
    idempotencyKey: "child-key",
  });
  assertThrows(() => repo.setActiveLeaf(chat.id, owner.id, root.id, 2), DomainError, "leaf");
});

Deno.test("approval grant is minted once and rejection revokes sessions and tokens", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "approval@example.com",
    name: "Approval",
    passwordHash: "x",
    emailVerified: true,
  });
  repo.approveUser(user.id, "approved", 100);
  repo.reserve(user.id, "spend", "model", 100);
  repo.settle("spend", 100, 1, 1, 1);
  repo.approveUser(user.id, "rejected", 100);
  repo.approveUser(user.id, "approved", 100);
  assertEquals(user.balanceMicros, 0);
  repo.createSession(user.id, "session", false);
  const token = repo.createApiToken(user.id, {
    name: "token",
    scopes: ["chat:write"],
    tokenHash: "hash",
    preview: "hash",
  });
  repo.approveUser(user.id, "rejected", 100);
  assertEquals(repo.getSession("session"), undefined);
  assertEquals(Boolean(token.revokedAt), true);
});

Deno.test("identity tokens are one-time and password reset invalidates credentials", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "identity@example.com",
    name: "Identity",
    passwordHash: "old",
  });
  assertThrows(() => repo.approveUser(user.id, "approved", 10, true), DomainError, "verified");
  repo.createIdentityToken(
    user.id,
    "email_verification",
    "verify-hash",
    new Date(Date.now() + 60_000).toISOString(),
  );
  repo.createIdentityToken(
    user.id,
    "email_verification",
    "verify-hash-concurrent",
    new Date(Date.now() + 60_000).toISOString(),
  );
  assertEquals(repo.verifyEmail("verify-hash").emailVerifiedAt !== null, true);
  assertEquals(repo.verifyEmail("verify-hash-concurrent").emailVerifiedAt !== null, true);
  assertThrows(() => repo.verifyEmail("verify-hash"), DomainError, "invalid or expired");
  const session = repo.createSession(user.id, "session-hash", false);
  const token = repo.createApiToken(user.id, {
    name: "token",
    scopes: ["chat:write"],
    tokenHash: "api-hash",
    preview: "api…hash",
  });
  repo.createIdentityToken(
    user.id,
    "password_reset",
    "reset-hash",
    new Date(Date.now() + 60_000).toISOString(),
  );
  repo.createIdentityToken(
    user.id,
    "password_reset",
    "reset-hash-concurrent",
    new Date(Date.now() + 60_000).toISOString(),
  );
  repo.resetPassword("reset-hash", "new");
  assertEquals(repo.getSession("session-hash"), undefined);
  assertEquals(repo.findApiTokenByHash("api-hash")?.revokedAt !== null, true);
  assertThrows(() => repo.resetPassword("reset-hash", "again"), DomainError, "invalid or expired");
  assertThrows(
    () => repo.resetPassword("reset-hash-concurrent", "again"),
    DomainError,
    "invalid or expired",
  );
  assertThrows(() => repo.revokeSession(session.id, user.id), DomainError, "not found");
  assertEquals(token.userId, user.id);
});

Deno.test("durable API idempotency lifecycle reserves once, replays frames, and fences stale leases", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "api-replay@example.com",
    name: "Replay",
    passwordHash: "x",
  });
  repo.credit(user.id, "replay-grant", "grant", 1_000_000);
  const input = {
    userId: user.id,
    endpoint: "chat.completions" as const,
    idempotencyKey: "replay-request-0001",
    requestHash: "a".repeat(64),
    stream: true,
    model: "test/model",
    runId: "replay-run-1",
    reserveMicros: 100_000,
    provider: "test",
  };
  const begun = repo.beginApiRequest(input);
  assertEquals(begun.kind, "started");
  if (begun.kind !== "started") throw new Error("expected started request");
  assertEquals(repo.beginApiRequest(input).kind, "in_progress");
  assertEquals(user.balanceMicros, 900_000);
  repo.appendApiSseFrame(begun.request.id, begun.leaseToken, 0, 'data: {"delta":"hi"}\n\n');
  const completed = repo.completeApiStream({
    id: begun.request.id,
    leaseToken: begun.leaseToken,
    responseStatus: 200,
    terminalFrame: "data: [DONE]\n\n",
    costMicros: 25_000,
    inputTokens: 10,
    outputTokens: 2,
    latencyMs: 5,
  });
  assertEquals(completed.frames.map((frame) => frame.frame), [
    'data: {"delta":"hi"}\n\n',
    "data: [DONE]\n\n",
  ]);
  assertEquals(repo.beginApiRequest(input).kind, "completed");
  assertEquals(user.balanceMicros, 975_000);
  assertThrows(
    () => repo.beginApiRequest({ ...input, requestHash: "b".repeat(64) }),
    DomainError,
    "payload differs",
  );
  repo.apiIdempotencyRequests.get(completed.id)!.expiresAt = new Date(0).toISOString();
  assertEquals(repo.pruneExpiredApiRequests(), 1);
  const reused = repo.beginApiRequest({ ...input, runId: "replay-run-1-reused" });
  assertEquals(reused.kind, "started");
  if (reused.kind !== "started") throw new Error("expected reused key to start");
  repo.failApiRequest({
    id: reused.request.id,
    leaseToken: reused.leaseToken,
    responseStatus: 500,
    responseBody: '{"error":"cancelled"}',
    billing: { mode: "refund" },
  });
  assertEquals(repo.usageRuns.has("replay-run-1"), true);
  assertEquals(repo.usageRuns.has("replay-run-1-reused"), true);

  const stale = repo.beginApiRequest({
    ...input,
    idempotencyKey: "replay-request-0002",
    runId: "replay-run-2",
  });
  if (stale.kind !== "started") throw new Error("expected started request");
  repo.apiIdempotencyRequests.get(stale.request.id)!.leaseExpiresAt = new Date(0).toISOString();
  assertThrows(
    () => repo.appendApiSseFrame(stale.request.id, stale.leaseToken, 0, "data: stale\n\n"),
    DomainError,
    "lease",
  );
  assertThrows(
    () => repo.heartbeatApiRequest(stale.request.id, stale.leaseToken),
    DomainError,
    "lease",
  );
  assertThrows(
    () =>
      repo.completeApiJson({
        id: stale.request.id,
        leaseToken: stale.leaseToken,
        responseStatus: 200,
        responseBody: "{}",
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      }),
    DomainError,
    "lease",
  );
  assertThrows(
    () =>
      repo.failApiRequest({
        id: stale.request.id,
        leaseToken: stale.leaseToken,
        responseStatus: 500,
        responseBody: "{}",
        billing: { mode: "refund" },
      }),
    DomainError,
    "lease",
  );
  assertEquals(repo.reapStaleApiRequests(), 1);
  assertEquals(repo.getApiRequest(user.id, input.endpoint, "replay-request-0002")?.state, "failed");
  repo.apiIdempotencyRequests.get(stale.request.id)!.expiresAt = new Date(0).toISOString();
  assertEquals(repo.pruneExpiredApiRequests(), 1);
});

Deno.test("durable API SSE batches validate atomically and preserve contiguous order", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "api-batch@example.com",
    name: "Batch",
    passwordHash: "x",
  });
  repo.credit(user.id, "batch-grant", "grant", 1_000_000);
  const begun = repo.beginApiRequest({
    userId: user.id,
    endpoint: "responses",
    idempotencyKey: "batch-request-0001",
    requestHash: "e".repeat(64),
    stream: true,
    model: "test/model",
    runId: "batch-run-1",
    reserveMicros: 100_000,
    provider: "test",
  });
  if (begun.kind !== "started") throw new Error("expected started request");
  const frames = [
    { sequence: 0, frame: "event: one\ndata: 1\n\n" },
    { sequence: 1, frame: "event: two\ndata: 2\n\n" },
  ];
  assertEquals(
    repo.appendApiSseFrames(begun.request.id, begun.leaseToken, frames).frames.length,
    2,
  );
  assertEquals(
    repo.appendApiSseFrames(begun.request.id, begun.leaseToken, frames).frames.length,
    2,
  );
  assertThrows(
    () =>
      repo.appendApiSseFrames(begun.request.id, begun.leaseToken, [
        { sequence: 2, frame: "x".repeat(1_048_577) },
        { sequence: 3, frame: "never persisted" },
      ]),
    DomainError,
    "frame exceeds",
  );
  assertEquals(repo.getApiRequest(user.id, "responses", "batch-request-0001")?.frames.length, 2);
  const completed = repo.completeApiStream({
    id: begun.request.id,
    leaseToken: begun.leaseToken,
    responseStatus: 200,
    responseHeaders: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    terminalFrame: "event: response.completed\ndata: {}\n\n",
    costMicros: 10_000,
    inputTokens: 2,
    outputTokens: 3,
    latencyMs: 5,
  });
  assertEquals(completed.state, "completed");
  assertEquals(completed.frames.at(-1)?.frame.includes("response.completed"), true);
  assertEquals(completed.responseHeaders["cache-control"], "no-cache");

  const atomic = repo.beginApiRequest({
    userId: user.id,
    endpoint: "responses",
    idempotencyKey: "batch-request-atomic",
    requestHash: "f".repeat(64),
    stream: true,
    model: "test/model",
    runId: "batch-run-atomic",
    reserveMicros: 50_000,
    provider: "test",
  });
  if (atomic.kind !== "started") throw new Error("expected atomic request");
  const atomicFrames = [{ sequence: 0, frame: "event: response.created\ndata: {}\n\n" }];
  const atomicCompleted = repo.completeApiStream({
    id: atomic.request.id,
    leaseToken: atomic.leaseToken,
    responseStatus: 200,
    frames: atomicFrames,
    terminalFrame: "event: response.completed\ndata: {}\n\n",
    costMicros: 10_000,
    inputTokens: 2,
    outputTokens: 3,
    latencyMs: 5,
  });
  assertEquals(atomicCompleted.frames.length, 2);
  assertEquals(atomicCompleted.state, "completed");

  const rejected = repo.beginApiRequest({
    userId: user.id,
    endpoint: "responses",
    idempotencyKey: "batch-request-rejected",
    requestHash: "1".repeat(64),
    stream: true,
    model: "test/model",
    runId: "batch-run-rejected",
    reserveMicros: 50_000,
    provider: "test",
  });
  if (rejected.kind !== "started") throw new Error("expected rejected request");
  assertThrows(
    () =>
      repo.completeApiStream({
        id: rejected.request.id,
        leaseToken: rejected.leaseToken,
        responseStatus: 200,
        frames: atomicFrames,
        terminalFrame: "event: response.completed\ndata: {}\n\n",
        costMicros: 10_000,
        inputTokens: 2,
        outputTokens: 3,
        latencyMs: 5,
        quota: { maxRequests: 10, maxEvents: 1, maxBytes: 10_000 },
      }),
    DomainError,
    "quota",
  );
  assertEquals(
    repo.getApiRequest(user.id, "responses", "batch-request-rejected")?.frames.length,
    0,
  );
  assertEquals(repo.usageRuns.get("batch-run-rejected")?.status, "reserved");
});

Deno.test("per-user replay quotas bound live requests, events, and bytes", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "quota@example.com", name: "Quota", passwordHash: "x" });
  repo.credit(user.id, "quota-grant", "grant", 1_000_000);
  const quota = { maxRequests: 2, maxEvents: 1, maxBytes: 24 };
  const input = (suffix: string) => ({
    userId: user.id,
    endpoint: "responses" as const,
    idempotencyKey: `quota-key-${suffix}`,
    requestHash: suffix.repeat(64).slice(0, 64),
    stream: true,
    model: "test/model",
    runId: `quota-run-${suffix}`,
    reserveMicros: 1,
    provider: "test",
    quota,
  });
  const first = repo.beginApiRequest(input("a"));
  const second = repo.beginApiRequest(input("b"));
  if (first.kind !== "started" || second.kind !== "started") throw new Error("missing starts");
  assertThrows(() => repo.beginApiRequest(input("c")), DomainError, "request quota");
  repo.appendApiSseFrame(
    first.request.id,
    first.leaseToken,
    0,
    "data: one\n\n",
    undefined,
    undefined,
    quota,
  );
  assertThrows(
    () =>
      repo.appendApiSseFrame(
        second.request.id,
        second.leaseToken,
        0,
        "data: two\n\n",
        undefined,
        undefined,
        quota,
      ),
    DomainError,
    "storage quota",
  );
  assertThrows(
    () =>
      repo.completeApiJson({
        id: second.request.id,
        leaseToken: second.leaseToken,
        responseStatus: 200,
        responseBody: "x".repeat(20),
        costMicros: 1,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        quota,
      }),
    DomainError,
    "storage quota",
  );
});
