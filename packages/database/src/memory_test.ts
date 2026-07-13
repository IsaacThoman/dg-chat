import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";
import { decodeApiResponseBody, InvalidApiResponseBodyError } from "./repository.ts";

Deno.test("passwordless domain users are represented without a local credential", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({ email: "oidc@example.com", name: "OIDC user" });
  assertEquals(user.passwordHash, null);
  assertThrows(
    () =>
      repo.createUser({
        id: user.id,
        email: "collision@example.com",
        name: "Collision",
      }),
    DomainError,
    "identity already exists",
  );
  assertThrows(
    () => repo.bootstrapAdmin({ email: "admin@example.com", name: "Admin" }, 5_000_000),
    DomainError,
    "local password",
  );
});

Deno.test("retention policy gates capture and scrub runs are fenced and idempotent", () => {
  const repo = new MemoryRepository();
  const actor = repo.createUser({
    email: "retention-admin@example.com",
    name: "Retention admin",
    passwordHash: "x",
    role: "admin",
    approvalStatus: "approved",
  });
  const attemptId = crypto.randomUUID();
  repo.providerAttempts.set(attemptId, { usageRunId: "retention-run" } as never);
  assertEquals(
    repo.captureProviderPayload({
      usageRunId: "retention-run",
      providerAttemptId: attemptId,
      requestBody: "private request",
    }),
    null,
  );
  assertEquals(
    repo.captureProviderPayload({
      usageRunId: "invalid-disabled-run",
      providerAttemptId: "not-a-uuid",
      requestBody: "must remain gated",
    }),
    null,
  );
  const policy = repo.updateRetentionPolicy({
    expectedVersion: 1,
    captureEnabled: true,
    requestBodyDays: 1,
    responseBodyDays: 7,
  }, actor.id);
  assertEquals(policy.version, 2);
  assertThrows(
    () =>
      repo.updateRetentionPolicy({
        expectedVersion: 1,
        captureEnabled: false,
        requestBodyDays: 1,
        responseBodyDays: 1,
      }, actor.id),
    DomainError,
    "changed",
  );
  const capture = repo.captureProviderPayload({
    usageRunId: "retention-run",
    providerAttemptId: attemptId,
    requestBody: "private request",
    responseBody: "private response",
  })!;
  repo.providerPayloadCaptures.get(capture.id)!.capturedAt = "2020-01-01T00:00:00.000Z";
  const preview = repo.previewRetentionScrub();
  assertEquals({
    policyVersion: preview.policyVersion,
    captures: preview.captures,
    requestBodies: preview.requestBodies,
    responseBodies: preview.responseBodies,
    requestBytes: preview.requestBytes,
    responseBytes: preview.responseBytes,
  }, {
    policyVersion: 2,
    captures: 1,
    requestBodies: 1,
    responseBodies: 1,
    requestBytes: 15,
    responseBytes: 16,
  });
  const queued = repo.enqueueRetentionScrub({
    idempotencyKey: "retention-test-run",
    expectedPolicyVersion: 2,
    requestCutoffAt: preview.requestCutoffAt,
    responseCutoffAt: preview.responseCutoffAt,
  }, actor.id);
  assertEquals(repo.jobs.filter((job) => job.type === "retention.scrub").length, 1);
  assertEquals(
    repo.enqueueRetentionScrub({
      idempotencyKey: "retention-test-run",
      expectedPolicyVersion: 2,
      requestCutoffAt: preview.requestCutoffAt,
      responseCutoffAt: preview.responseCutoffAt,
    }, actor.id).id,
    queued.id,
  );
  const scrubbed = repo.scrubRetentionBatch(queued.id, 1);
  assertEquals(scrubbed.completed, true);
  assertEquals(scrubbed.run.requestBodiesScrubbed, 1);
  assertEquals(scrubbed.run.responseBodiesScrubbed, 1);
  assertEquals(scrubbed.run.bytesScrubbed, 31);
  assertEquals(repo.providerPayloadCaptures.get(capture.id)?.requestBody, null);
  assertEquals(repo.scrubRetentionBatch(queued.id, 1).processed, 0);
  assertEquals(repo.listRetentionScrubRuns({ status: "completed" }).items.length, 1);
  const failed = repo.enqueueRetentionScrub({
    idempotencyKey: "retention-test-failure",
    expectedPolicyVersion: 2,
    requestCutoffAt: preview.requestCutoffAt,
    responseCutoffAt: preview.responseCutoffAt,
  }, actor.id);
  assertEquals(repo.failRetentionScrubRun(failed.id, "worker_retry_exhausted").status, "failed");
  assertEquals(repo.failRetentionScrubRun(failed.id, "manual_recovery").status, "failed");
  const failedJob = repo.jobs.find((job) =>
    job.type === "retention.scrub" &&
    (job.payload as { runId?: string }).runId === failed.id
  )!;
  failedJob.status = "failed";
  failedJob.attempts = 5;
  assertEquals(repo.retryFailedJob(failedJob.id, actor.id).job.status, "queued");
  assertEquals(repo.getRetentionScrubRun(failed.id).status, "queued");
  assertEquals(repo.scrubRetentionBatch(failed.id).completed, true);
  assertEquals(repo.scrubRetentionBatch(failed.id).processed, 0);
  assertEquals(
    repo.auditEvents.filter((event) =>
      event.targetId === failed.id && event.action === "retention.scrub.failed"
    ).length,
    1,
  );
  assertEquals(
    repo.auditEvents.filter((event) =>
      event.targetId === failed.id && event.action === "retention.scrub.completed"
    ).length,
    1,
  );
});

Deno.test("retention scrub fixes preview cutoffs across policy changes and batches", () => {
  const repo = new MemoryRepository();
  const actor = repo.createUser({ email: "cutoff@example.com", name: "Cutoff", passwordHash: "x" });
  repo.updateRetentionPolicy({
    expectedVersion: 1,
    captureEnabled: true,
    requestBodyDays: 1,
    responseBodyDays: 1,
  }, actor.id);
  const captures = ["first", "second"].map((body) => {
    const attemptId = crypto.randomUUID();
    repo.providerAttempts.set(attemptId, { usageRunId: "cutoff-run" } as never);
    const capture = repo.captureProviderPayload({
      usageRunId: "cutoff-run",
      providerAttemptId: attemptId,
      requestBody: body,
    })!;
    repo.providerPayloadCaptures.get(capture.id)!.capturedAt = "2020-01-01T00:00:00.000Z";
    return capture;
  });
  const preview = repo.previewRetentionScrub();
  const run = repo.enqueueRetentionScrub({
    idempotencyKey: "cutoff-bound-run",
    expectedPolicyVersion: preview.policyVersion,
    requestCutoffAt: preview.requestCutoffAt,
    responseCutoffAt: preview.responseCutoffAt,
  }, actor.id);
  repo.updateRetentionPolicy({
    expectedVersion: 2,
    captureEnabled: true,
    requestBodyDays: 90,
    responseBodyDays: 90,
  }, actor.id);
  const futureAttempt = crypto.randomUUID();
  repo.providerAttempts.set(futureAttempt, { usageRunId: "cutoff-run" } as never);
  const future = repo.captureProviderPayload({
    usageRunId: "cutoff-run",
    providerAttemptId: futureAttempt,
    requestBody: "future",
  })!;
  assertEquals(repo.scrubRetentionBatch(run.id, 1).completed, false);
  const terminal = repo.scrubRetentionBatch(run.id, 1);
  assertEquals(terminal.completed, true);
  assertEquals(terminal.run.requestCutoffAt, preview.requestCutoffAt);
  assertEquals(repo.providerPayloadCaptures.get(future.id)?.requestBody, "future");
  assertEquals(
    captures.every((capture) => repo.providerPayloadCaptures.get(capture.id)?.requestBody === null),
    true,
  );
});

