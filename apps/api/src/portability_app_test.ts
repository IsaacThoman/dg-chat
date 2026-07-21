import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1.0.14";
import { parseConversationPortabilityV1 } from "@dg-chat/contracts";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { sha256 } from "./crypto.ts";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const now = "2026-07-12T04:00:00.000Z";
const archive = (title = "Portable") =>
  parseConversationPortabilityV1({
    format: "dgchat.owner-export",
    version: 1,
    scope: "owner",
    exportedAt: now,
    preferences: {
      theme: "system",
      compactConversations: false,
      reduceMotion: false,
      customInstructions: "",
      useMemory: true,
      saveHistory: true,
      preferredModelId: null,
    },
    folders: [],
    tags: [],
    attachments: [],
    conversations: [{
      id: id(1),
      title,
      activeLeafId: id(2),
      pinned: false,
      temporary: false,
      archivedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      folderId: null,
      folderPosition: null,
      tagIds: [],
      messages: [{
        id: id(2),
        parentId: null,
        supersedesId: null,
        generationId: null,
        siblingIndex: 0,
        role: "user",
        content: "Private owner content",
        model: null,
        status: "complete",
        metadata: {},
        attachments: [],
        createdAt: now,
      }],
    }],
  });

async function ownerSession(repository: MemoryRepository, email: string) {
  const user = repository.createUser({
    email,
    name: email,
    approvalStatus: "approved",
    emailVerified: true,
  });
  const token = `session-${crypto.randomUUID()}`;
  repository.createSession(user.id, await sha256(token), false);
  return {
    user,
    headers: {
      cookie: `dg_session=${token}`,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
  };
}

Deno.test("owner portability routes export privately and import with stable replay isolation", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({ repository });
  const owner = await ownerSession(repository, "owner-portability@example.test");
  const other = await ownerSession(repository, "other-portability@example.test");
  await repository.importConversationPortability(owner.user.id, archive(), "seed-owner");

  const exportedResponse = await app.request(
    "/api/portability/export?includeDeleted=false&includeTemporary=false",
    { headers: owner.headers },
  );
  assertEquals(exportedResponse.status, 200);
  assertEquals(exportedResponse.headers.get("cache-control"), "private, no-store");
  assertEquals(exportedResponse.headers.get("pragma"), "no-cache");
  assertEquals(exportedResponse.headers.get("x-content-type-options"), "nosniff");
  assertMatch(
    exportedResponse.headers.get("content-disposition") ?? "",
    /^attachment; filename="dg-chat-export-\d{4}-\d{2}-\d{2}\.dgchat"$/,
  );
  const exported = await exportedResponse.json();
  assertEquals(exported.conversations.length, 1);
  assertEquals(exported.conversations[0].messages[0].content, "Private owner content");

  const otherExport = await app.request("/api/portability/export", { headers: other.headers });
  assertEquals((await otherExport.json()).conversations, []);
  const preview = await app.request("/api/portability/import/dry-run", {
    method: "POST",
    headers: other.headers,
    body: JSON.stringify(exported),
  });
  assertEquals(preview.status, 200);
  assertEquals((await preview.json()).dryRun, true);
  assertEquals(repository.listConversations(other.user.id).length, 0);

  const apply = () =>
    app.request("/api/portability/import", {
      method: "POST",
      headers: { ...other.headers, "idempotency-key": "portable-import-1" },
      body: JSON.stringify(exported),
    });
  const first = await apply();
  assertEquals(first.status, 201);
  assertEquals((await first.json()).replayed, false);
  const replay = await apply();
  assertEquals(replay.status, 200);
  assertEquals((await replay.json()).replayed, true);
  assertEquals(repository.listConversations(other.user.id).length, 1);

  const drift = structuredClone(exported);
  drift.conversations[0].title = "Changed";
  const conflict = await app.request("/api/portability/import", {
    method: "POST",
    headers: { ...other.headers, "idempotency-key": "portable-import-1" },
    body: JSON.stringify(drift),
  });
  assertEquals(conflict.status, 409);
  assertEquals((await conflict.json()).error.code, "idempotency_conflict");
  assertEquals(
    (await repository.listAudit({
      action: "conversation.portability_imported",
      actorId: other.user.id,
    })).data.length,
    1,
  );
  assertEquals(
    (await repository.listAudit({ action: "conversation.portability_import_replayed" })).data
      .length,
    1,
  );
  const ownerExportAudit = (await repository.listAudit({
    action: "conversation.portability_exported",
    actorId: owner.user.id,
  })).data[0];
  assertExists(ownerExportAudit);
  assertEquals(
    ownerExportAudit.metadata,
    { conversations: 1, attachments: 0, includeDeleted: false, includeTemporary: false },
  );
});

