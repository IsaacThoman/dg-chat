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
  await assertRejects(
    () => ring.decryptBytes(providerId, { ...envelope, keyId: "x".repeat(65) }),
    Error,
    "envelope is invalid",
  );
  await assertRejects(
    () => ring.rewrap(providerId, { ...envelope, keyId: "invalid/key" }),
    Error,
    "envelope is invalid",
  );
});

Deno.test("provider credential byte APIs round trip binary data without mutating the caller", async () => {
  const ring = new ProviderSecretKeyring({
    primaryKeyId: "primary",
    keys: new Map([["primary", key(4)]]),
  });
  const secret = new Uint8Array([0, 255, 1, 128, 42]);
  const original = secret.slice();
  const envelope = await ring.encryptBytes(providerId, 3, secret);
  assertEquals(secret, original);
  assertEquals(await ring.decryptBytes(providerId, envelope), original);
});

Deno.test("provider credential byte APIs decrypt old keys after rotation", async () => {
  const oldRing = new ProviderSecretKeyring({
    primaryKeyId: "old",
    keys: new Map([["old", key(5)]]),
  });
  const envelope = await oldRing.encryptBytes(providerId, 1, new Uint8Array([1, 2, 3]));
  const rollingRing = new ProviderSecretKeyring({
    primaryKeyId: "new",
    keys: new Map([["old", key(5)], ["new", key(6)]]),
  });
  assertEquals(await rollingRing.decryptBytes(providerId, envelope), new Uint8Array([1, 2, 3]));
});

Deno.test("provider credential string wrapper rejects invalid UTF-8", async () => {
  const ring = new ProviderSecretKeyring({
    primaryKeyId: "primary",
    keys: new Map([["primary", key(7)]]),
  });
  const envelope = await ring.encryptBytes(providerId, 1, new Uint8Array([0xc3, 0x28]));
  assertEquals(await ring.decryptBytes(providerId, envelope), new Uint8Array([0xc3, 0x28]));
  await assertRejects(
    () => ring.decrypt(providerId, envelope),
    Error,
    "could not be decrypted",
  );
});

Deno.test("provider credential byte APIs enforce plaintext bounds", async () => {
  const ring = new ProviderSecretKeyring({
    primaryKeyId: "primary",
    keys: new Map([["primary", key(8)]]),
  });
  await assertRejects(
    () => ring.encryptBytes(providerId, 1, new Uint8Array()),
    TypeError,
    "invalid",
  );
  await assertRejects(
    () => ring.encryptBytes(providerId, 1, new Uint8Array(32_769)),
    TypeError,
    "invalid",
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