Deno.test("admin analytics are bounded, canonical, and deterministically bucketed", () => {
  const repo = new MemoryRepository();
  const base = {
    userId: crypto.randomUUID(),
    model: "provider/model",
    provider: "provider",
    reservedMicros: 0,
    executionEpoch: 0,
    executionOwnerLeaseToken: null,
    runLeaseToken: null,
    runLeaseExpiresAt: null,
    pricingSnapshot: null,
    generationLeaseToken: null,
    generationLeaseExpiresAt: null,
  };
  repo.usageRuns.set("run-1", {
    ...base,
    id: "run-1",
    status: "completed",
    costMicros: 40,
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
    actualProviderCostMicros: 20,
    actualProviderInputTokens: 10,
    actualProviderCachedInputTokens: 2,
    actualProviderReasoningTokens: 1,
    actualProviderOutputTokens: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  repo.usageRuns.set("run-2", {
    ...base,
    id: "run-2",
    status: "failed",
    costMicros: 7,
    inputTokens: 3,
    outputTokens: 0,
    latencyMs: 200,
    actualProviderCostMicros: 6,
    actualProviderInputTokens: 3,
    actualProviderCachedInputTokens: 0,
    actualProviderReasoningTokens: 0,
    actualProviderOutputTokens: 0,
    createdAt: "2026-01-01T01:00:00.000Z",
  });
  repo.usageRuns.set("run-reserved", {
    ...base,
    id: "run-reserved",
    status: "reserved",
    costMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: null,
    actualProviderCostMicros: 0,
    actualProviderInputTokens: 0,
    actualProviderCachedInputTokens: 0,
    actualProviderReasoningTokens: 0,
    actualProviderOutputTokens: 0,
    createdAt: "2026-01-01T01:30:00.000Z",
  });
  const analytics = repo.adminAnalytics({
    from: "2026-01-01T00:00:00Z",
    to: "2026-01-02T00:00:00Z",
    bucket: "hour",
  });
  assertEquals(analytics.summary.calls, 3);
  assertEquals(analytics.summary.successRate, 0.5);
  assertEquals(analytics.summary.customerCostMicros, 47);
  assertEquals(analytics.summary.providerCostMicros, 26);
  assertEquals(analytics.summary.p95LatencyMs, 195);
  assertEquals(analytics.summary.avgLatencyMs, 150);
  assertEquals(analytics.points.map((point) => point.start), [
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T01:00:00.000Z",
  ]);
  assertThrows(
    () => repo.adminAnalytics({ from: "2026-01-02", to: "2026-01-01", bucket: "day" }),
    DomainError,
    "Invalid analytics",
  );
});

Deno.test("admin jobs are redacted, paginated, and failed-only retry is atomic", () => {
  const repo = new MemoryRepository();
  const actorId = crypto.randomUUID();
  repo.jobs.push({
    id: "00000000-0000-4000-8000-000000000001",
    type: "attachment.ingest",
    payload: { secret: "never expose" },
    status: "failed",
    attempts: 3,
    availableAt: "2026-01-01T00:00:00.000Z",
    lockedAt: "2026-01-01T00:00:00.000Z",
    lockedBy: "private-worker-id",
    lastError: "failure",
    completedAt: "2026-01-01T00:01:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  for (
    const [index, createdAt] of [
      "2025-12-31T23:00:00.000Z",
      "2025-12-31T22:00:00.000Z",
    ].entries()
  ) {
    repo.jobs.push({
      id: `00000000-0000-4000-8000-00000000000${index + 2}`,
      type: "attachment.inspect",
      payload: {},
      status: "completed",
      attempts: 1,
      availableAt: createdAt,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: createdAt,
      createdAt,
    });
  }
  const page = repo.listJobs({ limit: 1 });
  assertEquals(page.items[0], {
    id: "00000000-0000-4000-8000-000000000001",
    type: "attachment.ingest",
    status: "failed",
    attempts: 3,
    availableAt: "2026-01-01T00:00:00.000Z",
    lockedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    lastError: "failure",
  });
  const second = repo.listJobs({ limit: 1, cursor: page.nextCursor! });
  const third = repo.listJobs({ limit: 1, cursor: second.nextCursor! });
  assertEquals(second.hasPrevious, true);
  assertEquals(second.previousCursor, null);
  assertEquals(third.previousCursor, page.nextCursor);
  assertEquals(
    repo.listJobs({ limit: 1, cursor: third.previousCursor! }).items[0].id,
    second.items[0].id,
  );
  const retried = repo.retryFailedJob(page.items[0].id, actorId);
  assertEquals(retried.priorAttempts, 3);
  assertEquals(retried.job.status, "queued");
  assertEquals(
    repo.listAudit({ action: "job.retried", targetId: page.items[0].id }).data[0].metadata,
    { type: retried.job.type, priorAttempts: 3 },
  );
  assertEquals(retried.job.attempts, 0);
  assertEquals(retried.job.lockedAt, null);
  assertThrows(() => repo.retryFailedJob(page.items[0].id, actorId), DomainError, "Only failed");
});

Deno.test("binary API replay validates Base64 and charges quota by decoded bytes", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "binary-replay@example.com",
    name: "Binary",
    passwordHash: "x",
  });
  repo.credit(user.id, "binary-grant", "grant", 1_000);
  const begin = (suffix: string) =>
    repo.beginApiRequest({
      userId: user.id,
      endpoint: "audio.speech",
      idempotencyKey: `binary-replay-${suffix}`,
      requestHash: suffix.repeat(64).slice(0, 64),
      stream: false,
      model: "test/binary",
      runId: `binary-run-${suffix}`,
      reserveMicros: 10,
      provider: "test",
      quota: { maxRequests: 5, maxEvents: 5, maxBytes: 3 },
    });
  const valid = begin("a");
  if (valid.kind !== "started") throw new Error("expected started request");
  const completed = repo.completeApiJson({
    id: valid.request.id,
    leaseToken: valid.leaseToken,
    responseStatus: 200,
    responseBody: "SUQz",
    responseBodyEncoding: "base64",
    costMicros: 1,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    quota: { maxRequests: 5, maxEvents: 5, maxBytes: 3 },
  });
  assertEquals(completed.responseBodyEncoding, "base64");
  assertEquals(
    decodeApiResponseBody(completed.responseBody!, completed.responseBodyEncoding),
    new Uint8Array([73, 68, 51]),
  );

  const malformed = begin("b");
  if (malformed.kind !== "started") throw new Error("expected started request");
  assertThrows(
    () =>
      repo.completeApiJson({
        id: malformed.request.id,
        leaseToken: malformed.leaseToken,
        responseStatus: 200,
        responseBody: "YR==",
        responseBodyEncoding: "base64",
        costMicros: 1,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      }),
    InvalidApiResponseBodyError,
    "canonical Base64",
  );
  assertEquals(repo.usageRuns.get(`binary-run-b`)?.status, "reserved");
  assertEquals(
    repo.getApiRequest(user.id, "audio.speech", "binary-replay-b")?.state,
    "in_progress",
  );
});

Deno.test("provider registry hides credentials, versions mutations, and preserves price history", () => {
  const repo = new MemoryRepository();
  const actor = repo.createUser({
    email: "registry-admin@example.com",
    name: "Registry Admin",
    passwordHash: "hash",
    role: "admin",
    approvalStatus: "approved",
  });
  const created = repo.createProvider({
    slug: "primary",
    displayName: "Primary",
    baseUrl: "https://provider.example/v1/",
    protocol: "responses",
  }, { actorId: actor.id, action: "provider.create" });
  assertEquals(created.baseUrl, "https://provider.example/v1");
  assertEquals(created.version, 1);
  assertEquals("credentialEnvelope" in created, false);

  const envelope = {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyId: "primary-2026",
    credentialVersion: 1,
    wrappedKeyNonce: "bm9uY2U=",
    wrappedKey: "d3JhcHBlZA==",
    contentNonce: "bm9uY2U=",
    ciphertext: "Y2lwaGVydGV4dA==",
  };
  const credentialed = repo.setProviderCredential(created.id, 1, {
    envelope,
  }, { actorId: actor.id, action: "provider.credential.replace" });
  envelope.ciphertext = "mutated-by-caller";
  assertEquals(credentialed.hasCredential, true);
  assertEquals(typeof credentialed.credentialUpdatedAt, "string");
  assertEquals("credentialEnvelope" in credentialed, false);
  assertEquals(repo.getProviderCredential(created.id)?.envelope.ciphertext, "Y2lwaGVydGV4dA==");
  assertThrows(
    () =>
      repo.updateProvider(created.id, 1, { displayName: "Stale" }, {
        actorId: actor.id,
        action: "provider.update",
      }),
    DomainError,
    "reload",
  );
  const healthy = repo.updateProvider(created.id, credentialed.version, {
    healthStatus: "healthy",
    healthCheckedAt: new Date().toISOString(),
    healthLatencyMs: 12,
  }, { actorId: actor.id, action: "provider.test" });
  const rotated = repo.setProviderCredential(healthy.id, healthy.version, {
    envelope: { ...envelope, credentialVersion: 2, ciphertext: "cm90YXRlZA==" },
  }, { actorId: actor.id, action: "provider.credential.replace" });
  assertEquals(rotated.healthStatus, "unknown");
  assertEquals(rotated.healthCheckedAt, null);
  assertEquals(rotated.healthLatencyMs, null);

  const model = repo.createProviderModel({
    providerId: created.id,
    publicModelId: "primary/reasoner",
    upstreamModelId: "reasoner-v1",
    displayName: "Reasoner",
    capabilities: ["chat", "streaming", "reasoning"],
    contextWindow: 128_000,
    customParams: { temperature: 0.2 },
  }, { actorId: actor.id, action: "provider_model.create" });
  const first = repo.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2026-01-01T00:00:00Z",
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 100_000,
    reasoningMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 3_000_000,
    fixedCallMicros: 500,
    source: "contract-2026",
  }, { actorId: actor.id, action: "model_price.create" });
  repo.credit(actor.id, "pricing-snapshot-grant", "grant", 10_000);
  const snapshotted = repo.reserve(
    actor.id,
    "pricing-snapshot-run",
    model.publicModelId,
    1,
    created.slug,
    undefined,
    {
      pricingVersionId: first.id,
      inputMicrosPerMillion: first.inputMicrosPerMillion,
      cachedInputMicrosPerMillion: first.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: first.reasoningMicrosPerMillion,
      outputMicrosPerMillion: first.outputMicrosPerMillion,
      fixedCallMicros: first.fixedCallMicros,
      source: first.source,
    },
  );
  assertThrows(
    () =>
      repo.createModelPriceVersion({
        providerModelId: model.id,
        expectedModelVersion: model.version,
        effectiveAt: "2026-02-01T00:00:00Z",
        inputMicrosPerMillion: 1,
        cachedInputMicrosPerMillion: 1,
        reasoningMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        fixedCallMicros: 1,
        source: "stale",
      }, { actorId: actor.id, action: "model_price.create" }),
    DomainError,
    "reload",
  );
  const repricedModel = repo.findProviderModel(model.id)!;
  const second = repo.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: repricedModel.version,
    effectiveAt: "2026-07-01T00:00:00Z",
    inputMicrosPerMillion: 1_200_000,
    cachedInputMicrosPerMillion: 120_000,
    reasoningMicrosPerMillion: 2_200_000,
    outputMicrosPerMillion: 3_200_000,
    fixedCallMicros: 600,
    source: "contract-2026-h2",
  }, { actorId: actor.id, action: "model_price.create" });
  assertEquals(
    repo.effectiveModelPrice(model.id, "2026-06-30T23:59:59Z")?.id,
    first.id,
  );
  assertEquals(repo.effectiveModelPrice(model.id, "2026-07-01T00:00:00Z")?.id, second.id);
  assertEquals(repo.listModelPriceVersions(model.id).length, 2);
  assertEquals(snapshotted.pricingSnapshot, {
    pricingVersionId: first.id,
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 100_000,
    reasoningMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 3_000_000,
    fixedCallMicros: 500,
    source: "contract-2026",
  });
  assertEquals(repo.usageRuns.get("pricing-snapshot-run")?.pricingSnapshot, {
    pricingVersionId: first.id,
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 100_000,
    reasoningMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 3_000_000,
    fixedCallMicros: 500,
    source: "contract-2026",
  });

  const disabled = repo.updateProvider(created.id, rotated.version, { enabled: false }, {
    actorId: actor.id,
    action: "provider.disable",
  });
  assertEquals(disabled.enabled, false);
  assertEquals(disabled.healthStatus, "disabled");
  assertEquals(repo.findProvider(created.id)?.id, created.id);
  assertEquals(repo.listProviders(true), []);
  assertEquals(repo.listAudit({ targetType: "provider" }).data.length, 5);
  assertThrows(
    () =>
      repo.createProvider({
        slug: "unsafe",
        displayName: "Unsafe",
        baseUrl: "https://provider.example/v1?token=secret",
        protocol: "responses",
      }, { actorId: actor.id, action: "provider.create" }),
    DomainError,
    "URL",
  );
});

