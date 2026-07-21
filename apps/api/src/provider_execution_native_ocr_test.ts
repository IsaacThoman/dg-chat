import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import type { ChatCompletionRequest } from "@dg-chat/contracts";
import { MemoryRepository } from "@dg-chat/database";
import { MemoryCircuitBreaker } from "./provider-circuit.ts";
import { ProviderExecutionEngine, reconcileNativeResponsesAfterOcr } from "./provider-execution.ts";
import { responsesRequestToChatCompletions } from "./provider-protocol.ts";
import { ProviderAttemptError } from "./provider-resilience.ts";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

const png = () => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, 1);
  new DataView(bytes.buffer).setUint32(20, 1);
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
};

function rewrittenOcrShadow(
  nativeRequest: Record<string, unknown>,
  texts: readonly string[],
): { original: ChatCompletionRequest; rewritten: ChatCompletionRequest } {
  const original = responsesRequestToChatCompletions(
    nativeRequest,
  ) as unknown as ChatCompletionRequest;
  const rewritten = structuredClone(original);
  let textIndex = 0;
  for (const message of rewritten.messages) {
    if (!Array.isArray(message.content)) continue;
    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      if (message.content[partIndex].type !== "image_url") continue;
      message.content[partIndex] = { type: "text", text: texts[textIndex++] };
    }
  }
  assertEquals(textIndex, texts.length);
  return { original, rewritten };
}

Deno.test("native OCR reconciliation binds duplicate images to proven canonical paths", () => {
  const duplicate = png();
  const other = `${png()}other`;
  const nativeRequest = {
    model: "native/model",
    instructions: "Follow the supplied evidence.",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "First" },
        { type: "input_image", image_url: duplicate, detail: "high" },
        { type: "input_image", image_url: other, detail: "low" },
      ],
    }, {
      type: "reasoning",
      id: "rs_preserved",
      status: "completed",
      summary: [{ type: "summary_text", text: "native-only state" }],
    }, {
      type: "function_call",
      id: "fc_transport",
      call_id: "call_lookup",
      name: "lookup",
      arguments: "{}",
      status: "completed",
    }, {
      type: "function_call_output",
      call_id: "call_lookup",
      output: "result",
    }, {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Second" },
        { type: "input_image", image_url: duplicate, detail: "high" },
      ],
    }],
    max_output_tokens: 8,
    store: false,
  };
  const { original, rewritten } = rewrittenOcrShadow(nativeRequest, [
    "OCR first duplicate",
    "OCR unique",
    "OCR second duplicate",
  ]);
  const reconciled = reconcileNativeResponsesAfterOcr(original, rewritten, {
    request: nativeRequest,
    input: nativeRequest.input,
    requiresNativeInput: true,
    store: false,
  });
  const input = reconciled!.request!.input as Array<Record<string, unknown>>;
  assertEquals(input[0], {
    ...nativeRequest.input[0],
    content: [
      { type: "input_text", text: "First" },
      { type: "input_text", text: "OCR first duplicate" },
      { type: "input_text", text: "OCR unique" },
    ],
  });
  assertEquals(input.slice(1, 4), nativeRequest.input.slice(1, 4));
  assertEquals(input[4], {
    ...nativeRequest.input[4],
    content: [
      { type: "input_text", text: "Second" },
      { type: "input_text", text: "OCR second duplicate" },
    ],
  });
});

Deno.test("native OCR reconciliation rejects reordered, changed-text, and changed-role shadows", () => {
  const duplicate = png();
  const nativeRequest = {
    model: "native/model",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "A" },
        { type: "input_image", image_url: duplicate },
      ],
    }, {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "B" },
        { type: "input_image", image_url: duplicate },
      ],
    }],
  };
  const { original, rewritten } = rewrittenOcrShadow(nativeRequest, ["OCR A", "OCR B"]);
  const rejects = (request: typeof nativeRequest) =>
    assertThrows(
      () =>
        reconcileNativeResponsesAfterOcr(original, rewritten, {
          request,
          input: request.input,
          store: false,
        }),
      ProviderAttemptError,
      "cannot be represented safely",
    );

  const reordered = structuredClone(nativeRequest);
  reordered.input.reverse();
  rejects(reordered);

  const changedText = structuredClone(nativeRequest);
  changedText.input[0].content[0] = { type: "input_text", text: "changed" };
  rejects(changedText);

  const changedRole = structuredClone(nativeRequest);
  changedRole.input[0].role = "assistant";
  rejects(changedRole);
});

