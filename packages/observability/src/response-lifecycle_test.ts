import { assertEquals } from "jsr:@std/assert@1.0.16";
import { observeResponseLifecycle } from "./response-lifecycle.ts";

Deno.test("response lifecycle observers cannot alter response delivery", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("preserved"));
      controller.close();
    },
  });
  const response = observeResponseLifecycle(
    new Response(source, {
      status: 202,
      headers: { "X-Lifecycle-Test": "preserved" },
    }),
    true,
    () => {
      throw new Error("observer failure");
    },
  );

  assertEquals(response.status, 202);
  assertEquals(response.headers.get("X-Lifecycle-Test"), "preserved");
  assertEquals(await response.text(), "preserved");
  assertEquals(source.locked, false);

  const headSource = new ReadableStream<Uint8Array>();
  const head = observeResponseLifecycle(
    new Response(headSource, { status: 200 }),
    false,
    () => {
      throw new Error("observer failure");
    },
  );
  assertEquals(head.status, 200);
  assertEquals(head.body, null);
});