Deno.test("provider registry HTTP exception is exact-host and test-only", () => {
  const previousEnvironment = Deno.env.get("DENO_ENV");
  const previousHost = Deno.env.get("OPENAI_TEST_ALLOW_HTTP_HOST");
  try {
    Deno.env.set("DENO_ENV", "test");
    Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", "127.0.0.1");
    const repo = new MemoryRepository();
    const actor = repo.createUser({
      email: "contract-local@example.com",
      name: "Contract local",
      passwordHash: "hash",
      role: "admin",
      approvalStatus: "approved",
    });
    const mutation = { actorId: actor.id, action: "provider.create" };
    const provider = repo.createProvider({
      slug: "contract-local",
      displayName: "Contract local",
      baseUrl: "http://127.0.0.1:4010/v1/",
      protocol: "responses",
    }, mutation);
    assertEquals(provider.baseUrl, "http://127.0.0.1:4010/v1");
    assertThrows(
      () =>
        repo.createProvider({
          slug: "contract-wrong-host",
          displayName: "Wrong host",
          baseUrl: "http://localhost:4010/v1",
          protocol: "responses",
        }, mutation),
      DomainError,
      "Provider base URL is invalid",
    );
  } finally {
    if (previousEnvironment === undefined) Deno.env.delete("DENO_ENV");
    else Deno.env.set("DENO_ENV", previousEnvironment);
    if (previousHost === undefined) Deno.env.delete("OPENAI_TEST_ALLOW_HTTP_HOST");
    else Deno.env.set("OPENAI_TEST_ALLOW_HTTP_HOST", previousHost);
  }
});

Deno.test("provider model defaults and OCR graphs remain valid across edit order", () => {
  const repo = new MemoryRepository();
  const actor = repo.bootstrapAdmin({
    email: "model-invariants@example.com",
    name: "Model invariants",
    passwordHash: "hash",
  }, 1);
  const mutation = { actorId: actor.id, action: "model.invariant" };
  const provider = repo.createProvider({
    slug: "invariants",
    displayName: "Invariants",
    baseUrl: "https://invariants.example/v1",
    protocol: "chat_completions",
  }, mutation);
  const model = (name: string) =>
    repo.createProviderModel({
      providerId: provider.id,
      publicModelId: `invariants/${name}`,
      upstreamModelId: name,
      displayName: name,
      capabilities: ["chat", "vision"],
      contextWindow: 8_192,
    }, mutation);
  const first = model("first");
  const second = model("second");
  const ocr = (target: string) => ({
    ocr: {
      enabled: true,
      providerId: provider.id,
      model: target,
      prompt: "Extract text",
    },
  });
  const firstUpdated = repo.updateProviderModel(first.id, first.version, {
    customParams: ocr(second.id),
  }, mutation);
  assertThrows(
    () => repo.updateProvider(provider.id, provider.version, { enabled: false }, mutation),
    DomainError,
    "must remain enabled",
  );
  assertThrows(
    () =>
      repo.updateProviderModel(
        second.id,
        second.version,
        { customParams: ocr(first.id) },
        mutation,
      ),
    DomainError,
    "cannot intercept OCR itself",
  );
  assertThrows(
    () =>
      repo.updateProviderModel(second.id, second.version, { capabilities: ["vision"] }, mutation),
    DomainError,
    "both chat and vision",
  );
  assertThrows(
    () =>
      repo.updateProviderModel(
        second.id,
        second.version,
        { customParams: ocr(second.id) },
        mutation,
      ),
    DomainError,
    "cannot intercept OCR itself",
  );
  const stoppedFirst = repo.updateProviderModel(first.id, firstUpdated.version, {
    customParams: { stop: "END" },
  }, mutation);
  const protocolError = assertThrows(
    () => repo.updateProvider(provider.id, provider.version, { protocol: "responses" }, mutation),
    DomainError,
    "not supported by Responses providers",
  );
  assertStringIncludes(protocolError.message, "invariants/first");

  const disabledSource = repo.updateProviderModel(first.id, stoppedFirst.version, {
    enabled: false,
    customParams: ocr(second.id),
  }, mutation);
  repo.updateProviderModel(second.id, second.version, { enabled: false }, mutation);
  const currentProvider = repo.findProvider(provider.id)!;
  repo.updateProvider(currentProvider.id, currentProvider.version, { enabled: false }, mutation);
  assertEquals(repo.findProviderModel(disabledSource.id)?.enabled, false);
  assertThrows(
    () =>
      repo.updateProviderModel(disabledSource.id, disabledSource.version, {
        enabled: true,
      }, mutation),
    DomainError,
    "must remain enabled",
  );

  const responses = repo.createProvider({
    slug: "responses-invariants",
    displayName: "Responses invariants",
    baseUrl: "https://responses.example/v1",
    protocol: "responses",
  }, mutation);
  assertThrows(
    () =>
      repo.createProviderModel({
        providerId: responses.id,
        publicModelId: "responses-invariants/invalid",
        upstreamModelId: "invalid",
        displayName: "Invalid",
        capabilities: ["chat"],
        contextWindow: 8_192,
        customParams: { stop: "END" },
      }, mutation),
    DomainError,
    "not supported by Responses providers",
  );
});

Deno.test("knowledge collections isolate owners and version membership and bindings", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "knowledge@example.com",
    name: "Knowledge",
    passwordHash: "x",
  });
  const stranger = repo.createUser({
    email: "knowledge-other@example.com",
    name: "Other",
    passwordHash: "x",
  });
  const collection = repo.createKnowledgeCollection(owner.id, {
    name: " Docs ",
    description: "Reference",
    idempotencyKey: "docs-1",
  });
  assertEquals(
    repo.createKnowledgeCollection(owner.id, {
      name: "Docs",
      description: "Reference",
      idempotencyKey: "docs-1",
    }).id,
    collection.id,
  );
  assertThrows(
    () => repo.createKnowledgeCollection(owner.id, { name: "drift", idempotencyKey: "docs-1" }),
    DomainError,
    "payload differs",
  );
  assertEquals(repo.listKnowledgeCollections(stranger.id), []);
  assertThrows(
    () => repo.getKnowledgeCollection(collection.id, stranger.id),
    DomainError,
    "not found",
  );
  const attachment = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `users/${owner.id}/knowledge`,
    filename: "doc.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    sha256: "d".repeat(64),
    state: "ready",
  }).attachment;
  const linked = repo.linkKnowledgeAttachment(collection.id, attachment.id, owner.id, 1);
  assertEquals(linked.version, 2);
  assertEquals(repo.linkKnowledgeAttachment(collection.id, attachment.id, owner.id, 1).version, 2);
  assertEquals(repo.listKnowledgeAttachments(collection.id, owner.id)[0].id, attachment.id);
  assertThrows(
    () => repo.unlinkKnowledgeAttachment(collection.id, attachment.id, owner.id, 1),
    DomainError,
    "changed",
  );
  const conversation = repo.createConversation(owner.id, "RAG");
  const binding = repo.bindKnowledgeCollection(
    conversation.id,
    collection.id,
    owner.id,
    "retrieval",
  );
  assertEquals(binding.version, 1);
  assertEquals(
    repo.bindKnowledgeCollection(conversation.id, collection.id, owner.id, "retrieval").version,
    1,
  );
  assertThrows(
    () => repo.bindKnowledgeCollection(conversation.id, collection.id, owner.id, "full_context"),
    DomainError,
    "changed",
  );
  const changed = repo.bindKnowledgeCollection(
    conversation.id,
    collection.id,
    owner.id,
    "full_context",
    1,
  );
  assertEquals(changed.version, 2);
  assertEquals(repo.listConversationKnowledge(conversation.id, owner.id)[0].mode, "full_context");
  assertThrows(
    () => repo.listConversationKnowledge(conversation.id, stranger.id),
    DomainError,
    "not found",
  );
  repo.unbindKnowledgeCollection(conversation.id, collection.id, owner.id, 2);
  repo.unlinkKnowledgeAttachment(collection.id, attachment.id, owner.id, 2);
  assertEquals(
    repo.unlinkKnowledgeAttachment(collection.id, attachment.id, owner.id, 2).version,
    3,
  );
  const disposable = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `users/${owner.id}/knowledge-deleted`,
    filename: "deleted.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    sha256: "e".repeat(64),
    state: "ready",
  }).attachment;
  const relinked = repo.linkKnowledgeAttachment(collection.id, disposable.id, owner.id, 3);
  repo.deleteAttachment(disposable.id, owner.id);
  assertEquals(repo.listKnowledgeAttachments(collection.id, owner.id), []);
  assertThrows(
    () => repo.unlinkKnowledgeAttachment(collection.id, disposable.id, owner.id, relinked.version),
    DomainError,
    "not found",
  );
  const hidden = repo.createKnowledgeCollection(owner.id, {
    name: "Hidden",
    idempotencyKey: "hidden-1",
  });
  repo.bindKnowledgeCollection(conversation.id, hidden.id, owner.id, "retrieval");
  repo.deleteKnowledgeCollection(hidden.id, owner.id, 1);
  assertEquals(repo.listConversationKnowledge(conversation.id, owner.id), []);
  assertThrows(
    () => repo.bindKnowledgeCollection(conversation.id, hidden.id, owner.id, "retrieval"),
    DomainError,
    "not found",
  );
  const replacementConversation = repo.createConversation(owner.id, "Replacement");
  const secondCollection = repo.createKnowledgeCollection(owner.id, {
    name: "Second",
    idempotencyKey: "second-1",
  });
  const foreignCollection = repo.createKnowledgeCollection(stranger.id, {
    name: "Foreign",
    idempotencyKey: "foreign-1",
  });
  assertEquals(
    repo.replaceConversationKnowledge(replacementConversation.id, owner.id, {
      collectionIds: [collection.id, secondCollection.id],
      mode: "retrieval",
    }).length,
    2,
  );
  assertThrows(
    () =>
      repo.replaceConversationKnowledge(replacementConversation.id, owner.id, {
        collectionIds: [secondCollection.id, foreignCollection.id],
        mode: "full_context",
      }),
    DomainError,
    "not found",
  );
  assertEquals(repo.listConversationKnowledge(replacementConversation.id, owner.id).length, 2);
  const replaced = repo.replaceConversationKnowledge(replacementConversation.id, owner.id, {
    collectionIds: [secondCollection.id],
    mode: "full_context",
  });
  assertEquals(replaced.map((value) => [value.collectionId, value.mode]), [[
    secondCollection.id,
    "full_context",
  ]]);
  const deleted = repo.deleteKnowledgeCollection(collection.id, owner.id, relinked.version);
  assertEquals(deleted.deletedAt !== null, true);
  assertThrows(
    () =>
      repo.createKnowledgeCollection(owner.id, {
        name: "Docs",
        description: "Reference",
        idempotencyKey: "docs-1",
      }),
    DomainError,
    "already used",
  );
  assertEquals(repo.listKnowledgeCollections(owner.id).map((value) => value.id), [
    secondCollection.id,
  ]);
});

