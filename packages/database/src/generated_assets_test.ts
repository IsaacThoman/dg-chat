import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { DomainError, MemoryRepository } from "./memory.ts";

function fixture() {
  const repo = new MemoryRepository();
  const owner = repo.createUser({
    email: `asset-owner-${crypto.randomUUID()}@example.test`,
    name: "Asset owner",
    passwordHash: "hash",
    approvalStatus: "approved",
  });
  const stranger = repo.createUser({
    email: `asset-stranger-${crypto.randomUUID()}@example.test`,
    name: "Asset stranger",
    passwordHash: "hash",
    approvalStatus: "approved",
  });
  const provider = repo.createProvider({
    slug: `images-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Images",
    baseUrl: "https://images.example/v1",
    protocol: "responses",
  }, { actorId: owner.id, action: "provider.create" });
  const model = repo.createProviderModel({
    providerId: provider.id,
    publicModelId: `${provider.slug}/artist`,
    upstreamModelId: "artist-v1",
    displayName: "Artist",
    capabilities: ["image_generation"],
    contextWindow: 1,
  }, { actorId: owner.id, action: "provider_model.create" });
  const price = repo.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 1,
    cachedInputMicrosPerMillion: 2,
    reasoningMicrosPerMillion: 3,
    outputMicrosPerMillion: 4,
    fixedCallMicros: 5,
    source: "asset-test",
  }, { actorId: owner.id, action: "model_price.create" });
  const pricingSnapshot = {
    pricingVersionId: price.id,
    inputMicrosPerMillion: price.inputMicrosPerMillion,
    cachedInputMicrosPerMillion: price.cachedInputMicrosPerMillion,
    reasoningMicrosPerMillion: price.reasoningMicrosPerMillion,
    outputMicrosPerMillion: price.outputMicrosPerMillion,
    fixedCallMicros: price.fixedCallMicros,
    source: price.source,
  };
  repo.credit(owner.id, `asset-grant-${crypto.randomUUID()}`, "grant", 10_000);
  repo.reserve(
    owner.id,
    "asset-run-0001",
    model.publicModelId,
    100,
    provider.slug,
    undefined,
    pricingSnapshot,
  );
  const createAttachment = (name: string, sha: string) =>
    repo.createAttachment({
      ownerId: owner.id,
      objectKey: `generated/${owner.id}/${crypto.randomUUID()}.png`,
      filename: `${name}.png`,
      mimeType: "image/png",
      sizeBytes: 100,
      sha256: sha.repeat(64).slice(0, 64),
      state: "ready",
    }).attachment;
  const identitySnapshot = {
    publicModelId: model.publicModelId,
    upstreamModelId: model.upstreamModelId,
    providerSlug: provider.slug,
    pricingSnapshot,
  };
  return { repo, owner, stranger, provider, model, identitySnapshot, createAttachment };
}

Deno.test("generated assets preserve immutable lineage, ownership, and message attachments", () => {
  const { repo, owner, stranger, provider, model, identitySnapshot, createAttachment } = fixture();
  const source = createAttachment("source", "a");
  const mask = createAttachment("mask", "b");
  const output = createAttachment("output", "c");
  const input = {
    ownerId: owner.id,
    usageRunId: "asset-run-0001",
    providerModelId: model.id,
    ...identitySnapshot,
    idempotencyKey: "generated-assets-0001",
    requestHash: "d".repeat(64),
    operation: "edit" as const,
    prompt: "Revise the generated image",
    providerCreatedAt: 1_700_000_000,
    assets: [{
      attachmentId: output.id,
      ordinal: 0,
      width: 1024,
      height: 1024,
      revisedPrompt: "A safer revised prompt",
      inputs: [
        { attachmentId: source.id, role: "source" as const, ordinal: 0 },
        { attachmentId: mask.id, role: "mask" as const, ordinal: 0 },
      ],
    }],
  };
  const stage = repo.stageGeneratedObject({
    ownerId: owner.id,
    usageRunId: input.usageRunId,
    ordinal: 0,
    objectKey: output.objectKey,
    mimeType: output.mimeType,
    sizeBytes: output.sizeBytes,
    sha256: output.sha256,
  });
  repo.markGeneratedObjectStored(stage.id, owner.id);
  repo.attachGeneratedObject(stage.id, owner.id, output.id);
  const first = repo.finalizeGeneratedAssets(input);
  assertEquals(repo.generatedObjectStages.get(stage.id)?.state, "finalized");
  assertEquals(repo.finalizeGeneratedAssets(input), first);
  repo.updateProvider(provider.id, provider.version, { slug: "renamed-images" }, {
    actorId: owner.id,
    action: "provider.update",
  });
  const currentModel = repo.findProviderModel(model.id)!;
  repo.updateProviderModel(model.id, currentModel.version, {
    publicModelId: "renamed-images/new-artist",
    upstreamModelId: "artist-v2",
  }, { actorId: owner.id, action: "provider_model.update" });
  const historical = repo.getGeneratedAsset(first[0].id, owner.id);
  assertEquals({
    publicModelId: historical.publicModelId,
    upstreamModelId: historical.upstreamModelId,
    providerSlug: historical.providerSlug,
    pricingSnapshot: historical.pricingSnapshot,
  }, identitySnapshot);
  assertEquals(repo.finalizeGeneratedAssets(input)[0].id, first[0].id);
  assertEquals(first[0].inputs.map((item) => item.attachmentId), [source.id, mask.id]);
  assertThrows(() => repo.getGeneratedAsset(first[0].id, stranger.id), DomainError, "not found");

  const conversation = repo.createConversation(owner.id, "Generated image");
  const message = repo.appendMessage({
    conversationId: conversation.id,
    ownerId: owner.id,
    parentId: null,
    role: "user",
    content: "Keep this image",
    expectedVersion: conversation.version,
    idempotencyKey: "generated-message-0001",
  });
  repo.linkAttachmentToMessage(message.id, output.id, owner.id);
  assertEquals(repo.deleteGeneratedAsset(first[0].id, owner.id).deletedAt !== null, true);
  assertThrows(() => repo.getGeneratedAsset(first[0].id, owner.id), DomainError, "not found");
  assertEquals(repo.listMessageAttachments(message.id, owner.id)[0].id, output.id);
  assertEquals(repo.getAttachment(output.id, owner.id).state, "ready");
  assertEquals(repo.restoreGeneratedAsset(first[0].id, owner.id).deletedAt, null);
});

Deno.test("generated object crash stages are durably queued for cleanup", () => {
  for (const terminal of ["pending", "stored", "attached"] as const) {
    const { repo, owner, createAttachment } = fixture();
    const attachment = createAttachment(
      `crash-${terminal}`,
      terminal === "pending" ? "3" : terminal === "stored" ? "4" : "5",
    );
    const stage = repo.stageGeneratedObject({
      ownerId: owner.id,
      usageRunId: "asset-run-0001",
      ordinal: 0,
      objectKey: attachment.objectKey,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    });
    if (terminal !== "pending") repo.markGeneratedObjectStored(stage.id, owner.id);
    if (terminal === "attached") repo.attachGeneratedObject(stage.id, owner.id, attachment.id);
    assertEquals(repo.requestGeneratedObjectCleanup(owner.id, "asset-run-0001", "crash"), 1);
    assertEquals(repo.generatedObjectStages.get(stage.id)?.state, "cleanup_pending");
    assertEquals(
      repo.jobs.some((job) =>
        job.type === "generated_object.cleanup" &&
        (job.payload as { stageId?: string }).stageId === stage.id
      ),
      true,
    );
  }
});

Deno.test("stale API reaper preserves finalized image requests for recovery", () => {
  const { repo, owner, model, identitySnapshot, createAttachment } = fixture();
  const begun = repo.beginApiRequest({
    userId: owner.id,
    endpoint: "images.generations",
    idempotencyKey: "finalized-image-recovery",
    requestHash: "7".repeat(64),
    stream: false,
    model: model.publicModelId,
    runId: "finalized-image-api-run",
    reserveMicros: 100,
    pricingSnapshot: identitySnapshot.pricingSnapshot,
    provider: identitySnapshot.providerSlug,
  });
  if (begun.kind !== "started") throw new Error("expected started image request");
  const output = createAttachment("recoverable-output", "6");
  repo.finalizeGeneratedAssets({
    ownerId: owner.id,
    usageRunId: begun.usageRun.id,
    providerModelId: model.id,
    ...identitySnapshot,
    idempotencyKey: "finalized-image-recovery",
    requestHash: "7".repeat(64),
    operation: "generation",
    prompt: "Recover me",
    providerCreatedAt: 1_700_000_003,
    assets: [{
      attachmentId: output.id,
      ordinal: 0,
      width: 512,
      height: 512,
    }],
  });
  repo.apiIdempotencyRequests.get(begun.request.id)!.leaseExpiresAt = new Date(Date.now() - 1_000)
    .toISOString();
  assertEquals(repo.reapStaleApiRequests(), 0);
  assertEquals(
    repo.getApiRequest(owner.id, "images.generations", "finalized-image-recovery")?.state,
    "in_progress",
  );
});

Deno.test("generated asset finalization rejects replay drift and duplicate ordinal races", () => {
  const { repo, owner, model, identitySnapshot, createAttachment } = fixture();
  const firstOutput = createAttachment("first", "e");
  const secondOutput = createAttachment("second", "f");
  const input = {
    ownerId: owner.id,
    usageRunId: "asset-run-0001",
    providerModelId: model.id,
    ...identitySnapshot,
    idempotencyKey: "generated-assets-race",
    requestHash: "1".repeat(64),
    operation: "generation" as const,
    prompt: "Generate an image",
    providerCreatedAt: 1_700_000_001,
    assets: [{
      attachmentId: firstOutput.id,
      ordinal: 0,
      width: 512,
      height: 512,
    }],
  };
  const first = repo.finalizeGeneratedAssets(input);
  assertEquals(repo.finalizeGeneratedAssets(input)[0].id, first[0].id);
  assertThrows(
    () =>
      repo.finalizeGeneratedAssets({
        ...input,
        pricingSnapshot: { ...input.pricingSnapshot, fixedCallMicros: 6 },
      }),
    DomainError,
    "differs",
  );
  assertThrows(
    () =>
      repo.finalizeGeneratedAssets({
        ...input,
        assets: [{ ...input.assets[0], attachmentId: secondOutput.id }],
      }),
    DomainError,
    "differs",
  );
  assertThrows(
    () =>
      repo.finalizeGeneratedAssets({
        ...input,
        idempotencyKey: "generated-assets-other",
        requestHash: "2".repeat(64),
      }),
    DomainError,
    "already has generated assets",
  );
  assertThrows(
    () =>
      repo.finalizeGeneratedAssets({
        ...input,
        idempotencyKey: "generated-assets-invalid",
        assets: [{ ...input.assets[0], ordinal: 1 }],
      }),
    TypeError,
  );
});

Deno.test("generated asset validation counts Unicode scalars like the image API", () => {
  const { repo, owner, model, identitySnapshot, createAttachment } = fixture();
  const output = createAttachment("unicode-output", "9");
  const astralPrompt = "🎨".repeat(20_000);
  const input = {
    ownerId: owner.id,
    usageRunId: "asset-run-0001",
    providerModelId: model.id,
    ...identitySnapshot,
    idempotencyKey: "generated-assets-unicode",
    requestHash: "9".repeat(64),
    operation: "generation" as const,
    prompt: astralPrompt,
    providerCreatedAt: 1_700_000_002,
    assets: [{
      attachmentId: output.id,
      ordinal: 0,
      width: 512,
      height: 512,
      revisedPrompt: astralPrompt,
    }],
  };
  assertEquals(repo.finalizeGeneratedAssets(input)[0].prompt, astralPrompt);
  assertThrows(
    () =>
      repo.finalizeGeneratedAssets({
        ...input,
        usageRunId: "asset-run-0002",
        idempotencyKey: "generated-assets-unicode-too-long",
        requestHash: "8".repeat(64),
        prompt: "🎨".repeat(32_001),
      }),
    TypeError,
  );
});
