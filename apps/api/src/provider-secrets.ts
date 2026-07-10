const encoder = new TextEncoder();

export interface ProviderSecretEnvelope {
  version: 1;
  algorithm: "AES-256-GCM";
  keyId: string;
  credentialVersion: number;
  wrappedKeyNonce: string;
  wrappedKey: string;
  contentNonce: string;
  ciphertext: string;
}

export interface ProviderSecretKeyringOptions {
  primaryKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Provider encryption keys must be valid base64");
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function aad(providerId: string, credentialVersion: number, purpose: "wrap" | "content") {
  return encoder.encode(
    `dg-chat:provider-secret:v1:${providerId}:${credentialVersion}:${purpose}`,
  );
}

function validateProviderId(providerId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(providerId)
  ) {
    throw new TypeError("Provider ID must be a UUID");
  }
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]) {
  return await crypto.subtle.importKey("raw", buffer(bytes), "AES-GCM", false, usages);
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function nonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

export class ProviderSecretKeyring {
  readonly #primaryKeyId: string;
  readonly #keys: ReadonlyMap<string, Uint8Array>;

  constructor(options: ProviderSecretKeyringOptions) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.primaryKeyId)) {
      throw new Error("Provider encryption primary key ID is invalid");
    }
    if (!options.keys.has(options.primaryKeyId) || options.keys.size === 0) {
      throw new Error("Provider encryption primary key is missing from the keyring");
    }
    const copied = new Map<string, Uint8Array>();
    for (const [id, bytes] of options.keys) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || bytes.byteLength !== 32) {
        throw new Error("Every provider encryption key must have a valid ID and 32 bytes");
      }
      copied.set(id, bytes.slice());
    }
    this.#primaryKeyId = options.primaryKeyId;
    this.#keys = copied;
  }

  static fromEnv(): ProviderSecretKeyring | undefined {
    const serialized = Deno.env.get("ENCRYPTION_KEYRING");
    if (serialized) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw new Error("ENCRYPTION_KEYRING must be a JSON object of key IDs to base64 keys");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("ENCRYPTION_KEYRING must be a JSON object of key IDs to base64 keys");
      }
      const keys = new Map(
        Object.entries(parsed).map(([id, value]) => {
          if (typeof value !== "string") {
            throw new Error("ENCRYPTION_KEYRING values must be strings");
          }
          return [id, decodeBase64(value)] as const;
        }),
      );
      const primaryKeyId = Deno.env.get("ENCRYPTION_PRIMARY_KEY_ID");
      if (!primaryKeyId) {
        throw new Error("ENCRYPTION_PRIMARY_KEY_ID is required with ENCRYPTION_KEYRING");
      }
      return new ProviderSecretKeyring({ primaryKeyId, keys });
    }
    const legacy = Deno.env.get("ENCRYPTION_KEY");
    return legacy
      ? new ProviderSecretKeyring({
        primaryKeyId: "default",
        keys: new Map([["default", decodeBase64(legacy)]]),
      })
      : undefined;
  }

  async encrypt(
    providerId: string,
    credentialVersion: number,
    secret: string,
  ): Promise<ProviderSecretEnvelope> {
    validateProviderId(providerId);
    if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
      throw new TypeError("Credential version must be a positive integer");
    }
    if (!secret || secret.length > 32_768) throw new TypeError("Provider credential is invalid");
    const kekBytes = this.#keys.get(this.#primaryKeyId)!;
    const dekBytes = crypto.getRandomValues(new Uint8Array(32));
    const secretBytes = encoder.encode(secret);
    const wrapNonce = nonce();
    const contentNonce = nonce();
    try {
      const [kek, dek] = await Promise.all([
        importAesKey(kekBytes, ["encrypt"]),
        importAesKey(dekBytes, ["encrypt"]),
      ]);
      const [wrappedKey, ciphertext] = await Promise.all([
        crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: buffer(wrapNonce),
            additionalData: buffer(aad(providerId, credentialVersion, "wrap")),
          },
          kek,
          buffer(dekBytes),
        ),
        crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: buffer(contentNonce),
            additionalData: buffer(aad(providerId, credentialVersion, "content")),
          },
          dek,
          buffer(secretBytes),
        ),
      ]);
      return {
        version: 1,
        algorithm: "AES-256-GCM",
        keyId: this.#primaryKeyId,
        credentialVersion,
        wrappedKeyNonce: encodeBase64(wrapNonce),
        wrappedKey: encodeBase64(new Uint8Array(wrappedKey)),
        contentNonce: encodeBase64(contentNonce),
        ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      };
    } finally {
      dekBytes.fill(0);
      secretBytes.fill(0);
    }
  }

  async decrypt(providerId: string, envelope: ProviderSecretEnvelope): Promise<string> {
    validateProviderId(providerId);
    if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
      throw new Error("Unsupported provider credential envelope");
    }
    const kekBytes = this.#keys.get(envelope.keyId);
    if (!kekBytes) throw new Error("Provider credential key is unavailable");
    const wrappedKeyNonce = decodeBase64(envelope.wrappedKeyNonce);
    const contentNonce = decodeBase64(envelope.contentNonce);
    if (wrappedKeyNonce.byteLength !== 12 || contentNonce.byteLength !== 12) {
      throw new Error("Provider credential envelope is invalid");
    }
    let dekBytes: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    try {
      const kek = await importAesKey(kekBytes, ["decrypt"]);
      dekBytes = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: buffer(wrappedKeyNonce),
            additionalData: buffer(aad(providerId, envelope.credentialVersion, "wrap")),
          },
          kek,
          buffer(decodeBase64(envelope.wrappedKey)),
        ),
      );
      if (dekBytes.byteLength !== 32) throw new Error("Provider credential envelope is invalid");
      const dek = await importAesKey(dekBytes, ["decrypt"]);
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: buffer(contentNonce),
            additionalData: buffer(aad(providerId, envelope.credentialVersion, "content")),
          },
          dek,
          buffer(decodeBase64(envelope.ciphertext)),
        ),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new Error("Provider credential could not be decrypted");
    } finally {
      dekBytes?.fill(0);
      plaintext?.fill(0);
    }
  }

  async rewrap(
    providerId: string,
    envelope: ProviderSecretEnvelope,
  ): Promise<ProviderSecretEnvelope> {
    validateProviderId(providerId);
    if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
      throw new Error("Unsupported provider credential envelope");
    }
    if (envelope.keyId === this.#primaryKeyId) return structuredClone(envelope);
    const oldKekBytes = this.#keys.get(envelope.keyId);
    if (!oldKekBytes) throw new Error("Provider credential key is unavailable");
    const wrapNonce = decodeBase64(envelope.wrappedKeyNonce);
    if (wrapNonce.byteLength !== 12) throw new Error("Provider credential envelope is invalid");
    let dekBytes: Uint8Array | undefined;
    try {
      const oldKek = await importAesKey(oldKekBytes, ["decrypt"]);
      dekBytes = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: buffer(wrapNonce),
            additionalData: buffer(aad(providerId, envelope.credentialVersion, "wrap")),
          },
          oldKek,
          buffer(decodeBase64(envelope.wrappedKey)),
        ),
      );
      if (dekBytes.byteLength !== 32) throw new Error("Provider credential envelope is invalid");
      const nextNonce = nonce();
      const nextKek = await importAesKey(this.#keys.get(this.#primaryKeyId)!, ["encrypt"]);
      const wrappedKey = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: buffer(nextNonce),
          additionalData: buffer(aad(providerId, envelope.credentialVersion, "wrap")),
        },
        nextKek,
        buffer(dekBytes),
      );
      return {
        ...envelope,
        keyId: this.#primaryKeyId,
        wrappedKeyNonce: encodeBase64(nextNonce),
        wrappedKey: encodeBase64(new Uint8Array(wrappedKey)),
      };
    } catch {
      throw new Error("Provider credential could not be rewrapped");
    } finally {
      dekBytes?.fill(0);
    }
  }
}