Deno.test("provider resilience routes are acyclic and attempts are immutable and idempotent", () => {
  const repo = new MemoryRepository();
  const actor = repo.bootstrapAdmin({
    email: "resilience@example.com",
    name: "Resilience",
    passwordHash: "x",
  }, 1_000_000);
  const policy = repo.createProviderRetryPolicy({
    name: "transient",
    maxAttempts: 3,
    maxRetries: 1,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
    backoffMultiplierBps: 20_000,
    jitterBps: 1_000,
    firstTokenTimeoutMs: 10_000,
    idleTimeoutMs: 20_000,
    totalTimeoutMs: 60_000,
    retryableStatuses: [429, 500, 503],
  }, { actorId: actor.id, action: "retry_policy.create" });
  const provider = repo.createProvider({
    slug: "route",
    displayName: "Route",
    baseUrl: "https://route.example/v1",
    protocol: "chat_completions",
  }, { actorId: actor.id, action: "provider.create" });
  const credentialed = repo.setProviderCredential(provider.id, provider.version, {
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: "test",
      credentialVersion: 1,
      wrappedKeyNonce: "bm9uY2U=",
      wrappedKey: "d3JhcA==",
      contentNonce: "bm9uY2U=",
      ciphertext: "Y2lwaGVy",
    },
  }, { actorId: actor.id, action: "provider.credential" });
  const makeModel = (name: string) => {
    const model = repo.createProviderModel({
      providerId: provider.id,
      publicModelId: `route/${name}`,
      upstreamModelId: name,
      displayName: name,
      capabilities: ["chat"],
      contextWindow: 1_000,
    }, { actorId: actor.id, action: "model.create" });
    const price = repo.createModelPriceVersion({
      providerModelId: model.id,
      expectedModelVersion: model.version,
      effectiveAt: "2026-01-01T00:00:00Z",
      inputMicrosPerMillion: 10,
      cachedInputMicrosPerMillion: 5,
      reasoningMicrosPerMillion: 30,
      outputMicrosPerMillion: 20,
      fixedCallMicros: 1,
      source: "route-test",
    }, { actorId: actor.id, action: "price.create" });
    return { model: repo.findProviderModel(model.id)!, price };
  };
  const a = makeModel("a"), b = makeModel("b"), c = makeModel("c");
  const routeA = repo.setProviderModelRoute({
    sourceModelId: a.model.id,
    expectedVersion: 0,
    retryPolicyId: policy.id,
    fallbackModelIds: [b.model.id],
  }, { actorId: actor.id, action: "route.set" });
  assertEquals(routeA.version, 1);
  repo.setProviderModelRoute({
    sourceModelId: b.model.id,
    expectedVersion: 0,
    fallbackModelIds: [c.model.id],
  }, { actorId: actor.id, action: "route.set" });
  assertThrows(
    () =>
      repo.setProviderModelRoute({
        sourceModelId: c.model.id,
        expectedVersion: 0,
        fallbackModelIds: [a.model.id],
      }, { actorId: actor.id, action: "route.set" }),
    DomainError,
    "acyclic",
  );
  const plan = repo.resolveProviderExecutionPlan(a.model.id, "2026-06-01T00:00:00Z");
  assertEquals(plan.targets.map((target) => target.providerModelId), [
    a.model.id,
    b.model.id,
    c.model.id,
  ]);
  assertEquals(plan.retryPolicy?.id, policy.id);
  assertEquals(plan.retryPolicy?.maxRetries, 1);
  repo.updateProviderModel(c.model.id, c.model.version, { enabled: false }, {
    actorId: actor.id,
    action: "model.disable",
  });
  assertThrows(
    () =>
      repo.setProviderModelRoute({
        sourceModelId: a.model.id,
        expectedVersion: routeA.version,
        fallbackModelIds: [c.model.id],
      }, { actorId: actor.id, action: "route.set" }),
    DomainError,
    "compatible",
  );
  assertEquals(
    repo.resolveProviderExecutionPlan(a.model.id, "2026-06-01T00:00:00Z").targets.map((target) =>
      target.providerModelId
    ),
    [a.model.id, b.model.id],
  );
  const requested = plan.targets[0].pricing;
  const run = repo.reserve(
    actor.id,
    "resilience-run",
    a.model.publicModelId,
    100,
    credentialed.slug,
    undefined,
    requested,
  );
  const ownerLeaseToken = run.runLeaseToken!;
  const claim = repo.claimProviderExecution(run.id, ownerLeaseToken);
  const ownership = { ownerLeaseToken, executionEpoch: claim.executionEpoch };
  const attempt = repo.startProviderAttempt({
    ...ownership,
    usageRunId: run.id,
    attemptNumber: 1,
    targetOrdinal: 1,
    retryNumber: 0,
    reason: "fallback",
    breakerBefore: "closed",
    ...plan.targets[1],
  });
  assertEquals(
    repo.startProviderAttempt({
      ...ownership,
      usageRunId: run.id,
      attemptNumber: 1,
      targetOrdinal: 1,
      retryNumber: 0,
      reason: "fallback",
      breakerBefore: "closed",
      ...plan.targets[1],
    }).id,
    attempt.id,
  );
  assertThrows(
    () =>
      repo.startProviderAttempt({
        ...ownership,
        usageRunId: run.id,
        attemptNumber: 1,
        targetOrdinal: 1,
        retryNumber: 0,
        reason: "fallback",
        breakerBefore: "closed",
        ...plan.targets[2],
      }),
    DomainError,
    "different target",
  );
  const terminal = repo.finishProviderAttempt({
    ...ownership,
    id: attempt.id,
    status: "failed",
    phase: "headers",
    errorCode: "http_503",
    httpStatus: 503,
    visibleOutput: false,
    inputTokens: 10,
    cachedInputTokens: 2,
    reasoningTokens: 0,
    outputTokens: 0,
    costMicros: 2,
    tokenSource: "provider",
    costSource: "calculated",
    latencyMs: 25,
    ttftMs: null,
    breakerAfter: "open",
    retryable: true,
    upstreamRequestId: "req_provider_1",
    tokensPerSecond: 400,
  });
  assertEquals(
    repo.finishProviderAttempt({
      ...ownership,
      id: attempt.id,
      status: "failed",
      phase: "headers",
      errorCode: "http_503",
      httpStatus: 503,
      visibleOutput: false,
      inputTokens: 10,
      cachedInputTokens: 2,
      reasoningTokens: 0,
      outputTokens: 0,
      costMicros: 2,
      tokenSource: "provider",
      costSource: "calculated",
      latencyMs: 25,
      ttftMs: null,
      breakerAfter: "open",
      retryable: true,
      upstreamRequestId: "req_provider_1",
      tokensPerSecond: 400,
    }).completedAt,
    terminal.completedAt,
  );
  assertThrows(
    () =>
      repo.finishProviderAttempt({
        ...ownership,
        id: attempt.id,
        status: "cancelled",
        phase: "headers",
        errorCode: "caller_abort",
        visibleOutput: false,
        inputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        tokenSource: "none",
        costSource: "none",
        latencyMs: 25,
        breakerAfter: "unavailable",
        retryable: false,
      }),
    DomainError,
    "terminal",
  );
  const skipped = repo.startProviderAttempt({
    ...ownership,
    usageRunId: run.id,
    attemptNumber: 8,
    targetOrdinal: 2,
    retryNumber: 0,
    reason: "circuit_skip",
    breakerBefore: "open",
    ...plan.targets[2],
  });
  repo.finishProviderAttempt({
    ...ownership,
    id: skipped.id,
    status: "skipped",
    phase: "planning",
    errorCode: "circuit_open",
    visibleOutput: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    tokenSource: "none",
    costSource: "none",
    latencyMs: 0,
    breakerAfter: "open",
    retryable: true,
  });
  repo.startProviderAttempt({
    ...ownership,
    usageRunId: run.id,
    attemptNumber: 9,
    targetOrdinal: 1,
    retryNumber: 1,
    reason: "retry",
    breakerBefore: "closed",
    ...plan.targets[1],
  });
  assertEquals(repo.listProviderAttempts(run.id).map((item) => item.attemptNumber), [1, 8, 9]);
  assertEquals(repo.usageRuns.get(run.id)?.pricingSnapshot?.pricingVersionId, a.price.id);
  assertEquals(repo.listProviderAttempts(run.id)[0].pricing.pricingVersionId, b.price.id);
  assertEquals(repo.usageRuns.get(run.id)?.actualProviderCostMicros, 2);
  const renewed = repo.heartbeatProviderExecutionLease(run.id, ownerLeaseToken, 60);
  assertEquals(renewed.leaseToken, ownerLeaseToken);
  repo.usageRuns.get(run.id)!.runLeaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
  assertThrows(
    () => repo.heartbeatProviderExecutionLease(run.id, ownerLeaseToken),
    DomainError,
    "no longer active",
  );
  const replacement = repo.reclaimProviderExecutionLease(run.id, ownerLeaseToken);
  const reclaimed = repo.claimProviderExecution(run.id, replacement.leaseToken);
  assertEquals(reclaimed.executionEpoch, claim.executionEpoch + 1);
  assertEquals(reclaimed.nextAttemptNumber, 10);
  assertEquals(reclaimed.reconciledAttemptIds.length, 1);
  assertEquals(repo.listProviderAttempts(run.id)[2].status, "running");
  assertThrows(
    () =>
      repo.startProviderAttempt({
        ...ownership,
        usageRunId: run.id,
        attemptNumber: 10,
        targetOrdinal: 1,
        retryNumber: 1,
        reason: "retry",
        breakerBefore: "closed",
        ...plan.targets[1],
      }),
    DomainError,
    "stale",
  );
  const finalized = repo.refundProviderUsage({
    usageRunId: run.id,
    ownerLeaseToken: replacement.leaseToken,
    executionEpoch: reclaimed.executionEpoch,
    latencyMs: 100,
    error: "all paths failed",
  });
  assertEquals(finalized.status, "failed");
  assertEquals(finalized.costMicros, 0);
  assertEquals(finalized.actualProviderCostMicros, 2);
  assertEquals(
    repo.refundProviderUsage({
      usageRunId: run.id,
      ownerLeaseToken: replacement.leaseToken,
      executionEpoch: reclaimed.executionEpoch,
      latencyMs: 100,
      error: "all paths failed",
    }).costMicros,
    0,
  );
});

