import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { ATTACHMENT_INSPECTION_REASON, MemoryRepository } from "@dg-chat/database";
import type { PutObjectInput } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { sha256 } from "./crypto.ts";
import { TestObjectStore } from "./test-object-store.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function assertPrivate(response: Response) {
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("pragma"), "no-cache");
  assertEquals(response.headers.get("vary")?.includes("Cookie"), true);
}

async function fixture(
  quota = {
    perUserBytes: 10_000,
    perUserObjects: 100,
    installationBytes: 20_000,
    installationObjects: 200,
  },
  externalInspectionRequired = false,
) {
  const repository = new MemoryRepository();
  const objectStore = new TestObjectStore();
  const { app } = createApp({
    repository,
    objectStore,
    setupToken: "admin-storage-setup-token",
    attachmentStorageQuota: quota,
    attachmentExternalInspectionRequired: externalInspectionRequired,
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "admin-storage-setup-token",
    },
    body: JSON.stringify({
      email: "storage-admin@example.test",
      password: "correct horse battery",
      name: "Storage admin",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const admin = (await json(bootstrap)).user;
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "storage-admin@example.test",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return {
    app,
    repository,
    admin,
    cookie,
    mutationHeaders: {
      cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
  };
}

Deno.test("enabled external inspection keeps new web and OpenAI files pending", async () => {
  const { app, repository, cookie, mutationHeaders } = await fixture(undefined, true);
  const webForm = new FormData();
  webForm.set("file", new File(["scan web bytes"], "scan-web.txt", { type: "text/plain" }));
  const web = await app.request("/api/attachments", {
    method: "POST",
    headers: { cookie, origin: mutationHeaders.origin },
    body: webForm,
  });
  assertEquals(web.status, 201);
  const webAttachment = (await json(web)).attachment;
  assertEquals(webAttachment.state, "pending");

  const openAiForm = new FormData();
  openAiForm.set("purpose", "assistants");
  openAiForm.set(
    "file",
    new File(["scan openai bytes"], "scan-openai.txt", { type: "text/plain" }),
  );
  const openAi = await app.request("/v1/files", {
    method: "POST",
    headers: { cookie, "idempotency-key": "scanner-required-upload" },
    body: openAiForm,
  });
  assertEquals(openAi.status, 201);
  assertEquals((await json(openAi)).status, "uploaded");

  const jobs = repository.jobs.filter((job) => job.type === "attachment.inspect");
  assertEquals(jobs.length, 2);
  assertEquals(
    jobs.every((job) => (job.payload as { inspectionEpoch?: unknown }).inspectionEpoch === 1),
    true,
  );
});

Deno.test("a stuck browser-upload heartbeat aborts the PUT and never hangs the request", async () => {
  const repository = new MemoryRepository();
  repository.heartbeatAttachmentUpload =
    (() => new Promise(() => {})) as unknown as typeof repository.heartbeatAttachmentUpload;
  class BlockingPutStore extends TestObjectStore {
    override async put(input: PutObjectInput): Promise<never> {
      if (input.signal?.aborted) throw input.signal.reason;
      return await new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
      });
    }
  }
  const { app } = createApp({
    repository,
    objectStore: new BlockingPutStore(),
    setupToken: "heartbeat-setup-token",
    attachmentUploadPutTimeoutMs: 1_000,
    attachmentUploadLeaseSeconds: 120,
    attachmentUploadHeartbeatMs: 10,
    attachmentUploadHeartbeatTimeoutMs: 20,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "heartbeat-setup-token",
    },
    body: JSON.stringify({
      email: "heartbeat-admin@example.test",
      password: "correct horse battery",
      name: "Heartbeat admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "heartbeat-admin@example.test",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  const form = new FormData();
  form.set("file", new File(["heartbeat"], "heartbeat.txt", { type: "text/plain" }));
  const started = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    app.request("/api/attachments", {
      method: "POST",
      headers: { cookie, origin: "http://localhost:5173" },
      body: form,
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("upload route remained pending")), 500);
    }),
  ]).finally(() => clearTimeout(timeout));
  assertEquals(response.status, 500);
  assertEquals(performance.now() - started < 500, true);
  const [stage] = [...repository.attachmentUploadStages.values()];
  assertEquals(stage.state, "cleanup_pending");
  assertEquals(
    repository.jobs.some((job) =>
      job.idempotencyKey === `attachment_object.cleanup:${stage.id}` &&
      Date.parse(job.availableAt) >= Date.parse(stage.uploadLeaseExpiresAt)
    ),
    true,
  );
});

Deno.test("admin storage inventory is session-only, filter-bound, private, and credential-free", async () => {
  const { app, repository, admin, cookie } = await fixture();
  const first = repository.createAttachment({
    ownerId: admin.id,
    objectKey: `users/${admin.id}/private-first`,
    filename: "suspicious.txt",
    mimeType: "text/plain",
    sizeBytes: 20,
    sha256: "a".repeat(64),
    state: "quarantined",
    inspectionError: "Policy rejected content",
    inspectionComplete: true,
  }).attachment;
  repository.createAttachment({
    ownerId: admin.id,
    objectKey: `users/${admin.id}/private-second`,
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 10,
    sha256: "b".repeat(64),
    state: "ready",
    inspectionComplete: true,
  });

  const summary = await app.request("/api/admin/storage/summary", { headers: { cookie } });
  assertEquals(summary.status, 200);
  assertPrivate(summary);
  assertEquals((await json(summary)).summary.physicalBytes, 30);

  const inventory = await app.request(
    `/api/admin/storage/attachments?state=quarantined&ownerId=${admin.id}&limit=1`,
    { headers: { cookie } },
  );
  assertEquals(inventory.status, 200);
  assertPrivate(inventory);
  const body = await json(inventory);
  assertEquals(body.data.length, 1);
  assertEquals(body.data[0].id, first.id);
  assertEquals(body.data[0].reinspectionEligible, false);
  assertEquals(body.data[0].reinspectionBlockedReason, "policy_quarantine");
  const serialized = JSON.stringify(body);
  assertEquals(serialized.includes("private-first"), false);
  assertEquals(serialized.includes("objectKey"), false);
  assertEquals(serialized.includes('"sha256"'), false);
  assertEquals(serialized.includes("a".repeat(64)), false);

  const malformed = await app.request(
    "/api/admin/storage/attachments?limit=1&limit=2",
    { headers: { cookie } },
  );
  assertEquals(malformed.status, 422);
  assertPrivate(malformed);

  const token = repository.createApiToken(admin.id, {
    name: "Must not administer storage",
    scopes: ["files:read", "files:write"],
    tokenHash: await sha256("storage-token"),
    preview: "stor…oken",
    rpmLimit: 60,
    burstLimit: 10,
  });
  assertExists(token);
  const tokenDenied = await app.request("/api/admin/storage/summary", {
    headers: { authorization: "Bearer storage-token" },
  });
  assertEquals(tokenDenied.status, 403);
  assertEquals((await json(tokenDenied)).error.code, "session_required");
});

Deno.test("admin reinspection validates CSRF, reason and version without exposing object keys", async () => {
  const { app, repository, admin, cookie, mutationHeaders } = await fixture();
  const attachment = repository.createAttachment({
    ownerId: admin.id,
    objectKey: `users/${admin.id}/never-public`,
    filename: "retry-me.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    sha256: "c".repeat(64),
    state: "quarantined",
    inspectionError: ATTACHMENT_INSPECTION_REASON.localPolicyRejected,
    inspectionComplete: true,
  }).attachment;
  const initialVersion = attachment.version;
  const path = `/api/admin/storage/attachments/${attachment.id}/reinspect`;

  const missingOrigin = await app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: initialVersion, reason: "Policy rules changed" }),
  });
  assertEquals(missingOrigin.status, 403);
  assertPrivate(missingOrigin);

  for (
    const body of [
      { expectedVersion: initialVersion, reason: "short" },
      { expectedVersion: initialVersion, reason: "valid reason", unexpected: true },
      { expectedVersion: 0, reason: "Policy rules changed" },
    ]
  ) {
    const invalid = await app.request(path, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify(body),
    });
    assertEquals(invalid.status, 422);
    assertPrivate(invalid);
  }

  const response = await app.request(path, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      expectedVersion: initialVersion,
      reason: "Scanner policy was upgraded",
    }),
  });
  assertEquals(response.status, 202);
  assertPrivate(response);
  const body = await json(response);
  assertEquals(body.attachment.state, "pending");
  assertEquals(body.attachment.version, initialVersion + 1);
  assertEquals(typeof body.inspectionJobId, "string");
  const serialized = JSON.stringify(body);
  assertEquals(serialized.includes("never-public"), false);
  assertEquals(serialized.includes("objectKey"), false);
  assertEquals(serialized.includes('"sha256"'), false);
  assertEquals(serialized.includes("c".repeat(64)), false);

  const stale = await app.request(path, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      expectedVersion: initialVersion,
      reason: "Stale administrative request",
    }),
  });
  assertEquals(stale.status, 409);
  assertPrivate(stale);
});

