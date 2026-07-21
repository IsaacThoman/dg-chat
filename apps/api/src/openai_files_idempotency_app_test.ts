import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert@1.0.14";
import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  MemoryRepository,
  type PutObjectInput,
} from "@dg-chat/database";
import { createApp } from "./app.ts";
import { sha256, sha256Hex } from "./crypto.ts";
import { TestObjectStore } from "./test-object-store.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function form(content: string, filename = "official-client.txt", purpose = "assistants") {
  const body = new FormData();
  body.set("purpose", purpose);
  body.set("file", new File([content], filename, { type: "text/plain" }));
  return body as unknown as BodyInit;
}

async function fixture(
  options: { uploadMaxBytes?: number; fileUploadRecoveryMaxAgeMs?: number } = {},
) {
  const repository = new MemoryRepository();
  const objectStore = new TestObjectStore();
  const { app, recoverFileUploads } = createApp({
    repository,
    objectStore,
    setupToken: "files-idempotency-setup",
    idempotencyHeartbeatMs: 10,
    idempotencyLeaseSeconds: 2,
    uploadMaxBytes: options.uploadMaxBytes,
    fileUploadRecoveryMaxAgeMs: options.fileUploadRecoveryMaxAgeMs,
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "files-idempotency-setup",
    },
    body: JSON.stringify({
      email: "files-idempotency@example.test",
      password: "correct horse battery",
      name: "Files idempotency",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const user = (await json(bootstrap)).user as { id: string };
  const rawToken = "dg-file-idempotency-primary-token";
  repository.createApiToken(user.id, {
    name: "Files idempotency",
    scopes: ["files:read", "files:write"],
    tokenHash: await sha256(rawToken),
    preview: "primary",
  }, repository.findUser(user.id)!.authorityEpoch);
  return {
    app,
    repository,
    objectStore,
    user,
    authorization: `Bearer ${rawToken}`,
    recoverFileUploads,
  };
}

Deno.test("OpenAI file upload replays successful official-client multipart without duplication", async () => {
  const value = await fixture();
  const headers = {
    authorization: value.authorization,
    "idempotency-key": "official-client-file-upload-0001",
  };
  const first = await value.app.request("/v1/files", {
    method: "POST",
    headers,
    body: form("same immutable bytes"),
  });
  assertEquals(first.status, 201);
  assertEquals(first.headers.get("x-idempotent-replay"), null);
  const firstBody = await json(first);
  assertEquals(firstBody.object, "file");
  assertEquals(firstBody.purpose, "assistants");
  assertEquals(value.repository.attachments.size, 1);
  assertEquals(value.objectStore.objects.size, 1);

  const replay = await value.app.request("/v1/files", {
    method: "POST",
    headers,
    body: form("same immutable bytes"),
  });
  assertEquals(replay.status, 201);
  assertEquals(replay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await json(replay), firstBody);
  assertEquals(value.repository.attachments.size, 1);
  assertEquals(value.objectStore.objects.size, 1);

  const distinct = await value.app.request("/v1/files", {
    method: "POST",
    headers: {
      authorization: value.authorization,
      "idempotency-key": "official-client-file-upload-0002",
    },
    body: form("same immutable bytes", "second-name.txt"),
  });
  assertEquals(distinct.status, 201);
  const distinctBody = await json(distinct);
  assertNotEquals(distinctBody.id, firstBody.id);
  assertEquals(distinctBody.filename, "second-name.txt");
  assertEquals(firstBody.filename, "official-client.txt");
  assertEquals(value.repository.attachments.size, 2);
  assertEquals(value.objectStore.objects.size, 1);

  for (
    const [content, filename] of [
      ["different immutable bytes", "official-client.txt"],
      ["same immutable bytes", "renamed.txt"],
    ]
  ) {
    const conflict = await value.app.request("/v1/files", {
      method: "POST",
      headers,
      body: form(content, filename),
    });
    assertEquals(conflict.status, 409);
    assertEquals((await json(conflict)).error.code, "idempotency_conflict");
  }
  assertEquals(value.repository.attachments.size, 2);
  assertEquals(value.objectStore.objects.size, 1);
});

Deno.test("OpenAI file upload fences concurrency and durably replays storage failures", async () => {
  const concurrent = await fixture();
  const originalPut = concurrent.objectStore.put.bind(concurrent.objectStore);
  let entered!: () => void;
  const putEntered = new Promise<void>((resolve) => entered = resolve);
  let release!: () => void;
  const putRelease = new Promise<void>((resolve) => release = resolve);
  concurrent.objectStore.put = async (input: PutObjectInput) => {
    entered();
    await putRelease;
    return await originalPut(input);
  };
  const headers = {
    authorization: concurrent.authorization,
    "idempotency-key": "concurrent-file-upload-0001",
  };
  const firstPromise = concurrent.app.request("/v1/files", {
    method: "POST",
    headers,
    body: form("concurrent body"),
  });
  await putEntered;
  const loser = await concurrent.app.request("/v1/files", {
    method: "POST",
    headers,
    body: form("concurrent body"),
  });
  assertEquals(loser.status, 409);
  assertEquals((await json(loser)).error.code, "idempotency_in_progress");
  assertEquals(Number(loser.headers.get("retry-after")) >= 1, true);
  release();
  const winner = await firstPromise;
  assertEquals(winner.status, 201);
  assertEquals(concurrent.repository.attachments.size, 1);
  assertEquals(concurrent.objectStore.objects.size, 1);

  const failed = await fixture();
  let puts = 0;
  failed.objectStore.put = (_input: PutObjectInput) => {
    puts++;
    throw new Error("secret backend location must not escape");
  };
  const failureHeaders = {
    authorization: failed.authorization,
    "idempotency-key": "failed-file-upload-0001",
  };
  const originalFailure = await failed.app.request("/v1/files", {
    method: "POST",
    headers: failureHeaders,
    body: form("failed body"),
  });
  assertEquals(originalFailure.status, 503);
  const originalFailureBody = await json(originalFailure);
  assertEquals(originalFailureBody.error.code, "service_unavailable");
  assertEquals(JSON.stringify(originalFailureBody).includes("secret backend"), false);
  assertEquals(failed.repository.attachments.size, 0);
  assertEquals(failed.objectStore.objects.size, 0);

  assertEquals(await failed.recoverFileUploads(), 1);
  const failureReplay = await failed.app.request("/v1/files", {
    method: "POST",
    headers: failureHeaders,
    body: form("failed body"),
  });
  assertEquals(failureReplay.status, 500);
  assertEquals(failureReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals((await json(failureReplay)).error.code, "upload_interrupted");
  assertEquals(puts, 1);

  const lostPutAck = await fixture();
  const committedPut = lostPutAck.objectStore.put.bind(lostPutAck.objectStore);
  let lostPutAcks = 0;
  lostPutAck.objectStore.put = async (input: PutObjectInput) => {
    await committedPut(input);
    lostPutAcks++;
    throw new Error("lost object-store acknowledgement");
  };
  const lostPutHeaders = {
    authorization: lostPutAck.authorization,
    "idempotency-key": "lost-put-ack-file-upload",
  };
  const recoveredPut = await lostPutAck.app.request("/v1/files", {
    method: "POST",
    headers: lostPutHeaders,
    body: form("lost put ack bytes"),
  });
  assertEquals(recoveredPut.status, 201);
  const recoveredPutBody = await json(recoveredPut);
  assertEquals(recoveredPutBody.filename, "official-client.txt");
  assertEquals(lostPutAck.repository.attachments.size, 1);
  assertEquals(lostPutAck.objectStore.objects.size, 1);
  assertEquals(lostPutAcks, 1);

  const ambiguousPut = await fixture();
  const ambiguousCommittedPut = ambiguousPut.objectStore.put.bind(ambiguousPut.objectStore);
  const healthyGet = ambiguousPut.objectStore.get.bind(ambiguousPut.objectStore);
  let immediateGetFails = true;
  ambiguousPut.objectStore.put = async (input: PutObjectInput) => {
    await ambiguousCommittedPut(input);
    throw new Error("lost put acknowledgement");
  };
  ambiguousPut.objectStore.get = (key) => {
    if (immediateGetFails) {
      immediateGetFails = false;
      throw new Error("temporary read outage");
    }
    return healthyGet(key);
  };
  const ambiguousHeaders = {
    authorization: ambiguousPut.authorization,
    "idempotency-key": "ambiguous-put-and-get-upload",
  };
  const ambiguous = await ambiguousPut.app.request("/v1/files", {
    method: "POST",
    headers: ambiguousHeaders,
    body: form("ambiguous put bytes"),
  });
  assertEquals(ambiguous.status, 503);
  assertEquals(ambiguousPut.repository.attachments.size, 0);
  assertEquals(ambiguousPut.objectStore.objects.size, 1);
  ambiguousPut.objectStore.put = ambiguousCommittedPut;
  const ambiguousRetry = await ambiguousPut.app.request("/v1/files", {
    method: "POST",
    headers: ambiguousHeaders,
    body: form("ambiguous put bytes"),
  });
  assertEquals(ambiguousRetry.status, 201);
  assertEquals(ambiguousPut.repository.attachments.size, 1);
  assertEquals(ambiguousPut.objectStore.objects.size, 1);

  const finalizeAck = await fixture();
  const committedFinalize = finalizeAck.repository.finalizeFileUpload.bind(
    finalizeAck.repository,
  );
  let finalizeCalls = 0;
  finalizeAck.repository.finalizeFileUpload = (input) => {
    committedFinalize(input);
    finalizeCalls++;
    throw new Error("lost database commit acknowledgement");
  };
  const finalizeHeaders = {
    authorization: finalizeAck.authorization,
    "idempotency-key": "lost-finalize-ack-file-upload",
  };
  const recoveredFinalize = await finalizeAck.app.request("/v1/files", {
    method: "POST",
    headers: finalizeHeaders,
    body: form("lost finalize ack bytes"),
  });
  assertEquals(recoveredFinalize.status, 201);
  assertEquals(recoveredFinalize.headers.get("x-idempotent-replay"), "true");
  const recoveredFinalizeBody = await json(recoveredFinalize);
  assertEquals(finalizeCalls, 1);
  assertEquals(finalizeAck.repository.attachments.size, 1);
  assertEquals(finalizeAck.objectStore.objects.size, 1);
  const finalizeReplay = await finalizeAck.app.request("/v1/files", {
    method: "POST",
    headers: finalizeHeaders,
    body: form("lost finalize ack bytes"),
  });
  assertEquals(finalizeReplay.status, 201);
  assertEquals(finalizeReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await json(finalizeReplay), recoveredFinalizeBody);
  assertEquals(finalizeAck.repository.attachments.size, 1);
  assertEquals(finalizeAck.objectStore.objects.size, 1);

  const precommit = await fixture();
  const realFinalize = precommit.repository.finalizeFileUpload.bind(precommit.repository);
  let precommitCalls = 0;
  precommit.repository.finalizeFileUpload = (input) => {
    precommitCalls++;
    if (precommitCalls === 1) throw new Error("injected pre-commit database failure");
    return realFinalize(input);
  };
  const precommitHeaders = {
    authorization: precommit.authorization,
    "idempotency-key": "precommit-recovery-file-upload",
  };
  const interrupted = await precommit.app.request("/v1/files", {
    method: "POST",
    headers: precommitHeaders,
    body: form("precommit recovery bytes"),
  });
  assertEquals(interrupted.status, 503);
  assertEquals((await json(interrupted)).error.code, "service_unavailable");
  assertEquals(precommit.repository.attachments.size, 0);
  assertEquals(precommit.objectStore.objects.size, 1);
  const staged = [...precommit.repository.apiIdempotencyRequests.values()].find((request) =>
    request.idempotencyKey === "precommit-recovery-file-upload"
  );
  assertExists(staged);
  assertEquals(staged.state, "in_progress");
  assertEquals(staged.model, "files/upload");
  assertExists(precommit.repository.fileUploadStages.get(staged.id));
  assertEquals(await precommit.recoverFileUploads(), 1);
  const resumedBody = JSON.parse(
    precommit.repository.apiIdempotencyRequests.get(staged.id)!.responseBody!,
  );
  assertEquals(resumedBody.filename, "official-client.txt");
  assertEquals(precommitCalls, 2);
  assertEquals(precommit.repository.attachments.size, 1);
  assertEquals(precommit.objectStore.objects.size, 1);
  const truthfulReplay = await precommit.app.request("/v1/files", {
    method: "POST",
    headers: precommitHeaders,
    body: form("precommit recovery bytes"),
  });
  assertEquals(truthfulReplay.status, 201);
  assertEquals(truthfulReplay.headers.get("x-idempotent-replay"), "true");
  assertEquals(await json(truthfulReplay), resumedBody);
  assertEquals(precommit.repository.attachments.size, 1);
  assertEquals(precommit.objectStore.objects.size, 1);
});

Deno.test("file recovery heartbeats slow object verification before atomic finalization", async () => {
  const value = await fixture();
  const bytes = new TextEncoder().encode("slow recovery bytes");
  const digest = await sha256Hex("slow recovery bytes");
  const objectKey = `uploads/${value.user.id}/blobs/${digest.slice(0, 2)}/${digest}.txt`;
  const begun = value.repository.beginApiRequest({
    userId: value.user.id,
    endpoint: "files",
    idempotencyKey: "slow-recovery-heartbeat",
    requestHash: "e".repeat(64),
    stream: false,
    model: "files/upload",
    runId: `${value.user.id}:files:${crypto.randomUUID()}`,
    reserveMicros: 0,
    provider: "local",
    replayReservedBytes: 16 * 1024,
  });
  if (begun.kind !== "started") throw new Error("expected started recovery request");
  value.repository.stageFileUpload({
    requestId: begun.request.id,
    ownerId: value.user.id,
    objectKey,
    filename: "slow.txt",
    mimeType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256: digest,
    purpose: "assistants",
    attachmentState: "ready",
    inspectionError: null,
    requiredInspectionMode: "local",
    inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
  });
  await value.objectStore.put({
    key: objectKey,
    body: new Blob([bytes]).stream(),
    contentLength: bytes.byteLength,
    contentType: "text/plain",
    metadata: { sha256: digest, owner: value.user.id },
  });
  value.repository.releaseApiRequestLease(begun.request.id, begun.leaseToken);

  const originalHeartbeat = value.repository.heartbeatApiRequest.bind(value.repository);
  let heartbeatObserved!: () => void;
  const heartbeatSeen = new Promise<void>((resolve) => heartbeatObserved = resolve);
  value.repository.heartbeatApiRequest = (...args) => {
    const result = originalHeartbeat(...args);
    heartbeatObserved();
    return result;
  };
  const originalGet = value.objectStore.get.bind(value.objectStore);
  let bodyEntered!: () => void;
  const bodyStarted = new Promise<void>((resolve) => bodyEntered = resolve);
  let releaseBody!: () => void;
  const bodyRelease = new Promise<void>((resolve) => releaseBody = resolve);
  value.objectStore.get = async (key) => {
    const stored = await originalGet(key);
    if (!stored) return undefined;
    let sent = false;
    return {
      ...stored,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent) return;
          sent = true;
          bodyEntered();
          await bodyRelease;
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };

  const recovery = value.recoverFileUploads(1);
  await bodyStarted;
  await heartbeatSeen;
  assertEquals(value.repository.reapStaleApiRequests(), 0);
  releaseBody();
  assertEquals(await recovery, 1);
  assertEquals(value.repository.attachments.size, 1);
  assertEquals(
    value.repository.apiIdempotencyRequests.get(begun.request.id)?.state,
    "completed",
  );
});

Deno.test("file recovery rotates beyond its batch limit while generic reaping stays fenced", async () => {
  const value = await fixture();
  const requests: string[] = [];
  for (let index = 0; index < 3; index++) {
    const digest = String(index + 1).repeat(64);
    const begun = value.repository.beginApiRequest({
      userId: value.user.id,
      endpoint: "files",
      idempotencyKey: `limited-file-recovery-${index}`,
      requestHash: digest,
      stream: false,
      model: "files/upload",
      runId: `${value.user.id}:files:${crypto.randomUUID()}`,
      reserveMicros: 0,
      provider: "local",
      replayReservedBytes: 16 * 1024,
    });
    if (begun.kind !== "started") throw new Error("expected started recovery request");
    value.repository.stageFileUpload({
      requestId: begun.request.id,
      ownerId: value.user.id,
      objectKey: `uploads/${value.user.id}/blobs/${digest.slice(0, 2)}/${digest}.txt`,
      filename: `${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 4,
      sha256: digest,
      purpose: "assistants",
      attachmentState: "ready",
      inspectionError: null,
      requiredInspectionMode: "local",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    });
    value.repository.releaseApiRequestLease(begun.request.id, begun.leaseToken);
    requests.push(begun.request.id);
  }

  assertEquals(value.repository.reapStaleApiRequests(100), 0);
  for (let completed = 1; completed <= requests.length; completed++) {
    assertEquals(await value.recoverFileUploads(1), 1);
    assertEquals(
      requests.filter((id) => value.repository.apiIdempotencyRequests.get(id)?.state === "failed")
        .length,
      completed,
    );
    assertEquals(value.repository.reapStaleApiRequests(100), 0);
  }
  assertEquals(await value.recoverFileUploads(1), 0);
});

Deno.test("file recovery has an explicit terminal age without calling ambiguity corruption", async () => {
  const value = await fixture({ fileUploadRecoveryMaxAgeMs: 1 });
  const digest = "f".repeat(64);
  const begun = value.repository.beginApiRequest({
    userId: value.user.id,
    endpoint: "files",
    idempotencyKey: "expired-file-recovery",
    requestHash: digest,
    stream: false,
    model: "files/upload",
    runId: `${value.user.id}:files:${crypto.randomUUID()}`,
    reserveMicros: 0,
    provider: "local",
    replayReservedBytes: 16 * 1024,
  });
  if (begun.kind !== "started") throw new Error("expected started recovery request");
  value.repository.stageFileUpload({
    requestId: begun.request.id,
    ownerId: value.user.id,
    objectKey: `uploads/${value.user.id}/blobs/ff/${digest}.txt`,
    filename: "expired.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    sha256: digest,
    purpose: "assistants",
    attachmentState: "ready",
    inspectionError: null,
    requiredInspectionMode: "local",
    inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
  });
  value.repository.apiIdempotencyRequests.get(begun.request.id)!.createdAt = new Date(
    Date.now() - 10_000,
  ).toISOString();
  value.repository.releaseApiRequestLease(begun.request.id, begun.leaseToken);
  value.objectStore.get = () => {
    throw new Error("ambiguous storage must not be called after the recovery deadline");
  };

  assertEquals(await value.recoverFileUploads(1), 1);
  const failed = value.repository.apiIdempotencyRequests.get(begun.request.id)!;
  assertEquals(failed.state, "failed");
  assertEquals(JSON.parse(failed.responseBody!).error.code, "upload_recovery_expired");
  assertEquals(
    value.repository.jobs.filter((job) => job.type === "file_object.cleanup").length,
    1,
  );
});

Deno.test("file recovery deduplicates cleanup after a lost enqueue acknowledgement", async () => {
  const value = await fixture({ fileUploadRecoveryMaxAgeMs: 1 });
  const digest = "e".repeat(64);
  const begun = value.repository.beginApiRequest({
    userId: value.user.id,
    endpoint: "files",
    idempotencyKey: "expired-file-cleanup-lost-ack",
    requestHash: digest,
    stream: false,
    model: "files/upload",
    runId: `${value.user.id}:files:${crypto.randomUUID()}`,
    reserveMicros: 0,
    provider: "local",
    replayReservedBytes: 16 * 1024,
  });
  if (begun.kind !== "started") throw new Error("expected started recovery request");
  value.repository.stageFileUpload({
    requestId: begun.request.id,
    ownerId: value.user.id,
    objectKey: `uploads/${value.user.id}/blobs/ee/${digest}.txt`,
    filename: "expired-lost-ack.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    sha256: digest,
    purpose: "assistants",
    attachmentState: "ready",
    inspectionError: null,
    requiredInspectionMode: "local",
    inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
  });
  value.repository.apiIdempotencyRequests.get(begun.request.id)!.createdAt = new Date(
    Date.now() - 10_000,
  ).toISOString();
  value.repository.releaseApiRequestLease(begun.request.id, begun.leaseToken);

  const enqueue = value.repository.enqueueJob.bind(value.repository);
  let loseAcknowledgement = true;
  value.repository.enqueueJob = (...args) => {
    const id = enqueue(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("lost cleanup enqueue acknowledgement");
    }
    return id;
  };

  assertEquals(await value.recoverFileUploads(1), 0);
  assertEquals(
    value.repository.jobs.filter((job) =>
      job.idempotencyKey === `file_object.cleanup:${begun.request.id}`
    ).length,
    1,
  );
  assertEquals(await value.recoverFileUploads(1), 1);
  assertEquals(
    value.repository.jobs.filter((job) =>
      job.idempotencyKey === `file_object.cleanup:${begun.request.id}`
    ).length,
    1,
  );
  assertEquals(value.repository.apiIdempotencyRequests.get(begun.request.id)?.state, "failed");
});

function chunkedBody(chunks: Uint8Array[], onCancel: () => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel();
    },
  });
}

Deno.test("chunked multipart wire limits reject oversized preambles and epilogues before replay", async () => {
  const value = await fixture({ uploadMaxBytes: 32 });
  const encoder = new TextEncoder();
  const boundary = "dg-wire-boundary";
  const valid = [
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nassistants\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="wire.txt"\r\n`,
    "Content-Type: text/plain\r\n\r\nok\r\n",
    `--${boundary}--\r\n`,
  ].join("");
  for (
    const [name, source] of [
      ["preamble", `${"p".repeat(64 * 1024 + 33)}${valid}`],
      ["epilogue", `${valid}${"e".repeat(64 * 1024 + 33)}`],
    ] as const
  ) {
    let cancelled = false;
    const bytes = encoder.encode(source);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      chunks.push(bytes.slice(offset, offset + 1024));
    }
    // Keep the source open past the threshold so cancellation is observable.
    chunks.push(encoder.encode("unreachable"));
    const response = await value.app.request("/v1/files", {
      method: "POST",
      headers: {
        authorization: value.authorization,
        "idempotency-key": `wire-${name}-upload-0001`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: chunkedBody(chunks, () => cancelled = true),
    });
    assertEquals(response.status, 413);
    assertEquals((await json(response)).error.code, "upload_too_large");
    assertEquals(cancelled, true);
  }
  assertEquals(value.repository.apiIdempotencyRequests.size, 0);
  assertEquals(value.repository.attachments.size, 0);
  assertEquals(value.objectStore.objects.size, 0);
});

Deno.test("OpenAI file idempotency is credential-bound, owner-isolated, and rejects early failures", async () => {
  const value = await fixture();
  const key = "credential-and-owner-file-upload";
  const primary = await value.app.request("/v1/files", {
    method: "POST",
    headers: { authorization: value.authorization, "idempotency-key": key },
    body: form("credential body"),
  });
  assertEquals(primary.status, 201);
  const primaryBody = await json(primary);

  const secondRawToken = "dg-file-idempotency-secondary-token";
  value.repository.createApiToken(value.user.id, {
    name: "Secondary files token",
    scopes: ["files:write"],
    tokenHash: await sha256(secondRawToken),
    preview: "secondary",
  }, value.repository.findUser(value.user.id)!.authorityEpoch);
  const credentialConflict = await value.app.request("/v1/files", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secondRawToken}`,
      "idempotency-key": key,
    },
    body: form("credential body"),
  });
  assertEquals(credentialConflict.status, 409);
  assertEquals((await json(credentialConflict)).error.code, "idempotency_conflict");

  const other = value.repository.createUser({
    email: "files-idempotency-other@example.test",
    name: "Other file owner",
    approvalStatus: "approved",
  });
  const otherRawToken = "dg-file-idempotency-other-owner-token";
  value.repository.createApiToken(other.id, {
    name: "Other owner files",
    scopes: ["files:write"],
    tokenHash: await sha256(otherRawToken),
    preview: "other",
  }, other.authorityEpoch);
  const isolated = await value.app.request("/v1/files", {
    method: "POST",
    headers: {
      authorization: `Bearer ${otherRawToken}`,
      "idempotency-key": key,
    },
    body: form("credential body"),
  });
  assertEquals(isolated.status, 201);
  assertNotEquals((await json(isolated)).id, primaryBody.id);
  assertEquals(value.repository.attachments.size, 2);

  const invalidKey = await value.app.request("/v1/files", {
    method: "POST",
    headers: { authorization: value.authorization, "idempotency-key": "short" },
    body: form("never staged"),
  });
  assertEquals(invalidKey.status, 422);
  assertEquals((await json(invalidKey)).error.code, "idempotency_key_required");
  const beforeRequests = value.repository.apiIdempotencyRequests.size;
  const oversized = await value.app.request("/v1/files", {
    method: "POST",
    headers: {
      authorization: value.authorization,
      "idempotency-key": "oversized-file-upload-0001",
    },
    body: form("x".repeat(25 * 1024 * 1024 + 1), "oversized.txt"),
  });
  assertEquals(oversized.status, 413);
  assertEquals((await json(oversized)).error.code, "upload_too_large");
  assertEquals(value.repository.apiIdempotencyRequests.size, beforeRequests);

  const stored = [...value.repository.apiIdempotencyRequests.values()].find((request) =>
    request.endpoint === "files" && request.idempotencyKey === key
  );
  assertExists(stored);
  assertEquals(stored.requestHash.includes("dg-file-idempotency"), false);
  assertEquals(stored.responseBody?.includes("sha256"), false);
});