Deno.test("customer settlement remains separate from provider costs and stale leases", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "provider-accounting@example.com",
    name: "Provider accounting",
    passwordHash: "hash",
    approvalStatus: "approved",
  });
  user.balanceMicros = 1_000;
  const begun = repo.beginApiRequest({
    userId: user.id,
    endpoint: "chat.completions",
    idempotencyKey: "provider-accounting-complete",
    requestHash: "a".repeat(64),
    stream: false,
    model: "provider/model",
    provider: "provider",
    runId: "provider-api-complete",
    reserveMicros: 100,
  });
  if (begun.kind !== "started") throw new Error("request did not start");
  const completedRun = repo.usageRuns.get(begun.usageRun.id)!;
  completedRun.executionEpoch = 1;
  completedRun.actualProviderCostMicros = 7;
  completedRun.actualProviderInputTokens = 3;
  completedRun.actualProviderOutputTokens = 2;
  repo.completeApiJson({
    id: begun.request.id,
    leaseToken: begun.leaseToken,
    responseStatus: 200,
    responseBody: "{}",
    costMicros: 99,
    inputTokens: 99,
    outputTokens: 99,
    latencyMs: 1,
  });
  assertEquals(completedRun.costMicros, 99);
  assertEquals(completedRun.inputTokens, 99);
  assertEquals(completedRun.outputTokens, 99);
  assertEquals(completedRun.actualProviderCostMicros, 7);
  assertEquals(completedRun.actualProviderInputTokens, 3);

  const fallback = repo.beginApiRequest({
    userId: user.id,
    endpoint: "chat.completions",
    idempotencyKey: "provider-accounting-fallback",
    requestHash: "f".repeat(64),
    stream: false,
    model: "public/low-price",
    provider: "provider",
    runId: "provider-api-fallback",
    reserveMicros: 800,
  });
  if (fallback.kind !== "started") throw new Error("fallback request did not start");
  const fallbackRun = repo.usageRuns.get(fallback.usageRun.id)!;
  fallbackRun.executionEpoch = 1;
  // This is the aggregate of an expensive failed primary and successful fallback. It remains
  // provider telemetry while the customer receives the low public/source charge.
  fallbackRun.actualProviderCostMicros = 700;
  fallbackRun.actualProviderInputTokens = 600;
  fallbackRun.actualProviderOutputTokens = 100;
  repo.completeApiJson({
    id: fallback.request.id,
    leaseToken: fallback.leaseToken,
    responseStatus: 200,
    responseBody: "{}",
    costMicros: 2,
    inputTokens: 8,
    outputTokens: 1,
    latencyMs: 2,
  });
  assertEquals({
    customerCost: fallbackRun.costMicros,
    customerInput: fallbackRun.inputTokens,
    providerCost: fallbackRun.actualProviderCostMicros,
    providerInput: fallbackRun.actualProviderInputTokens,
  }, { customerCost: 2, customerInput: 8, providerCost: 700, providerInput: 600 });

  const failed = repo.beginApiRequest({
    userId: user.id,
    endpoint: "responses",
    idempotencyKey: "provider-accounting-failed",
    requestHash: "b".repeat(64),
    stream: false,
    model: "provider/model",
    provider: "provider",
    runId: "provider-api-failed",
    reserveMicros: 100,
  });
  if (failed.kind !== "started") throw new Error("request did not start");
  const failedRun = repo.usageRuns.get(failed.usageRun.id)!;
  failedRun.executionEpoch = 1;
  failedRun.actualProviderCostMicros = 5;
  repo.failApiRequest({
    id: failed.request.id,
    leaseToken: failed.leaseToken,
    responseStatus: 502,
    responseBody: "{}",
    billing: { mode: "refund" },
  });
  assertEquals({ status: failedRun.status, cost: failedRun.costMicros }, {
    status: "failed",
    cost: 0,
  });
  assertEquals(failedRun.actualProviderCostMicros, 5);

  const stale = repo.reserve(user.id, "provider-run-stale", "provider/model", 100);
  stale.executionEpoch = 1;
  stale.actualProviderCostMicros = 3;
  stale.runLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  assertEquals(repo.reapStaleProviderExecutionLeases(), 1);
  assertEquals({ status: stale.status, cost: stale.costMicros, lease: stale.runLeaseToken }, {
    status: "failed",
    cost: 0,
    lease: null,
  });
  assertEquals(stale.actualProviderCostMicros, 3);
});

Deno.test("paid provider generation failure remains failed and replays durably", () => {
  const repo = new MemoryRepository();
  const user = repo.createUser({
    email: "provider-generation-failure@example.com",
    name: "Provider failure",
    passwordHash: "hash",
    approvalStatus: "approved",
  });
  user.balanceMicros = 1_000;
  const conversation = repo.createConversation(user.id, "Failure");
  const input = {
    message: {
      conversationId: conversation.id,
      ownerId: user.id,
      parentId: null,
      role: "user" as const,
      content: "fail",
      model: "provider/model",
      expectedVersion: 0,
      idempotencyKey: "paid-failure-user",
    },
    runId: "paid-failure-run",
    provider: "provider",
    reserveMicros: 100,
  };
  const begun = repo.beginGeneration(input);
  if (begun.kind !== "started") throw new Error("generation did not start");
  const run = repo.usageRuns.get(input.runId)!;
  run.executionEpoch = 1;
  run.actualProviderCostMicros = 4;
  const failed = repo.failGeneration({
    conversationId: conversation.id,
    ownerId: user.id,
    userMessageId: begun.message.id,
    runId: input.runId,
    leaseToken: begun.leaseToken,
    idempotencyKey: "paid-failure-assistant",
    model: "provider/model",
    error: "provider failed",
  });
  assertEquals({ status: failed.usageRun.status, cost: failed.usageRun.costMicros }, {
    status: "failed",
    cost: 0,
  });
  assertEquals(failed.usageRun.actualProviderCostMicros, 4);
  const replay = repo.beginGeneration(input);
  assertEquals(replay.kind, "completed");
  assertEquals(replay.usageRun.status, "failed");
});

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

Deno.test("audit listing filters and paginates with a stable tuple cursor", () => {
  const repo = new MemoryRepository();
  const actor = crypto.randomUUID();
  const target = crypto.randomUUID();
  const events = [
    repo.recordAudit({
      actorId: actor,
      action: "user.approve",
      targetType: "user",
      targetId: target,
    }),
    repo.recordAudit({
      actorId: actor,
      action: "user.reject",
      targetType: "user",
      targetId: target,
    }),
    repo.recordAudit({ action: "system.cleanup", targetType: "job" }),
  ];
  events[0].createdAt = "2026-01-01T00:00:00.000Z";
  events[0].id = "00000000-0000-4000-8000-000000000001";
  events[1].createdAt = "2026-01-02T00:00:00.000Z";
  events[1].id = "00000000-0000-4000-8000-000000000002";
  events[2].createdAt = "2026-01-02T00:00:00.000Z";
  events[2].id = "00000000-0000-4000-8000-000000000003";

  const first = repo.listAudit({ limit: 2 });
  assertEquals(first.data.map((event) => event.id), [events[2].id, events[1].id]);
  assertEquals(typeof first.nextCursor, "string");
  const second = repo.listAudit({ limit: 2, cursor: first.nextCursor! });
  assertEquals(second.data.map((event) => event.id), [events[0].id]);
  assertEquals(second.nextCursor, null);

  assertEquals(repo.listAudit({ action: "user.approve" }).data.map((event) => event.id), [
    events[0].id,
  ]);
  assertEquals(
    repo.listAudit({
      actorId: actor,
      targetType: "user",
      targetId: target,
      from: "2026-01-02T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
    }).data.map((event) => event.id),
    [events[1].id],
  );
  assertThrows(() => repo.listAudit({ limit: 201 }), DomainError, "between 1 and 200");
  assertThrows(() => repo.listAudit({ cursor: "not-a-cursor" }), DomainError, "cursor");
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

  const archived = repo.updateConversation(user.id, conversation.id, {
    archived: true,
    expectedVersion: conversation.version,
  });
  assertReadOnly();
  repo.updateConversation(user.id, conversation.id, {
    archived: false,
    deleted: true,
    expectedVersion: archived.version,
  });
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
  const abandonedGenerationId = crypto.randomUUID();
  const abandoned = repo.beginGeneration({
    ...input,
    message: {
      ...input.message,
      conversationId: second.id,
      expectedVersion: 0,
      idempotencyKey: "reaper-user",
    },
    runId: "reaper-run",
    generationId: abandonedGenerationId,
  });
  if (abandoned.kind !== "started") throw new Error("reaper generation did not start");
  abandoned.usageRun.generationLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  assertThrows(
    () => repo.requestGenerationStop(second.id, user.id, abandonedGenerationId),
    DomainError,
    "already complete",
  );
  assertEquals(repo.reapStaleGenerations(), 1);
  assertEquals(repo.reapStaleGenerations(), 0);
  assertEquals(abandoned.usageRun.status, "failed");
  const reapedAssistant = repo.detail(second.id, user.id).messages.find((message) =>
    message.role === "assistant"
  );
  assertEquals(reapedAssistant?.status, "error");
  assertEquals(reapedAssistant?.metadata.runId, "reaper-run");

  const stoppedConversation = repo.createConversation(user.id, "Stopped reaper");
  const stoppedGenerationId = crypto.randomUUID();
  const stopped = repo.beginGeneration({
    ...input,
    message: {
      ...input.message,
      conversationId: stoppedConversation.id,
      expectedVersion: 0,
      idempotencyKey: "stopped-reaper-user",
    },
    runId: "stopped-reaper-run",
    generationId: stoppedGenerationId,
  });
  if (stopped.kind !== "started") throw new Error("stopped reaper did not start");
  repo.requestGenerationStop(stoppedConversation.id, user.id, stoppedGenerationId);
  stopped.usageRun.generationLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
  assertEquals(repo.reapStaleGenerations(), 1);
  const stoppedAssistant = repo.detail(stoppedConversation.id, user.id).messages.find((message) =>
    message.role === "assistant"
  );
  assertEquals(stoppedAssistant?.status, "stopped");
  assertEquals(stoppedAssistant?.metadata.stopReason, "user");
});

