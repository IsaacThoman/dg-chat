import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { StartupResourceOwner } from "./startup-resources.ts";

Deno.test("startup ownership closes partial acquisitions in reverse order despite close errors", async () => {
  const owner = new StartupResourceOwner();
  const closed: string[] = [];
  owner.defer(() => {
    closed.push("object-store");
  });
  owner.defer(() => {
    closed.push("postgres");
    throw new Error("close failed");
  });
  owner.defer(async () => {
    await Promise.resolve();
    closed.push("redis");
  });

  const errors = await owner.close();
  assertEquals(closed, ["redis", "postgres", "object-store"]);
  assertEquals(errors.length, 1);
  assertEquals(await owner.close(), []);
});

Deno.test("composite ownership replaces partial resource closers without double close", async () => {
  const owner = new StartupResourceOwner();
  const closed: string[] = [];
  const forgetStore = owner.defer(() => {
    closed.push("backup-store");
  });
  const forgetSecrets = owner.defer(() => {
    closed.push("secret-store");
  });
  forgetStore();
  forgetSecrets();
  owner.defer(() => {
    closed.push("backup-admin");
  });

  await owner.close();
  assertEquals(closed, ["backup-admin"]);
});

Deno.test("released startup ownership cannot close live resources or acquire more", async () => {
  const owner = new StartupResourceOwner();
  let closed = false;
  owner.defer(() => {
    closed = true;
  });
  owner.release();

  assertEquals(await owner.close(), []);
  assertEquals(closed, false);
  assertThrows(() => owner.defer(() => undefined), Error, "ownership has ended");
});
