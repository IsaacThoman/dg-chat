import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  providerModelRouteSet,
  providerRetryPolicyCreate,
  providerRetryPolicyPatch,
} from "./provider-resilience-validation.ts";

const source = "11111111-1111-4111-8111-111111111111";
const fallback = "22222222-2222-4222-8222-222222222222";
const policyId = "33333333-3333-4333-8333-333333333333";
const policy = {
  name: "Default resilience",
  enabled: true,
  maxAttempts: 3,
  maxRetries: 1,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  backoffMultiplierBps: 20_000,
  jitterBps: 2_000,
  firstTokenTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  retryableStatuses: [503, 429, 408],
};

Deno.test("retry policy validation normalizes safe bounded values", () => {
  assertEquals(providerRetryPolicyCreate(policy), {
    ...policy,
    name: "Default resilience",
    retryableStatuses: [408, 429, 503],
  });
  assertEquals(providerRetryPolicyPatch({ expectedVersion: 2, maxAttempts: 4 }), {
    expectedVersion: 2,
    changes: { maxAttempts: 4 },
  });
});

Deno.test("retry policy validation rejects unsafe retries and inconsistent delays", () => {
  assertThrows(() => providerRetryPolicyCreate({ ...policy, retryableStatuses: [401] }));
  assertThrows(() => providerRetryPolicyCreate({ ...policy, maxAttempts: 9 }));
  assertThrows(() => providerRetryPolicyCreate({ ...policy, maxAttempts: 1, maxRetries: 1 }));
  assertThrows(() => providerRetryPolicyCreate({ ...policy, maxDelayMs: 100 }));
  assertThrows(() => providerRetryPolicyPatch({ expectedVersion: 1 }));
  assertThrows(() => providerRetryPolicyPatch({ expectedVersion: 1, unknown: true }));
});

Deno.test("route validation normalizes IDs and rejects duplicate/self targets", () => {
  assertEquals(
    providerModelRouteSet({
      sourceModelId: source.toUpperCase(),
      expectedVersion: 0,
      retryPolicyId: policyId,
      fallbackModelIds: [fallback.toUpperCase()],
    }),
    {
      sourceModelId: source,
      expectedVersion: 0,
      retryPolicyId: policyId,
      fallbackModelIds: [fallback],
    },
  );
  assertThrows(() =>
    providerModelRouteSet({
      sourceModelId: source,
      expectedVersion: 1,
      fallbackModelIds: [fallback, fallback],
    })
  );
  assertThrows(() =>
    providerModelRouteSet({
      sourceModelId: source,
      expectedVersion: 1,
      fallbackModelIds: [source],
    })
  );
});