Deno.test("stream generation controls fence concurrent sends and preserve regenerate lineage", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "stream-owner@example.com",
    name: "Owner",
    passwordHash: "x",
  });
  const stranger = repo.createUser({
    email: "stream-other@example.com",
    name: "Other",
    passwordHash: "x",
  });
  repo.credit(owner.id, "stream-grant", "grant", 1_000_000);
  const conversation = repo.createConversation(owner.id, "Streaming");
  const generationId = crypto.randomUUID();
  assertThrows(
    () =>
      repo.beginGeneration({
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          role: "assistant",
          content: "invalid root role",
          model: "simulated/dg-chat",
          expectedVersion: 0,
          idempotencyKey: "stream-invalid-role",
        },
        runId: "stream-invalid-role",
        provider: "simulated",
        reserveMicros: 100,
      }),
    DomainError,
    "user message",
  );
  const started = repo.beginGeneration({
    message: {
      conversationId: conversation.id,
      ownerId: owner.id,
      parentId: null,
      role: "user",
      content: "original",
      model: "simulated/dg-chat",
      expectedVersion: 0,
      idempotencyKey: "stream-user-original",
    },
    runId: "stream-run-original",
    generationId,
    provider: "simulated",
    reserveMicros: 100,
  });
  if (started.kind !== "started") throw new Error("stream did not start");
  assertThrows(
    () =>
      repo.beginGeneration({
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: started.message.id,
          role: "user",
          content: "concurrent",
          model: "simulated/dg-chat",
          expectedVersion: started.conversation.version,
          idempotencyKey: "stream-user-concurrent",
        },
        runId: "stream-run-concurrent",
        provider: "simulated",
        reserveMicros: 100,
      }),
    DomainError,
    "already active",
  );
  assertThrows(
    () => repo.requestGenerationStop(conversation.id, stranger.id, generationId),
    DomainError,
    "not found",
  );
  assertEquals(
    repo.requestGenerationStop(conversation.id, owner.id, generationId).generationId,
    generationId,
  );
  assertEquals(
    repo.generationStopRequested("stream-run-original", owner.id, started.leaseToken),
    true,
  );
  const original = repo.completeGeneration({
    conversationId: conversation.id,
    ownerId: owner.id,
    userMessageId: started.message.id,
    runId: "stream-run-original",
    leaseToken: started.leaseToken,
    idempotencyKey: "stream-assistant-original",
    content: "first answer",
    model: "simulated/dg-chat",
    costMicros: 10,
    inputTokens: 2,
    outputTokens: 3,
    latencyMs: 1,
    status: "stopped",
    metadata: { runId: "stream-run-original" },
  });
  assertEquals(original.message.status, "stopped");
  assertThrows(
    () =>
      repo.beginGeneration({
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: started.message.id,
          role: "user",
          content: "user messages cannot follow user messages",
          model: "simulated/dg-chat",
          expectedVersion: original.conversation.version,
          idempotencyKey: "stream-invalid-user-parent",
        },
        runId: "stream-invalid-user-parent",
        provider: "simulated",
        reserveMicros: 100,
      }),
    DomainError,
    "must follow an assistant",
  );
  assertThrows(
    () =>
      repo.beginGeneration({
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          role: "user",
          content: "a second root requires explicit edit lineage",
          model: "simulated/dg-chat",
          expectedVersion: original.conversation.version,
          idempotencyKey: "stream-invalid-extra-root",
        },
        runId: "stream-invalid-extra-root",
        provider: "simulated",
        reserveMicros: 100,
      }),
    DomainError,
    "requires a parent",
  );
  const regenerated = repo.beginAssistantGeneration({
    conversationId: conversation.id,
    ownerId: owner.id,
    sourceAssistantId: original.message.id,
    mode: "regenerate",
    model: "simulated/dg-chat",
    expectedVersion: original.conversation.version,
    idempotencyKey: "stream-regenerate",
    runId: "stream-run-regenerate",
    generationId: crypto.randomUUID(),
    provider: "simulated",
    reserveMicros: 100,
  });
  if (regenerated.kind !== "started") throw new Error("regenerate did not start");
  assertEquals(regenerated.message.id, started.message.id);
  const replacement = repo.completeGeneration({
    conversationId: conversation.id,
    ownerId: owner.id,
    userMessageId: regenerated.message.id,
    runId: "stream-run-regenerate",
    leaseToken: regenerated.leaseToken,
    idempotencyKey: "stream-assistant-regenerate",
    content: "second answer",
    model: "simulated/dg-chat",
    costMicros: 10,
    inputTokens: 2,
    outputTokens: 3,
    latencyMs: 1,
    supersedesId: original.message.id,
    metadata: { runId: "stream-run-regenerate" },
  });
  assertEquals(replacement.message.parentId, original.message.parentId);
  assertEquals(replacement.message.supersedesId, original.message.id);
  assertEquals(repo.detail(conversation.id, owner.id).messages.length, 3);
});

Deno.test("assistant generation fence is conversation-wide across different active-path sources", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "source-fence@example.com",
    name: "Owner",
    passwordHash: "x",
  });
  repo.credit(owner.id, "source-fence-grant", "grant", 1_000_000);
  const conversation = repo.createConversation(owner.id, "Sources");
  const userOne = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "one",
    expectedVersion: 0,
    idempotencyKey: "source-user-one",
  });
  const assistantOne = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: userOne.id,
    role: "assistant",
    content: "one answer",
    expectedVersion: 1,
    idempotencyKey: "source-assistant-one",
  });
  const userTwo = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: assistantOne.id,
    role: "user",
    content: "two",
    expectedVersion: 2,
    idempotencyKey: "source-user-two",
  });
  const assistantTwo = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: userTwo.id,
    role: "assistant",
    content: "two answer",
    expectedVersion: 3,
    idempotencyKey: "source-assistant-two",
  });
  repo.beginAssistantGeneration({
    conversationId: conversation.id,
    ownerId: owner.id,
    sourceAssistantId: assistantOne.id,
    mode: "regenerate",
    model: "simulated/dg-chat",
    expectedVersion: 4,
    idempotencyKey: "source-first-run",
    runId: "source-first-run",
    generationId: crypto.randomUUID(),
    provider: "simulated",
    reserveMicros: 10,
  });
  assertThrows(
    () =>
      repo.beginAssistantGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        sourceAssistantId: assistantTwo.id,
        mode: "regenerate",
        model: "simulated/dg-chat",
        expectedVersion: 4,
        idempotencyKey: "source-second-run",
        runId: "source-second-run",
        generationId: crypto.randomUUID(),
        provider: "simulated",
        reserveMicros: 10,
      }),
    DomainError,
    "already being generated",
  );
});

Deno.test("earlier assistant generation selects its branch and preserves a later explicit selection", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "earlier-branch@example.com",
    name: "Owner",
    passwordHash: "x",
  });
  repo.credit(owner.id, "earlier-branch-grant", "grant", 1_000_000);
  const conversation = repo.createConversation(owner.id, "Earlier branch");
  const userOne = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "one",
    expectedVersion: 0,
    idempotencyKey: "earlier-user-one",
  });
  const assistantOne = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: userOne.id,
    role: "assistant",
    content: "one answer",
    expectedVersion: 1,
    idempotencyKey: "earlier-assistant-one",
  });
  const userTwo = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: assistantOne.id,
    role: "user",
    content: "two",
    expectedVersion: 2,
    idempotencyKey: "earlier-user-two",
  });
  const assistantTwo = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: userTwo.id,
    role: "assistant",
    content: "two answer",
    expectedVersion: 3,
    idempotencyKey: "earlier-assistant-two",
  });
  const begun = repo.beginAssistantGeneration({
    conversationId: conversation.id,
    ownerId: owner.id,
    sourceAssistantId: assistantOne.id,
    mode: "regenerate",
    model: "simulated/dg-chat",
    expectedVersion: 4,
    idempotencyKey: "earlier-regenerate",
    runId: "earlier-regenerate-run",
    generationId: crypto.randomUUID(),
    provider: "simulated",
    reserveMicros: 10,
  });
  if (begun.kind !== "started") throw new Error("generation did not start");
  assertEquals(begun.conversation.activeLeafId, assistantOne.id);
  assertEquals(begun.conversation.version, 5);

  const selected = repo.setActiveLeaf(conversation.id, owner.id, assistantTwo.id, 5);
  assertEquals(selected.activeLeafId, assistantTwo.id);
  const completed = repo.completeGeneration({
    conversationId: conversation.id,
    ownerId: owner.id,
    userMessageId: userOne.id,
    runId: "earlier-regenerate-run",
    leaseToken: begun.leaseToken,
    idempotencyKey: "earlier-regenerate-assistant",
    content: "replacement",
    model: "simulated/dg-chat",
    costMicros: 1,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    supersedesId: assistantOne.id,
  });
  assertEquals(completed.conversation.activeLeafId, assistantTwo.id);
  assertEquals(completed.message.supersedesId, assistantOne.id);
});

