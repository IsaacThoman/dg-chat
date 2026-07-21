import { assertEquals } from "jsr:@std/assert@1.0.14";
import { publicProviderFailure } from "./app.ts";
import { ProviderAttemptError, ResilienceExhaustedError } from "./provider-resilience.ts";

Deno.test("candidate-local exhaustion exposes only the open viable fallback", () => {
  const failure = publicProviderFailure(
    new ResilienceExhaustedError("exhausted", 1, undefined, 5_000),
  );
  assertEquals(failure, {
    status: 503,
    code: "provider_error",
    message: "Provider request failed",
    retryAfterMs: 5_000,
    param: null,
    type: "server_error",
  });
});

Deno.test("public failure category and delay come from the same eligible candidate", () => {
  const representative = new ProviderAttemptError("untrusted primary payload", {
    status: 429,
    retryAfterMs: 1_000,
  });
  const failure = publicProviderFailure(
    new ResilienceExhaustedError("exhausted", 2, representative, 7_000),
  );
  assertEquals(failure, {
    status: 429,
    code: "rate_limit_exceeded",
    message: "The provider rate limit was exceeded",
    retryAfterMs: 7_000,
    param: null,
    type: "rate_limit_error",
  });
});

Deno.test("public provider failures expose only bounded safe request parameter paths", () => {
  const safe = publicProviderFailure(
    new ProviderAttemptError("private detail", {
      category: "invalid_request",
      param: "request.input[0].content[2].type",
    }),
  );
  assertEquals(safe.param, "request.input[0].content[2].type");

  const hostile = publicProviderFailure(
    new ProviderAttemptError("private detail", {
      category: "invalid_request",
      param: "request.input[0]\r\nx-secret: leaked",
    }),
  );
  assertEquals(hostile.param, null);

  const oversized = publicProviderFailure(
    new ProviderAttemptError("private detail", {
      category: "invalid_request",
      param: `request.${"x".repeat(300)}`,
    }),
  );
  assertEquals(oversized.param, null);
});
