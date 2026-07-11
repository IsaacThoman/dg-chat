import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import { ProviderSecretKeyring } from "./provider-secrets.ts";

const providerId = "11111111-1111-4111-8111-111111111111";
const key = (fill: number) => new Uint8Array(32).fill(fill);

Deno.test("provider credentials use randomized envelope encryption and decrypt through key rotation", async () => {
  const oldRing = new ProviderSecretKeyring({
    primaryKeyId: "old",
    keys: new Map([["old", key(1)]]),
  });
  const first = await oldRing.encrypt(providerId, 1, "canary-provider-secret");
  const second = await oldRing.encrypt(providerId, 1, "canary-provider-secret");
  assertNotEquals(first.ciphertext, second.ciphertext);
  assertNotEquals(first.wrappedKey, second.wrappedKey);
  assertEquals(await oldRing.decrypt(providerId, first), "canary-provider-secret");

  const rollingRing = new ProviderSecretKeyring({
    primaryKeyId: "new",
    keys: new Map([["old", key(1)], ["new", key(2)]]),
  });
  assertEquals(await rollingRing.decrypt(providerId, first), "canary-provider-secret");
  assertEquals((await rollingRing.encrypt(providerId, 2, "replacement")).keyId, "new");
  const rewrapped = await rollingRing.rewrap(providerId, first);
  assertEquals(rewrapped.keyId, "new");
  assertEquals(rewrapped.ciphertext, first.ciphertext);
  assertEquals(rewrapped.contentNonce, first.contentNonce);
  assertNotEquals(rewrapped.wrappedKey, first.wrappedKey);
  assertEquals(await rollingRing.decrypt(providerId, rewrapped), "canary-provider-secret");
});

Deno.test("provider credential envelopes are bound to provider, version, and ciphertext", async () => {
  const ring = new ProviderSecretKeyring({
    primaryKeyId: "primary",
    keys: new Map([["primary", key(3)]]),
  });
  const envelope = await ring.encrypt(providerId, 7, "canary-provider-secret");
  await assertRejects(
    () => ring.decrypt("22222222-2222-4222-8222-222222222222", envelope),
    Error,
    "could not be decrypted",
  );
  await assertRejects(
    () => ring.decrypt(providerId, { ...envelope, credentialVersion: 8 }),
    Error,
    "could not be decrypted",
  );
  const bytes = Uint8Array.from(atob(envelope.ciphertext), (value) => value.charCodeAt(0));
  bytes[0] ^= 1;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  await assertRejects(
    () => ring.decrypt(providerId, { ...envelope, ciphertext: btoa(binary) }),
    Error,
    "could not be decrypted",
  );
});

Deno.test("provider keyring rejects invalid and missing primary keys", () => {
  assertThrows(
    () => new ProviderSecretKeyring({ primaryKeyId: "missing", keys: new Map() }),
    Error,
    "missing",
  );
  assertThrows(
    () =>
      new ProviderSecretKeyring({
        primaryKeyId: "short",
        keys: new Map([["short", new Uint8Array(16)]]),
      }),
    Error,
    "32 bytes",
  );
});