Deno.test("earlier failed and reaped generations advance only an untouched branch selection", () => {
  for (const terminal of ["failure", "reaper"] as const) {
    for (const preserveLaterSelection of [false, true]) {
      const suffix = `${terminal}-${preserveLaterSelection ? "selected" : "untouched"}`;
      const repo = new MemoryRepository();
      const owner = repo.createUser({
        email: `earlier-${suffix}@example.com`,
        name: "Owner",
        passwordHash: "x",
      });
      repo.credit(owner.id, `earlier-${suffix}-grant`, "grant", 1_000_000);
      const conversation = repo.createConversation(owner.id, `Earlier ${suffix}`);
      const userOne = repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "one",
        expectedVersion: 0,
        idempotencyKey: `${suffix}-user-one`,
      });
      const assistantOne = repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: userOne.id,
        role: "assistant",
        content: "one answer",
        expectedVersion: 1,
        idempotencyKey: `${suffix}-assistant-one`,
      });
      const userTwo = repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: assistantOne.id,
        role: "user",
        content: "two",
        expectedVersion: 2,
        idempotencyKey: `${suffix}-user-two`,
      });
      const assistantTwo = repo.appendMessage({
        conversationId: conversation.id,
        ownerId: owner.id,
        parentId: userTwo.id,
        role: "assistant",
        content: "two answer",
        expectedVersion: 3,
        idempotencyKey: `${suffix}-assistant-two`,
      });
      const runId = `${suffix}-run`;
      const begun = repo.beginAssistantGeneration({
        conversationId: conversation.id,
        ownerId: owner.id,
        sourceAssistantId: assistantOne.id,
        mode: "regenerate",
        model: "simulated/dg-chat",
        expectedVersion: 4,
        idempotencyKey: `${suffix}-regenerate`,
        runId,
        generationId: crypto.randomUUID(),
        provider: "simulated",
        reserveMicros: 10,
      });
      if (begun.kind !== "started") throw new Error("generation did not start");
      if (preserveLaterSelection) {
        repo.setActiveLeaf(conversation.id, owner.id, assistantTwo.id, begun.conversation.version);
      }

      let terminalMessageId: string;
      if (terminal === "failure") {
        terminalMessageId = repo.failGeneration({
          conversationId: conversation.id,
          ownerId: owner.id,
          userMessageId: userOne.id,
          runId,
          leaseToken: begun.leaseToken,
          idempotencyKey: `${suffix}-error`,
          model: "simulated/dg-chat",
          error: "provider failed",
          supersedesId: assistantOne.id,
        }).message.id;
      } else {
        begun.usageRun.generationLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
        assertEquals(repo.reapStaleGenerations(), 1);
        const terminalMessage = repo.detail(conversation.id, owner.id).messages.find((message) =>
          message.metadata.runId === runId
        );
        if (!terminalMessage) throw new Error("reaper terminal was not created");
        terminalMessageId = terminalMessage.id;
      }

      assertEquals(
        repo.detail(conversation.id, owner.id).activeLeafId,
        preserveLaterSelection ? assistantTwo.id : terminalMessageId,
        suffix,
      );
    }
  }
});

Deno.test("attachments deduplicate, inspect, link immutably, and preserve tombstones", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "files@example.com", name: "Files", passwordHash: "x" });
  const stranger = repo.createUser({
    email: "stranger-files@example.com",
    name: "Stranger",
    passwordHash: "x",
  });
  const conversation = repo.createConversation(owner.id, "Files");
  const message = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "see file",
    expectedVersion: 0,
    idempotencyKey: "files-message",
  });
  const input = {
    ownerId: owner.id,
    objectKey: `users/${owner.id}/objects/one`,
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    sha256: "a".repeat(64),
  };
  const created = repo.createAttachment(input);
  const replay = repo.createAttachment({ ...input, objectKey: `users/${owner.id}/objects/two` });
  assertEquals(replay.attachment.id, created.attachment.id);
  assertEquals(replay.inspectionJobId, created.inspectionJobId);
  assertEquals(replay.deduplicated, true);
  assertEquals(repo.listJobs().items.filter((job) => job.type === "attachment.inspect").length, 1);
  assertThrows(
    () => repo.getAttachment(created.attachment.id, stranger.id),
    DomainError,
    "not found",
  );
  repo.transitionAttachment(created.attachment.id, owner.id, "pending", "inspecting");
  repo.transitionAttachment(created.attachment.id, owner.id, "inspecting", "ready");
  repo.linkAttachmentToMessage(message.id, created.attachment.id, owner.id);
  repo.linkAttachmentToMessage(message.id, created.attachment.id, owner.id);
  assertEquals(repo.listMessageAttachments(message.id, owner.id).length, 1);
  assertThrows(
    () => repo.linkAttachmentToMessage(message.id, created.attachment.id, stranger.id),
    DomainError,
  );
  repo.deleteAttachment(created.attachment.id, owner.id);
  assertEquals(repo.listAttachments(owner.id).length, 0);
  assertEquals(repo.listMessageAttachments(message.id, owner.id)[0].state, "deleted");
  const replacement = repo.createAttachment({
    ...input,
    objectKey: `users/${owner.id}/objects/replacement`,
  });
  assertEquals(replacement.deduplicated, false);
  assertEquals(replacement.attachment.id === created.attachment.id, false);
  assertThrows(
    () =>
      repo.createAttachment({
        ...input,
        objectKey: "../unsafe",
        sha256: "not-a-digest",
      }),
    DomainError,
    "SHA-256",
  );
});

Deno.test("generation atomically links only ready attachments and rejects attachment replay drift", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "generation-files@example.com",
    name: "Generation Files",
    passwordHash: "x",
  });
  repo.credit(owner.id, "generation-files-grant", "grant", 1_000_000);
  const conversation = repo.createConversation(owner.id, "Generation files");
  assertThrows(
    () =>
      repo.beginGeneration({
        message: {
          conversationId: conversation.id,
          ownerId: owner.id,
          parentId: null,
          role: "user",
          content: "   ",
          model: "simulated/dg-chat",
          expectedVersion: 0,
          idempotencyKey: "generation-empty-message",
        },
        runId: "generation-empty-run",
        provider: "simulated",
        reserveMicros: 100,
        attachmentIds: [],
      }),
    DomainError,
    "content or at least one attachment",
  );
  assertEquals(repo.detail(conversation.id, owner.id).messages.length, 0);
  assertEquals(repo.findUser(owner.id)?.balanceMicros, 1_000_000);
  const created = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `users/${owner.id}/objects/generation-file`,
    filename: "ready.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    sha256: "c".repeat(64),
  });
  const input = {
    message: {
      conversationId: conversation.id,
      ownerId: owner.id,
      parentId: null,
      role: "user" as const,
      content: "Use this file",
      model: "simulated/dg-chat",
      expectedVersion: 0,
      idempotencyKey: "generation-file-message",
    },
    runId: "generation-file-run",
    provider: "simulated",
    reserveMicros: 100,
    attachmentIds: [created.attachment.id],
  };

  assertThrows(
    () => repo.beginGeneration(input),
    DomainError,
    "not ready",
  );
  assertEquals(repo.detail(conversation.id, owner.id).messages.length, 0);
  assertEquals(repo.findUser(owner.id)?.balanceMicros, 1_000_000);

  repo.transitionAttachment(created.attachment.id, owner.id, "pending", "inspecting");
  repo.transitionAttachment(created.attachment.id, owner.id, "inspecting", "ready");
  const started = repo.beginGeneration(input);
  if (started.kind !== "started") throw new Error("generation did not start");
  assertEquals(repo.listMessageAttachments(started.message.id, owner.id).map((a) => a.id), [
    created.attachment.id,
  ]);
  assertEquals(repo.beginGeneration(input).kind, "in_progress");
  assertThrows(
    () => repo.beginGeneration({ ...input, attachmentIds: [] }),
    DomainError,
    "payload differs",
  );
  assertEquals(repo.detail(conversation.id, owner.id).messages.length, 1);
  assertEquals(repo.findUser(owner.id)?.balanceMicros, 999_900);
  assertEquals(repo.listMessageAttachments(started.message.id, owner.id).length, 1);
});

Deno.test("text ingestion is separate, idempotent, replaceable, retryable, and owner-isolated", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "ingest@example.com", name: "Ingest", passwordHash: "x" });
  const stranger = repo.createUser({
    email: "stranger-ingest@example.com",
    name: "No",
    passwordHash: "x",
  });
  const created = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `uploads/${owner.id}/ingest.txt`,
    filename: "ingest.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    sha256: "b".repeat(64),
    state: "ready",
  });
  assertEquals(created.attachment.state, "ready");
  assertEquals(created.attachment.ingestionStatus, "queued");
  assertEquals(repo.listJobs().items.filter((job) => job.type === "attachment.ingest").length, 1);
  const replay = repo.createAttachment({
    ownerId: owner.id,
    objectKey: `uploads/${owner.id}/duplicate.txt`,
    filename: "ingest.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    sha256: "b".repeat(64),
    state: "ready",
  });
  assertEquals(replay.attachment.id, created.attachment.id);
  assertEquals(repo.listJobs().items.filter((job) => job.type === "attachment.ingest").length, 1);
  repo.beginAttachmentIngestion(created.attachment.id, owner.id);
  const first = [{
    id: "00000000-0000-8000-8000-000000000001",
    ordinal: 0,
    content: "hello",
    metadata: {
      sourceAttachmentId: created.attachment.id,
      extractorVersion: "plain-text-v2",
      chunkerVersion: "character-window-v1",
      pageNumber: 2,
      pageLabel: "ii",
      section: "Introduction",
      sectionPath: ["Guide", "Introduction"],
      startLine: 1,
      endLine: 1,
    },
  }];
  repo.completeAttachmentIngestion(created.attachment.id, owner.id, first);
  assertEquals(repo.listDocumentChunks(created.attachment.id, owner.id), [
    { ...first[0], attachmentId: created.attachment.id },
  ]);
  first[0].metadata.section = "mutated by caller";
  assertEquals(
    repo.listDocumentChunks(created.attachment.id, owner.id)[0].metadata.section,
    "Introduction",
  );
  assertThrows(
    () => repo.listDocumentChunks(created.attachment.id, stranger.id),
    DomainError,
    "not found",
  );
  created.attachment.ingestionStatus = "processing";
  assertThrows(
    () =>
      repo.completeAttachmentIngestion(created.attachment.id, owner.id, [{
        ...first[0],
        ordinal: 1,
      }]),
    DomainError,
    "invalid",
  );
  assertThrows(
    () =>
      repo.completeAttachmentIngestion(created.attachment.id, owner.id, [{
        ...first[0],
        ordinal: 0,
        metadata: { ...first[0].metadata, pageNumber: 0 },
      }]),
    DomainError,
    "invalid",
  );
  assertEquals(repo.listDocumentChunks(created.attachment.id, owner.id)[0].content, "hello");
  repo.failAttachmentIngestion(created.attachment.id, owner.id, "object missing");
  assertThrows(
    () => repo.retryAttachmentIngestion(created.attachment.id, stranger.id),
    DomainError,
    "not found",
  );
  created.attachment.ingestionStatus = "queued";
  const ingestJob = repo.jobs.find((job) => job.type === "attachment.ingest")!;
  ingestJob.status = "failed";
  assertEquals(
    repo.retryAttachmentIngestion(created.attachment.id, owner.id).ingestionStatus,
    "queued",
  );
  repo.deleteAttachment(created.attachment.id, owner.id);
  assertThrows(
    () => repo.listDocumentChunks(created.attachment.id, owner.id),
    DomainError,
    "not found",
  );
});