Deno.test("owner portability rejects unauthorized, malformed, ambiguous, and oversized requests", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({ repository });
  const owner = await ownerSession(repository, "edges-portability@example.test");
  const unauthenticated = await app.request("/api/portability/export");
  assertEquals(unauthenticated.status, 401);

  for (
    const query of [
      "includeDeleted=yes",
      "unknown=true",
      "includeDeleted=true&includeDeleted=false",
    ]
  ) {
    const response = await app.request(`/api/portability/export?${query}`, {
      headers: owner.headers,
    });
    assertEquals(response.status, 422);
    assertEquals((await response.json()).error.code, "validation_error");
  }
  const missingKey = await app.request("/api/portability/import", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(archive()),
  });
  assertEquals(missingKey.status, 422);
  assertEquals((await missingKey.json()).error.code, "idempotency_key_required");
  const malformedKey = await app.request("/api/portability/import", {
    method: "POST",
    headers: { ...owner.headers, "idempotency-key": "short" },
    body: JSON.stringify(archive()),
  });
  assertEquals(malformedKey.status, 422);
  assertEquals((await malformedKey.json()).error.code, "invalid_idempotency_key");
  const wrongType = await app.request("/api/portability/import/dry-run", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "text/plain" },
    body: JSON.stringify(archive()),
  });
  assertEquals(wrongType.status, 415);
  assertEquals((await wrongType.json()).error.code, "unsupported_media_type");
  const malformed = await app.request("/api/portability/import/dry-run", {
    method: "POST",
    headers: owner.headers,
    body: "{",
  });
  assertEquals(malformed.status, 400);
  assertEquals((await malformed.json()).error.code, "invalid_json");
  const invalid = await app.request("/api/portability/import/dry-run", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ ...archive(), format: "not-dgchat" }),
  });
  assertEquals(invalid.status, 422);
  assertEquals((await invalid.json()).error.code, "validation_error");
  const oversized = await app.request("/api/portability/import/dry-run", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ padding: "x".repeat(16 * 1024 * 1024) }),
  });
  assertEquals(oversized.status, 413);
  assertEquals((await oversized.json()).error.code, "request_too_large");
  const trailingSlash = await app.request("/api/portability/import/dry-run/", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(archive()),
  });
  assertEquals(trailingSlash.status, 404);
});

Deno.test("owner portability mutations enforce CSRF, session-only auth, and active approval", async () => {
  const repository = new MemoryRepository();
  const actor = repository.bootstrapAdmin({
    email: "portability-admin@example.test",
    name: "Portability Administrator",
    passwordHash: "test-only-hash",
  }, 0);
  const { app } = createApp({ repository });
  const owner = await ownerSession(repository, "security-portability@example.test");
  const initialAudits = repository.auditEvents.length;
  const post = (headers: HeadersInit) =>
    app.request("/api/portability/import", {
      method: "POST",
      headers,
      body: JSON.stringify(archive()),
    });
  const missingOrigin = await post({
    cookie: owner.headers.cookie,
    "content-type": "application/json",
    "idempotency-key": "csrf-missing-origin",
  });
  assertEquals(missingOrigin.status, 403);
  assertEquals((await missingOrigin.json()).error.code, "invalid_origin");
  const foreignOrigin = await post({
    ...owner.headers,
    origin: "https://attacker.example",
    "idempotency-key": "csrf-foreign-origin",
  });
  assertEquals(foreignOrigin.status, 403);

  const bearer = `dg_${crypto.randomUUID()}`;
  repository.createApiToken(owner.user.id, {
    name: "Portability bearer",
    scopes: ["chat:write"],
    tokenHash: await sha256(bearer),
    preview: bearer.slice(-4),
  }, repository.findUser(owner.user.id)!.authorityEpoch);
  const tokenResponse = await post({
    authorization: `Bearer ${bearer}`,
    origin: "http://localhost:5173",
    "content-type": "application/json",
    "idempotency-key": "bearer-not-session",
  });
  assertEquals(tokenResponse.status, 403);
  assertEquals((await tokenResponse.json()).error.code, "session_required");

  const pending = repository.createUser({
    email: "pending-portability@example.test",
    name: "Pending",
  });
  const pendingToken = `session-${crypto.randomUUID()}`;
  repository.createSession(pending.id, await sha256(pendingToken), true);
  const pendingResponse = await post({
    cookie: `dg_session=${pendingToken}`,
    origin: "http://localhost:5173",
    "content-type": "application/json",
    "idempotency-key": "pending-account",
  });
  assertEquals(pendingResponse.status, 403);
  assertEquals((await pendingResponse.json()).error.code, "session_refresh_required");

  repository.setAdminUserState({
    actorId: actor.id,
    expectedAuthorityEpoch: 1,
    targetUserId: owner.user.id,
    expectedVersion: owner.user.version,
    state: "suspended",
    reason: "Exercise suspended-account authorization",
  });
  const suspended = await post({ ...owner.headers, "idempotency-key": "suspended-account" });
  assertEquals(suspended.status, 401);
  assertEquals(repository.listConversations(owner.user.id).length, 0);
  // Token creation and the later suspension are both mandatory audited mutations.
  // None of the rejected portability requests may append an audit.
  assertEquals(repository.auditEvents.length, initialAudits + 2);
});
