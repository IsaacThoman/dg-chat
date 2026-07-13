import { assertEquals } from "jsr:@std/assert@1";
import { closeIdentityAwareResources } from "./resource-shutdown.ts";

Deno.test("identity-aware shutdown drains delivery audits before repositories close", async () => {
  const calls: string[] = [];
  let releaseBrowser!: () => void;
  const browserDelivery = new Promise<void>((resolve) => {
    releaseBrowser = resolve;
  });
  let repositoryClosed = false;

  const closing = closeIdentityAwareResources({
    abortDeliveriesAfterMs: 321,
    closeMailer: () => calls.push("mailer"),
    drainLegacyDeliveries: (timeout) => {
      calls.push(`legacy:${timeout}`);
      return Promise.resolve();
    },
    drainBrowserDeliveries: async (timeout) => {
      calls.push(`browser:${timeout}`);
      await browserDelivery;
      calls.push(`browser-audit:${repositoryClosed}`);
    },
    closeResources: [
      () => {
        repositoryClosed = true;
        calls.push("repository");
      },
      () => calls.push("browser-store"),
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(repositoryClosed, false);
  releaseBrowser();
  await closing;
  assertEquals(calls, [
    "legacy:321",
    "browser:321",
    "browser-audit:false",
    "mailer",
    "repository",
    "browser-store",
  ]);
});

Deno.test("identity-aware shutdown continues after an individual close failure", async () => {
  const calls: string[] = [];
  await closeIdentityAwareResources({
    abortDeliveriesAfterMs: 1,
    closeMailer: () => {
      calls.push("mailer");
      throw new Error("socket close failed");
    },
    drainLegacyDeliveries: () => {
      calls.push("drain");
      return Promise.reject(new Error("audit failed"));
    },
    closeResources: [
      () => {
        calls.push("first");
        throw new Error("close failed");
      },
      () => calls.push("second"),
    ],
  });
  assertEquals(calls, ["drain", "mailer", "first", "second"]);
});

Deno.test("identity-aware shutdown closes the transport only after a bounded drain returns", async () => {
  const calls: string[] = [];
  await closeIdentityAwareResources({
    abortDeliveriesAfterMs: 5,
    drainLegacyDeliveries: async (timeout) => {
      calls.push(`drain:${timeout}`);
      await new Promise((resolve) => setTimeout(resolve, timeout));
      calls.push("abandoned");
    },
    closeMailer: () => calls.push("mailer"),
    closeResources: [() => calls.push("repository")],
  });
  assertEquals(calls, ["drain:5", "abandoned", "mailer", "repository"]);
});