Deno.test("PDF and DOCX ingestion eligibility queues and retries while unsupported Office fails closed", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: "formats@example.com",
    name: "Formats",
    passwordHash: "x",
  });
  const stranger = repo.createUser({
    email: "formats-stranger@example.com",
    name: "Stranger",
    passwordHash: "x",
  });
  const eligible = [
    ["application/pdf", "document.pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document.docx"],
  ] as const;
  for (const [index, [mimeType, filename]] of eligible.entries()) {
    let attachment = repo.createAttachment({
      ownerId: owner.id,
      objectKey: `uploads/${owner.id}/${filename}`,
      filename,
      mimeType,
      sizeBytes: 10,
      sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      state: index === 0 ? "ready" : "pending",
    }).attachment;
    if (index === 1) {
      repo.transitionAttachment(attachment.id, owner.id, "pending", "inspecting");
      attachment = repo.transitionAttachment(
        attachment.id,
        owner.id,
        "inspecting",
        "ready",
      );
    }
    assertEquals(attachment.ingestionStatus, "queued");
    assertThrows(
      () => repo.beginAttachmentIngestion(attachment.id, stranger.id),
      DomainError,
      "not found",
    );
    assertEquals(
      repo.beginAttachmentIngestion(attachment.id, owner.id).ingestionStatus,
      "processing",
    );
    assertEquals(
      repo.failAttachmentIngestion(attachment.id, owner.id, "extract failed").ingestionStatus,
      "failed",
    );
    assertThrows(
      () => repo.retryAttachmentIngestion(attachment.id, stranger.id),
      DomainError,
      "not found",
    );
    assertEquals(repo.retryAttachmentIngestion(attachment.id, owner.id).ingestionStatus, "queued");
  }
  assertEquals(repo.listJobs().items.filter((job) => job.type === "attachment.ingest").length, 2);

  for (
    const mimeType of [
      "application/vnd.ms-word.document.macroEnabled.12",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]
  ) {
    const attachment = repo.createAttachment({
      ownerId: owner.id,
      objectKey: `uploads/${owner.id}/${crypto.randomUUID()}`,
      filename: "unsupported.office",
      mimeType,
      sizeBytes: 10,
      sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      state: "ready",
    }).attachment;
    assertEquals(attachment.ingestionStatus, "not_applicable");
    assertThrows(
      () => repo.beginAttachmentIngestion(attachment.id, owner.id),
      DomainError,
      "cannot be ingested",
    );
  }
  assertEquals(repo.listJobs().items.filter((job) => job.type === "attachment.ingest").length, 2);
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
  repo.createSession(user.id, "limited-session", true);
  repo.approveUser(user.id, "approved", 100);
  assertEquals(repo.getSession("limited-session")?.limited, true);
  repo.reserve(user.id, "spend", "model", 100);
  repo.settle("spend", 100, 1, 1, 1);
  repo.approveUser(user.id, "rejected", 100);
  assertEquals(repo.getSession("limited-session")?.limited, true);
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
  assertEquals(repo.getSession("limited-session")?.limited, true);
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
  // A provider may resend the same still-valid token. Registration is idempotent only while its
  // exact authority remains unconsumed and owner/purpose-identical.
  repo.createIdentityToken(
    user.id,
    "email_verification",
    "verify-hash",
    new Date(Date.now() + 60_000).toISOString(),
  );
  const otherUser = repo.createUser({
    email: "identity-other@example.com",
    name: "Other Identity",
    passwordHash: "old",
  });
  assertThrows(
    () =>
      repo.createIdentityToken(
        otherUser.id,
        "email_verification",
        "verify-hash",
        new Date(Date.now() + 60_000).toISOString(),
      ),
    DomainError,
    "conflicts",
  );
  repo.createIdentityToken(
    user.id,
    "email_verification",
    "verify-hash-concurrent",
    new Date(Date.now() + 60_000).toISOString(),
  );
  assertEquals(repo.verifyEmail("verify-hash").emailVerifiedAt !== null, true);
  assertThrows(
    () =>
      repo.createIdentityToken(
        user.id,
        "email_verification",
        "verify-hash",
        new Date(Date.now() + 60_000).toISOString(),
      ),
    DomainError,
    "conflicts",
  );
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
  assertEquals(repo.getApiRequest(user.id, input.endpoint, input.idempotencyKey), undefined);
  assertEquals(repo.apiIdempotencyRequests.has(completed.id), false);
  assertEquals(
    repo.apiIdempotencyKeys.has(`${user.id}:${input.endpoint}:${input.idempotencyKey}`),
    false,
  );
  assertEquals(repo.pruneExpiredApiRequests(), 0);
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

Deno.test("workspace organization versions moves and preferences are atomic", () => {
  const repo = new MemoryRepository();
  const owner = repo.createUser({ email: "workspace@example.com", name: "Workspace" });
  const preferences = repo.getUserPreferences(owner.id);
  const updated = repo.updateUserPreferences(owner.id, {
    expectedVersion: preferences.version,
    theme: "dark",
    customInstructions: "Prefer concise answers.",
  });
  assertEquals(updated.theme, "dark");
  assertEquals("expectedVersion" in updated, false);
  assertThrows(
    () =>
      repo.updateUserPreferences(owner.id, {
        expectedVersion: preferences.version,
        theme: "light",
      }),
    DomainError,
    "changed",
  );

  const first = repo.createConversationFolder(owner.id, "First", "folder-first");
  const second = repo.createConversationFolder(owner.id, "Second", "folder-second");
  assertEquals(repo.createConversationFolder(owner.id, "First", "folder-first").id, first.id);
  assertThrows(
    () => repo.createConversationFolder(owner.id, "Drift", "folder-first"),
    DomainError,
    "replay payload differs",
  );
  const unicode = repo.createConversationFolder(owner.id, "İstanbul", "folder-unicode");
  assertEquals(
    repo.createConversationFolder(owner.id, "İstanbul", "folder-unicode").id,
    unicode.id,
  );
  const chat = repo.createConversation(owner.id, "Organize");
  repo.replaceFolderMemberships(owner.id, first.id, [chat.id], { [first.id]: 0 });
  const afterFirst = repo.listConversationFolders(owner.id).folders;
  assertEquals(afterFirst.find((folder) => folder.id === first.id)?.membershipVersion, 1);
  assertThrows(
    () => repo.replaceFolderMemberships(owner.id, second.id, [chat.id], { [second.id]: 0 }),
    DomainError,
    "changed",
  );
  repo.replaceFolderMemberships(owner.id, second.id, [chat.id], {
    [first.id]: 1,
    [second.id]: 0,
  });
  const moved = repo.listConversationFolders(owner.id);
  assertEquals(moved.memberships[0].folderId, second.id);
  assertEquals(moved.folders.find((folder) => folder.id === first.id)?.membershipVersion, 2);
  assertEquals(moved.folders.find((folder) => folder.id === second.id)?.membershipVersion, 1);

  const beforeOrder = moved.folders.map((folder) => ({ ...folder }));
  assertThrows(
    () =>
      repo.reorderConversationFolders(owner.id, [second.id, first.id], {
        [second.id]: second.version,
        [first.id]: first.version + 99,
      }),
    DomainError,
    "changed",
  );
  assertEquals(repo.listConversationFolders(owner.id).folders, beforeOrder);

  const tag = repo.createConversationTag(owner.id, "Important", "#ff0000", "tag-important");
  assertEquals(
    repo.createConversationTag(owner.id, "Important", "#ff0000", "tag-important").id,
    tag.id,
  );
  assertThrows(
    () => repo.createConversationTag(owner.id, "Important", "#00ff00", "tag-important"),
    DomainError,
    "replay payload differs",
  );
  const assignment = repo.replaceConversationTags(owner.id, chat.id, [tag.id], 0);
  repo.deleteConversationTag(owner.id, tag.id, tag.version);
  assertEquals(
    repo.listConversationTags(owner.id).tagSets.find((set) => set.conversationId === chat.id)
      ?.version,
    assignment.tagSet.version + 1,
  );
  const temporary = repo.createConversation(owner.id, "Temporary", true);
  assertThrows(
    () => repo.replaceConversationTags(owner.id, temporary.id, [], 0),
    DomainError,
    "cannot be organized",
  );
  assertThrows(
    () => repo.deleteConversationFolder(owner.id, second.id, second.version, 0),
    DomainError,
    "membership changed",
  );
  repo.deleteConversationFolder(owner.id, second.id, second.version, 1);
});