Deno.test("native Responses dispatch reconciles OCR text and fails closed on shape mismatch", async () => {
  const repo = new MemoryRepository();
  const user = repo.bootstrapAdmin({
    email: "native-ocr@example.com",
    name: "Native OCR",
    passwordHash: "unused",
  }, 10_000_000);
  const mutation = { actorId: user.id, action: "test.native-ocr" };
  const keyring = new ProviderSecretKeyring({
    primaryKeyId: "test",
    keys: new Map([["test", new Uint8Array(32).fill(7)]]),
  });
  const created = repo.createProvider({
    slug: "native-ocr",
    displayName: "Native OCR",
    baseUrl: "https://native-ocr.example/v1",
    protocol: "responses",
  }, mutation);
  const provider = repo.setProviderCredential(created.id, created.version, {
    envelope: await keyring.encrypt(created.id, created.version + 1, "native-ocr-secret"),
  }, mutation);
  const vision = repo.createProviderModel({
    providerId: provider.id,
    publicModelId: "native-ocr/vision",
    upstreamModelId: "vision-upstream",
    displayName: "OCR vision",
    capabilities: ["chat", "vision"],
    contextWindow: 16_384,
  }, mutation);
  repo.createModelPriceVersion({
    providerModelId: vision.id,
    expectedModelVersion: vision.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 10,
    cachedInputMicrosPerMillion: 10,
    reasoningMicrosPerMillion: 10,
    outputMicrosPerMillion: 10,
    fixedCallMicros: 1,
    source: "test",
  }, mutation);
  const model = repo.createProviderModel({
    providerId: provider.id,
    publicModelId: "native-ocr/chat",
    upstreamModelId: "chat-upstream",
    displayName: "Native OCR chat",
    capabilities: ["chat", "vision"],
    contextWindow: 16_384,
    customParams: {
      ocr: {
        enabled: true,
        providerId: provider.id,
        model: vision.id,
        prompt: "Read the image",
        maxBytes: 1_024,
        maxPixels: 100,
        maxDimension: 10,
        timeoutMs: 1_000,
      },
    },
  }, mutation);
  const price = repo.createModelPriceVersion({
    providerModelId: model.id,
    expectedModelVersion: model.version,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 1_000_000,
    reasoningMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
    fixedCallMicros: 0,
    source: "test",
  }, mutation);
  const imageUrl = png();
  const nativeRequest = {
    model: model.publicModelId,
    input: [{
      type: "reasoning",
      id: "rs_prior",
      summary: [{ type: "summary_text", text: "Preserve this native state" }],
      status: "completed",
    }, {
      type: "message",
      id: "msg_input",
      status: "completed",
      role: "user",
      content: [{ type: "input_text", text: "Read" }, {
        type: "input_image",
        image_url: imageUrl,
      }],
    }],
    max_output_tokens: 8,
    store: false,
  };
  const chatRequest = responsesRequestToChatCompletions(
    nativeRequest,
  ) as unknown as ChatCompletionRequest;
  const dispatched: Record<string, unknown>[] = [];
  const engine = new ProviderExecutionEngine({
    repository: repo,
    keyring,
    circuitBreaker: new MemoryCircuitBreaker(),
    breakerPolicy: {
      failureThreshold: 2,
      failureWindowSeconds: 60,
      openSeconds: 30,
      halfOpenLeaseSeconds: 5,
    },
    ocrRecognize: () => Promise.resolve("invoice total $42"),
    responsesFetch: (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      dispatched.push(body);
      return Promise.resolve(Response.json({
        id: "resp_native_ocr",
        object: "response",
        status: "completed",
        model: "chat-upstream",
        output: [{
          id: "msg_output",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "understood", annotations: [] }],
        }],
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      }));
    },
  });
  const reserve = () =>
    repo.reserve(
      user.id,
      crypto.randomUUID(),
      model.publicModelId,
      1,
      provider.slug,
      undefined,
      {
        pricingVersionId: price.id,
        inputMicrosPerMillion: 1_000_000,
        cachedInputMicrosPerMillion: 1_000_000,
        reasoningMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
        fixedCallMicros: 0,
        source: "test",
      },
    );

  const run = reserve();
  const result = await engine.complete(
    model.id,
    run.id,
    run.runLeaseToken!,
    chatRequest,
    new AbortController().signal,
    undefined,
    user.id,
    {
      request: nativeRequest,
      input: nativeRequest.input,
      requiresNativeInput: true,
      store: false,
    },
  );
  assertEquals(result.text, "understood");
  assertEquals(dispatched.length, 1);
  const dispatchedInput = dispatched[0].input as Array<Record<string, unknown>>;
  assertEquals(dispatchedInput[0], nativeRequest.input[0]);
  assertEquals(dispatchedInput[1], {
    ...nativeRequest.input[1],
    content: [{ type: "input_text", text: "Read" }, {
      type: "input_text",
      text: "[OCR image 2.2]\ninvoice total $42",
    }],
  });
  assertEquals(
    repo.listProviderAttempts(run.id).map((attempt) => ({
      status: attempt.status,
      inputTokens: attempt.inputTokens,
      tokenSource: attempt.tokenSource,
    })),
    [{ status: "succeeded", inputTokens: 8, tokenSource: "provider" }],
  );
  assertEquals(
    repo.ledger.filter((entry) => entry.usageRunId === run.id && entry.kind === "reserve").length,
    2,
  );

  const mismatched = structuredClone(nativeRequest);
  const mismatchedMessage = mismatched.input[1] as {
    content: Array<Record<string, unknown>>;
  };
  mismatchedMessage.content[1].image_url = png() + "mismatch";
  const failedRun = reserve();
  await assertRejects(
    () =>
      engine.complete(
        model.id,
        failedRun.id,
        failedRun.runLeaseToken!,
        chatRequest,
        new AbortController().signal,
        undefined,
        user.id,
        {
          request: mismatched,
          input: mismatched.input,
          requiresNativeInput: true,
          store: false,
        },
      ),
    ProviderAttemptError,
    "cannot be represented safely",
  );
  assertEquals(dispatched.length, 1);
  assertEquals(repo.listProviderAttempts(failedRun.id), []);

  const failedStreamRun = reserve();
  await assertRejects(
    async () => {
      for await (
        const _frame of engine.stream(
          model.id,
          failedStreamRun.id,
          failedStreamRun.runLeaseToken!,
          { ...chatRequest, stream: true },
          new AbortController().signal,
          undefined,
          user.id,
          {
            request: { ...mismatched, stream: true },
            input: mismatched.input,
            requiresNativeInput: true,
            store: false,
          },
        )
      ) {
        // A reconciliation failure must occur before primary or fallback stream dispatch.
      }
    },
    ProviderAttemptError,
    "cannot be represented safely",
  );
  assertEquals(dispatched.length, 1);
  assertEquals(repo.listProviderAttempts(failedStreamRun.id), []);
});
