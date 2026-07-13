import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertMatch,
} from "jsr:@std/assert@1.0.14";
import { Buffer } from "node:buffer";
import { MemoryRepository } from "@dg-chat/database";
import { createApp, redactRequestLog } from "./app.ts";
import { sha256 } from "./crypto.ts";
import { TestObjectStore } from "./test-object-store.ts";
import type { RateLimiter, RateLimitResult } from "./rate-limit.ts";

const capability = (seed: number) =>
  Buffer.from(Array.from({ length: 32 }, (_, index) => (seed * 17 + index * 29) % 256)).toString(
    "base64url",
  );

async function ownerFixture(repository: MemoryRepository, email: string, name = "Share Owner") {
  const user = repository.createUser({
    email,
    name,
    approvalStatus: "approved",
    emailVerified: true,
  });
  const token = `session-${crypto.randomUUID()}`;
  repository.createSession(user.id, await sha256(token), false);
  const conversation = repository.createConversation(user.id, "Immutable snapshot");
  const internal = repository.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: null,
    role: "system",
    content: "PRIVATE CUSTOM INSTRUCTIONS MUST NEVER BE SHARED",
    expectedVersion: 0,
    idempotencyKey: `message-${crypto.randomUUID()}`,
  });
  const removed = repository.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: internal.id,
    role: "user",
    content: "EXPLICITLY TOMBSTONED CONTENT MUST NEVER BE SHARED",
    expectedVersion: 1,
    idempotencyKey: `message-${crypto.randomUUID()}`,
  });
  repository.messages.get(removed.id)!.status = "tombstoned";
  const first = repository.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: removed.id,
    role: "user",
    content: "Owner-only source question",
    expectedVersion: 2,
    idempotencyKey: `message-${crypto.randomUUID()}`,
  });
  const leaf = repository.appendMessage({
    conversationId: conversation.id,
    ownerId: user.id,
    parentId: first.id,
    role: "assistant",
    content: "A safe public answer",
    model: "private/internal-model",
    expectedVersion: 3,
    idempotencyKey: `message-${crypto.randomUUID()}`,
    metadata: { costMicros: 99_000, hiddenReasoning: "never public" },
  });
  return {
    user,
    conversation: repository.detail(conversation.id, user.id),
    internal,
    removed,
    first,
    leaf,
    headers: {
      cookie: `dg_session=${token}`,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
  };
}

const createBody = (leafId: string, version: number, secret: string) => ({
  capability: secret,
  leafId,
  expectedConversationVersion: version,
  identityVisibility: "anonymous",
  attachmentPolicy: "include",
  selectedAttachmentIds: [],
  expiresAt: null,
});