Deno.test("web and OpenAI uploads enforce retained physical-byte quotas", async () => {
  const { app, cookie, mutationHeaders } = await fixture({
    perUserBytes: 4,
    perUserObjects: 10,
    installationBytes: 4,
    installationObjects: 20,
  });
  const webForm = new FormData();
  webForm.set("file", new File(["12345"], "quota.txt", { type: "text/plain" }));
  const web = await app.request("/api/attachments", {
    method: "POST",
    headers: { cookie, origin: mutationHeaders.origin },
    body: webForm,
  });
  assertEquals(web.status, 413);
  assertEquals((await json(web)).error.code, "storage_quota_exceeded");

  const openAiForm = new FormData();
  openAiForm.set("purpose", "assistants");
  openAiForm.set("file", new File(["12345"], "quota.txt", { type: "text/plain" }));
  const openAi = await app.request("/v1/files", {
    method: "POST",
    headers: { cookie, "idempotency-key": "storage-quota-upload" },
    body: openAiForm,
  });
  assertEquals(openAi.status, 413);
  const error = await json(openAi);
  assertEquals(error.error.type, "invalid_request_error");
  assertEquals(error.error.code, "storage_quota_exceeded");
  assertStringIncludes(error.error.message, "quota");

  const replayForm = new FormData();
  replayForm.set("purpose", "assistants");
  replayForm.set("file", new File(["12345"], "quota.txt", { type: "text/plain" }));
  const replay = await app.request("/v1/files", {
    method: "POST",
    headers: { cookie, "idempotency-key": "storage-quota-upload" },
    body: replayForm,
  });
  assertEquals(replay.status, 413);
  assertEquals((await json(replay)).error.code, "storage_quota_exceeded");
});
