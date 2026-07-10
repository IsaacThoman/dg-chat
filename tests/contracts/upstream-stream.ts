const apiKey = Deno.env.get("OPENAI_API_KEY");
const baseURL = Deno.env.get("OPENAI_BASE_URL") ?? "http://localhost:8000/v1";
const sessionCookie = Deno.env.get("CONTRACT_SESSION_COOKIE");
if (!apiKey) throw new Error("OPENAI_API_KEY is required");
if (!sessionCookie) throw new Error("CONTRACT_SESSION_COOKIE is required");
const cookie = sessionCookie;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function completion(
  model: string,
  prompt: string,
  idempotencyKey = `contract-${model}-${crypto.randomUUID()}`,
): Promise<Response> {
  return await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      model: `openai/${model}`,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
}

async function usage(): Promise<{ calls: number; balanceMicros: number }> {
  const response = await fetch(`${new URL(baseURL).origin}/api/usage`, {
    headers: { cookie },
  });
  assert(response.ok, `Usage returned HTTP ${response.status}`);
  return await response.json() as { calls: number; balanceMicros: number };
}

const split = await completion("mock-split", "Raw split streaming contract");
assert(split.ok, `Split upstream stream returned HTTP ${split.status}`);
assert(
  split.headers.get("content-type")?.startsWith("text/event-stream"),
  "Split upstream response was not SSE",
);
const splitWire = await split.text();
assert(splitWire.includes("Mock response: Raw split streaming contract"), "Split content was lost");
assert(
  (splitWire.match(/data: \[DONE\]/g) ?? []).length === 1,
  "Downstream stream must contain exactly one terminal [DONE] event",
);
assert(splitWire.includes('"prompt_tokens":8'), "Provider-reported usage was not preserved");

const usageBeforeFailure = await usage();
const failureKey = `contract-mock-error-${crypto.randomUUID()}`;
const failed = await completion("mock-error", "Structured provider failure", failureKey);
const failureWire = await failed.text();
const expectedFailure =
  'data: {"error":{"message":"Provider stream failed","type":"invalid_request_error","param":null,"code":"provider_error"}}\n\n';
assert(failed.status === 200, `Provider stream failure returned HTTP ${failed.status}`);
assert(
  failed.headers.get("content-type")?.startsWith("text/event-stream"),
  "Provider stream failure was not returned as SSE",
);
assert(
  failureWire === expectedFailure,
  "Provider stream failure did not return the exact error SSE",
);
const failureReplay = await completion("mock-error", "Structured provider failure", failureKey);
assert(failureReplay.headers.get("x-idempotent-replay") === "true", "Failure was not replayed");
assert(await failureReplay.text() === failureWire, "Failure replay changed the original SSE bytes");
const usageAfterFailure = await usage();
assert(
  usageAfterFailure.calls === usageBeforeFailure.calls,
  "Failed request was counted as a call",
);
assert(
  usageAfterFailure.balanceMicros === usageBeforeFailure.balanceMicros,
  "Failed request did not refund its full reservation",
);

const stalled = await completion("mock-role-stall", "Cancel after the role chunk");
assert(stalled.ok, `Role-stall upstream stream returned HTTP ${stalled.status}`);
const reader = stalled.body?.getReader();
assert(reader, "Role-stall response did not have a body");
const first = await reader.read();
assert(!first.done && first.value.length > 0, "Role-stall stream did not emit its role chunk");
await reader.cancel("contract client disconnected");

console.log("Raw upstream streaming and cancellation contracts passed");