Deno.test("sharing routes create one immutable redacted snapshot, stream authorized objects, and revoke immediately", async () => {
  const repository = new MemoryRepository();
  const objects = new TestObjectStore();
  const { app } = createApp({ repository, objectStore: objects });
  const owner = await ownerFixture(repository, "share-owner@example.test");
  const foreign = await ownerFixture(repository, "share-foreign@example.test", "Foreign");
  const bytes = new TextEncoder().encode("immutable shared attachment");
  const objectKey = `uploads/${owner.user.id}/shared-fixture`;
  await objects.put({
    key: objectKey,
    body: new Response(bytes).body!,
    contentLength: bytes.byteLength,
    contentType: "text/plain",
    metadata: { owner: owner.user.id },
  });
  const attachment = repository.createAttachment({
    ownerId: owner.user.id,
    objectKey,
    filename: "résumé final.txt",
    mimeType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256: "a".repeat(64),
    state: "ready",
    inspectionComplete: true,
  }).attachment;
  repository.linkAttachmentToMessage(owner.leaf.id, attachment.id, owner.user.id);

  const secret = capability(7);
  const create = () =>
    app.request(`/api/conversations/${owner.conversation.id}/shares`, {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": "share-create-stable" },
      body: JSON.stringify(createBody(owner.leaf.id, owner.conversation.version, secret)),
    });
  const createdResponse = await create();
  assertEquals(createdResponse.status, 201);
  assertEquals(createdResponse.headers.get("cache-control"), "private, no-store");
  const created = await createdResponse.json();
  assertEquals(created.capability, secret);
  assertEquals(created.path, `/share/${secret}`);
  assertEquals(created.replayed, false);
  assertFalse("secretHash" in created.share);
  assertFalse("ownerId" in created.share);

  const replay = await create();
  assertEquals(replay.status, 200);
  assertEquals((await replay.json()).replayed, true);
  assertEquals(
    (await repository.listAudit({ action: "conversation.share_created" })).data.length,
    1,
  );
  const drift = await app.request(`/api/conversations/${owner.conversation.id}/shares`, {
    method: "POST",
    headers: { ...owner.headers, "idempotency-key": "share-create-stable" },
    body: JSON.stringify(createBody(owner.leaf.id, owner.conversation.version, capability(8))),
  });
  assertEquals(drift.status, 409);
  assertEquals((await drift.json()).error.code, "idempotency_conflict");

  const publicResponse = await app.request(`/api/public/shares/${secret}`);
  assertEquals(publicResponse.status, 200);
  assertEquals(publicResponse.headers.get("cache-control"), "no-store, max-age=0");
  assertEquals(publicResponse.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  const publicBody = await publicResponse.json();
  const serialized = JSON.stringify(publicBody);
  assertEquals(publicBody.share.identity, { visibility: "anonymous", displayName: null });
  assertEquals(publicBody.share.messages.length, 2);
  assertEquals(publicBody.share.messages[0].parentId, null);
  assertEquals(publicBody.share.attachments.length, 1);
  assertFalse(serialized.includes(owner.user.id));
  assertFalse(serialized.includes(owner.user.email));
  assertFalse(serialized.includes(owner.first.id));
  assertFalse(serialized.includes(owner.leaf.id));
  assertFalse(serialized.includes(owner.internal.id));
  assertFalse(serialized.includes(owner.removed.id));
  assertFalse(serialized.includes("PRIVATE CUSTOM INSTRUCTIONS"));
  assertFalse(serialized.includes("EXPLICITLY TOMBSTONED CONTENT"));
  assertFalse(serialized.includes(attachment.id));
  assertFalse(serialized.includes(objectKey));
  assertFalse(serialized.includes("costMicros"));
  assertFalse(serialized.includes("hiddenReasoning"));

  const publicAttachmentId = publicBody.share.attachments[0].id as string;
  const content = await app.request(
    `/api/public/shares/${secret}/attachments/${publicAttachmentId}`,
  );
  assertEquals(content.status, 200);
  assertEquals(new Uint8Array(await content.arrayBuffer()), bytes);
  assertEquals(content.headers.get("cache-control"), "no-store, max-age=0");
  assertEquals(content.headers.get("x-content-type-options"), "nosniff");
  assertMatch(content.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''/);
  assertEquals(
    (content.headers.get("content-disposition") ?? "").includes("\r") ||
      (content.headers.get("content-disposition") ?? "").includes("\n"),
    false,
  );
  assertEquals(
    (await app.request(`/api/public/shares/${secret}/attachments/${crypto.randomUUID()}`)).status,
    404,
  );

  repository.appendMessage({
    conversationId: owner.conversation.id,
    ownerId: owner.user.id,
    parentId: owner.leaf.id,
    role: "user",
    content: "This later private turn must not appear",
    expectedVersion: owner.conversation.version,
    idempotencyKey: "later-private-message",
  });
  assertEquals(
    (await (await app.request(`/api/public/shares/${secret}`)).json()).share.messages.length,
    2,
  );

  const listed = await (await app.request("/api/shares", { headers: owner.headers })).json();
  assertEquals(listed.data.length, 1);
  assertFalse(JSON.stringify(listed).includes(secret));
  assertEquals(
    (await (await app.request("/api/shares", { headers: foreign.headers })).json()).data.length,
    0,
  );
  const crossOwner = await app.request(`/api/shares/${created.share.id}/revoke`, {
    method: "POST",
    headers: foreign.headers,
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assertEquals(crossOwner.status, 404);
  const noOrigin = await app.request(`/api/shares/${created.share.id}/revoke`, {
    method: "POST",
    headers: { cookie: owner.headers.cookie, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assertEquals(noOrigin.status, 403);
  const revoked = await app.request(`/api/shares/${created.share.id}/revoke`, {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assertEquals(revoked.status, 200);
  assertExists((await revoked.json()).share.revokedAt);
  assertEquals((await app.request(`/api/public/shares/${secret}`)).status, 404);
  assertEquals(
    (await app.request(`/api/public/shares/${secret}/attachments/${publicAttachmentId}`)).status,
    404,
  );
  assertEquals(
    (await repository.listAudit({ action: "conversation.share_revoked" })).data.length,
    1,
  );
});

Deno.test("sharing routes reject malformed, unsafe, temporary, expired, and unavailable-owner access", async () => {
  const repository = new MemoryRepository();
  let now = Date.now();
  const { app } = createApp({ repository, now: () => now });
  const owner = await ownerFixture(repository, "share-edges@example.test");
  assertEquals((await app.request("/api/shares")).status, 401);

  const missingOrigin = await app.request(`/api/conversations/${owner.conversation.id}/shares`, {
    method: "POST",
    headers: { cookie: owner.headers.cookie, "content-type": "application/json" },
    body: JSON.stringify(createBody(owner.leaf.id, owner.conversation.version, capability(10))),
  });
  assertEquals(missingOrigin.status, 403);
  for (const candidate of ["short", `${capability(10)}x`, "_".repeat(43)]) {
    const malformed = await app.request(`/api/conversations/${owner.conversation.id}/shares`, {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": `malformed-${candidate.length}` },
      body: JSON.stringify(createBody(owner.leaf.id, owner.conversation.version, candidate)),
    });
    assertEquals(malformed.status, 422);
  }
  const unknownField = await app.request(`/api/conversations/${owner.conversation.id}/shares`, {
    method: "POST",
    headers: { ...owner.headers, "idempotency-key": "unknown-field" },
    body: JSON.stringify({
      ...createBody(owner.leaf.id, owner.conversation.version, capability(11)),
      ownerId: owner.user.id,
    }),
  });
  assertEquals(unknownField.status, 422);
  const missingKey = await app.request(`/api/conversations/${owner.conversation.id}/shares`, {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(createBody(owner.leaf.id, owner.conversation.version, capability(12))),
  });
  assertEquals(missingKey.status, 422);

  const temporary = repository.createConversation(owner.user.id, "Temporary", true);
  const temporaryLeaf = repository.appendMessage({
    conversationId: temporary.id,
    ownerId: owner.user.id,
    parentId: null,
    role: "user",
    content: "Do not persist this",
    expectedVersion: 0,
    idempotencyKey: "temporary-share-message",
  });
  const temporaryShare = await app.request(`/api/conversations/${temporary.id}/shares`, {
    method: "POST",
    headers: { ...owner.headers, "idempotency-key": "temporary-share" },
    body: JSON.stringify(createBody(temporaryLeaf.id, 1, capability(13))),
  });
  assertEquals(temporaryShare.status, 409);
  assertEquals((await temporaryShare.json()).error.code, "temporary_conversation_not_shareable");

  const secret = capability(14);
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const created = await app.request(`/api/conversations/${owner.conversation.id}/shares`, {
    method: "POST",
    headers: { ...owner.headers, "idempotency-key": "expiry-share" },
    body: JSON.stringify({
      ...createBody(owner.leaf.id, owner.conversation.version, secret),
      expiresAt,
    }),
  });
  assertEquals(created.status, 201);
  assertEquals((await app.request(`/api/public/shares/${secret}`)).status, 200);
  repository.setUserState(owner.user.id, "suspended");
  assertEquals((await app.request(`/api/public/shares/${secret}`)).status, 404);
  repository.setUserState(owner.user.id, "active");
  now = Date.parse(expiresAt) + 1;
  assertEquals((await app.request(`/api/public/shares/${secret}`)).status, 404);

  for (const invalid of ["not-a-capability", "A".repeat(43)]) {
    const unavailable = await app.request(`/api/public/shares/${invalid}`);
    assertEquals(unavailable.status, 404);
    assertEquals((await unavailable.json()).error.code, "share_unavailable");
    assertEquals(unavailable.headers.get("cache-control"), "no-store, max-age=0");
  }
  const redacted = redactRequestLog(
    `GET /api/public/shares/${secret}/attachments/${crypto.randomUUID()}?source=test`,
  );
  assertFalse(redacted.includes(secret));
  assert(redacted.includes("[REDACTED]"));
  assertEquals(
    redactRequestLog("GET /api/public/shares/%41%42%43/attachments/id"),
    "GET /api/public/shares/[REDACTED]/attachments/id",
  );
});

class ThrowingRateLimiter implements RateLimiter {
  consume(): Promise<RateLimitResult> {
    return Promise.reject(new Error("redis unavailable"));
  }
  health() {
    return Promise.resolve(false);
  }
  close() {
    return Promise.resolve();
  }
}

Deno.test("public shares enforce per-capability/client limits and fail closed", async () => {
  const repository = new MemoryRepository();
  const owner = await ownerFixture(repository, "share-rate@example.test");
  const secret = capability(20);
  await repository.createConversationShare(owner.user.id, {
    conversationId: owner.conversation.id,
    leafId: owner.leaf.id,
    expectedConversationVersion: owner.conversation.version,
    identityVisibility: "anonymous",
    attachmentPolicy: "include",
    selectedAttachmentIds: [],
    expiresAt: null,
    idempotencyKey: "rate-limit-share",
    secretHash: await (async () => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
      );
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    })(),
  });
  const limited = createApp({ repository, publicShareRateLimit: 1, publicShareClientRateLimit: 2 });
  assertEquals((await limited.app.request(`/api/public/shares/${secret}`)).status, 200);
  const denied = await limited.app.request(`/api/public/shares/${secret}`);
  assertEquals(denied.status, 429);
  assertExists(denied.headers.get("retry-after"));

  const unavailable = createApp({ repository, rateLimiter: new ThrowingRateLimiter() });
  const failedClosed = await unavailable.app.request(`/api/public/shares/${secret}`);
  assertEquals(failedClosed.status, 503);
  assertEquals((await failedClosed.json()).error.code, "service_unavailable");
});
