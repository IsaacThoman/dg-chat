import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export interface ObjectStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  forcePathStyle: boolean;
}

export interface PutObjectInput {
  key: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType: string;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

export interface StoredObject {
  key: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
  metadata: Record<string, string>;
}

export interface ObjectStore {
  put(input: PutObjectInput): Promise<{ etag: string | null }>;
  get(key: string): Promise<StoredObject | undefined>;
  delete(key: string): Promise<void>;
  readiness(signal?: AbortSignal): Promise<boolean>;
  close(): void;
}

export class ObjectAlreadyExistsError extends Error {
  constructor(readonly key: string) {
    super("Object already exists");
    this.name = "ObjectAlreadyExistsError";
  }
}

type S3Sender = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<Record<string, unknown>>;
  destroy?(): void;
};

function validKey(key: string) {
  return key.length > 0 && key.length <= 1024 && !key.startsWith("/") &&
    ![...key].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) && !key.split("/").some((part) => part === "" || part === "..");
}

function assertKey(key: string) {
  if (!validKey(key)) throw new TypeError("Object key is invalid");
}

function isPrivateOrContainerHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  // A single-label DNS name is the normal service-discovery address for bundled MinIO and other
  // container orchestrators. It cannot name a public DNS host without a local search domain.
  if (
    !normalized.includes(".") &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)
  ) return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }
  return normalized === "::1" || /^(?:fc|fd)[0-9a-f]{2}:/.test(normalized) ||
    /^fe[89ab][0-9a-f]:/.test(normalized);
}

export function objectStoreConfigFromEnv(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ObjectStoreConfig | undefined {
  const relevant = [
    env.S3_BUCKET,
    env.S3_ENDPOINT,
    env.S3_REGION,
    env.S3_ACCESS_KEY,
    env.S3_SECRET_KEY,
  ];
  if (relevant.every((value) => !value)) return undefined;
  const bucket = env.S3_BUCKET?.trim();
  const region = env.S3_REGION?.trim() || "us-east-1";
  if (
    !bucket || bucket.length < 3 || bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(bucket)
  ) {
    throw new Error("S3_BUCKET is invalid");
  }
  if (!region || region.length > 100) throw new Error("S3_REGION is invalid");
  const accessKey = env.S3_ACCESS_KEY?.trim() || undefined;
  const secretKey = env.S3_SECRET_KEY || undefined;
  if (Boolean(accessKey) !== Boolean(secretKey)) {
    throw new Error("S3_ACCESS_KEY and S3_SECRET_KEY must be configured together");
  }
  let endpoint: string | undefined;
  if (env.S3_ENDPOINT?.trim()) {
    let url: URL;
    try {
      url = new URL(env.S3_ENDPOINT);
    } catch {
      throw new Error("S3_ENDPOINT is invalid");
    }
    if (
      !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search ||
      url.hash
    ) {
      throw new Error("S3_ENDPOINT is invalid");
    }
    if (url.protocol === "http:") {
      if (env.S3_ALLOW_INSECURE !== "true") {
        throw new Error(
          "S3_ENDPOINT must use HTTPS unless S3_ALLOW_INSECURE=true is explicitly configured",
        );
      }
      if (!isPrivateOrContainerHostname(url.hostname)) {
        throw new Error(
          "Insecure S3 endpoints are restricted to loopback, private-network, or container hosts",
        );
      }
    }
    endpoint = url.toString().replace(/\/$/, "");
  }
  return {
    bucket,
    region,
    endpoint,
    accessKey,
    secretKey,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === undefined
      ? Boolean(endpoint)
      : env.S3_FORCE_PATH_STYLE === "true",
  };
}

function webBody(body: unknown): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (
    body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function"
  ) {
    return (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
  }
  if (body instanceof Readable) {
    return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  }
  throw new Error("Object storage returned an unsupported response body");
}

/** Streaming S3 adapter compatible with AWS S3 and path-style MinIO deployments. */
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Sender;
  readonly #bucket: string;

  constructor(config: ObjectStoreConfig, client?: S3Sender) {
    this.#bucket = config.bucket;
    this.#client = client ?? new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: config.accessKey && config.secretKey
        ? { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }
        : undefined,
    }) as unknown as S3Sender;
  }

  async put(input: PutObjectInput) {
    assertKey(input.key);
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0) {
      throw new TypeError("Object content length is invalid");
    }
    if (!input.contentType || input.contentType.length > 255) {
      throw new TypeError("Object content type is invalid");
    }
    try {
      const response = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: input.key,
          Body: Readable.fromWeb(input.body as never),
          ContentLength: input.contentLength,
          ContentType: input.contentType,
          Metadata: input.metadata,
          IfNoneMatch: "*",
        }),
        input.signal ? { abortSignal: input.signal } : undefined,
      );
      return { etag: typeof response.ETag === "string" ? response.ETag : null };
    } catch (error) {
      const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412) {
        throw new ObjectAlreadyExistsError(input.key);
      }
      throw error;
    }
  }

  async get(key: string): Promise<StoredObject | undefined> {
    assertKey(key);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return {
        key,
        body: webBody(response.Body),
        contentLength: typeof response.ContentLength === "number" ? response.ContentLength : null,
        contentType: typeof response.ContentType === "string" ? response.ContentType : null,
        etag: typeof response.ETag === "string" ? response.ETag : null,
        metadata: response.Metadata && typeof response.Metadata === "object"
          ? response.Metadata as Record<string, string>
          : {},
      };
    } catch (error) {
      const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        candidate.name === "NoSuchKey" || candidate.name === "NotFound" ||
        candidate.$metadata?.httpStatusCode === 404
      ) return undefined;
      throw error;
    }
  }

  async delete(key: string) {
    assertKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async readiness(signal?: AbortSignal) {
    try {
      await this.#client.send(
        new HeadBucketCommand({ Bucket: this.#bucket }),
        signal ? { abortSignal: signal } : undefined,
      );
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.#client.destroy?.();
  }
}

export function objectStoreFromEnv(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): S3ObjectStore | undefined {
  const config = objectStoreConfigFromEnv(env);
  return config ? new S3ObjectStore(config) : undefined;
}
