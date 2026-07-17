import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  abortableDelay,
  consumeLiveSse,
  derivedTimeoutSignal,
  percentile,
  retentionScrubRequest,
} from "./runtime.ts";

Deno.test("retention load requests preserve the exact server-issued preview fence", () => {
  const preview = {
    policyVersion: 4,
    requestCutoffAt: "2026-06-17T12:34:56.789Z",
    responseCutoffAt: "2026-04-18T12:34:56.789Z",
  };
  assertEquals(retentionScrubRequest(preview, "load-retention-1"), {
    expectedPolicyVersion: 4,
    idempotencyKey: "load-retention-1",
    requestCutoffAt: preview.requestCutoffAt,
    responseCutoffAt: preview.responseCutoffAt,
  });
  assertThrows(
    () =>
      retentionScrubRequest(
        { ...preview, requestCutoffAt: "one day ago" },
        "load-retention-2",
      ),
    TypeError,
    "preview fence is invalid",
  );
});

Deno.test("derived timeout propagates parent cancellation and disposes its timer", async () => {
  const parent = new AbortController();
  const child = derivedTimeoutSignal(parent.signal, 60_000, "test");
  parent.abort(new Error("parent stopped"));
  await assertRejects(() => abortableDelay(1_000, child.signal), Error, "parent stopped");
  child.dispose();
});

Deno.test("live SSE consumer timestamps frames and supports intentional disconnect", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('event: start\ndata: {"type":"start"}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.enqueue(encoder.encode('data: {"type":"delta"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"terminal"}\n\n'));
      controller.close();
    },
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const result = await consumeLiveSse(response, {
    signal: new AbortController().signal,
    startedAtMs: performance.now(),
    headerAtMs: 0,
    disconnectAfterDataFrames: 2,
  });
  assertEquals(result.disconnected, true);
  assertEquals(result.frames.map((frame) => frame.json?.type), ["start", "delta"]);
  assertEquals(result.frames[1].atMs >= result.frames[0].atMs, true);
});

Deno.test("percentile uses a bounded nearest-rank calculation", () => {
  assertEquals(percentile([9, 1, 5, 3], 0.95), 9);
  assertEquals(percentile([9, 1, 5, 3], 0.5), 3);
});
