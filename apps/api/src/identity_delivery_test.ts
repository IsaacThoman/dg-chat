import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  boundedIdentityDelivery,
  drainIdentityDeliverySet,
  IdentityDeliveryTimeoutError,
} from "./identity-delivery.ts";

Deno.test("identity delivery times out without waiting for an uncooperative callback", async () => {
  const controller = new AbortController();
  let observedAbort = false;
  await assertRejects(
    () =>
      boundedIdentityDelivery(
        (signal) => {
          signal.addEventListener("abort", () => observedAbort = true, { once: true });
          return new Promise(() => {});
        },
        controller,
        5,
      ),
    IdentityDeliveryTimeoutError,
  );
  assertEquals(observedAbort, true);
});

Deno.test("identity delivery drain aborts tracked callbacks at its deadline", async () => {
  const controller = new AbortController();
  const pending = boundedIdentityDelivery(
    () => new Promise(() => {}),
    controller,
    60_000,
  );
  const deliveries = new Map([[pending, controller]]);
  const started = performance.now();
  assertEquals(await drainIdentityDeliverySet(deliveries, 5), "abandoned");
  assertEquals(controller.signal.aborted, true);
  assertEquals(performance.now() - started < 1_000, true);
  await assertRejects(() => pending, IdentityDeliveryTimeoutError);
});

Deno.test("identity delivery drain returns when tracked audit persistence stalls", async () => {
  const controller = new AbortController();
  const pending = new Promise<void>(() => {});
  const deliveries = new Map([[pending, controller]]);
  const started = performance.now();
  assertEquals(await drainIdentityDeliverySet(deliveries, 5), "abandoned");
  assertEquals(controller.signal.aborted, true);
  assertEquals(performance.now() - started < 1_000, true);
  assertEquals(deliveries.size, 0);
  assertEquals(await drainIdentityDeliverySet(deliveries), "settled");
});
