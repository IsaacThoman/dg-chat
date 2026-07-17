import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  ObjectAlreadyExistsError,
  objectStoreConfigFromEnv,
  S3ObjectStore,
} from "./object-store.ts";

Deno.test("object store environment configuration is explicit and validates credentials", () => {
  assertEquals(objectStoreConfigFromEnv({}), undefined);
  assertThrows(
    () => objectStoreConfigFromEnv({ S3_BUCKET: "bucket", S3_ACCESS_KEY: "only-one" }),
    Error,
    "together",
  );
  assertEquals(
    objectStoreConfigFromEnv({
      S3_BUCKET: "dg-chat-files",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: "https://objects.example.test",
      S3_ACCESS_KEY: "scoped-user",
      S3_SECRET_KEY: "scoped-secret",
    }),
    {
      bucket: "dg-chat-files",
      region: "us-east-1",
      endpoint: "https://objects.example.test",
      accessKey: "scoped-user",
      secretKey: "scoped-secret",
      forcePathStyle: true,
    },
  );
});

Deno.test("object store requires HTTPS unless private insecure storage is explicitly enabled", () => {
  const base = { S3_BUCKET: "dg-chat-files" };
  assertThrows(
    () => objectStoreConfigFromEnv({ ...base, S3_ENDPOINT: "http://minio:9000" }),
    Error,
    "S3_ALLOW_INSECURE=true",
  );
  assertThrows(
    () =>
      objectStoreConfigFromEnv({
        ...base,
        S3_ENDPOINT: "http://objects.example.com",
        S3_ALLOW_INSECURE: "true",
      }),
    Error,
    "restricted to loopback, private-network, or container hosts",
  );
  for (
    const endpoint of [
      "http://minio:9000",
      "http://localhost:9000",
      "http://127.0.0.1:9000",
      "http://10.20.30.40:9000",
      "http://172.31.0.2:9000",
      "http://192.168.1.2:9000",
      "http://[::1]:9000",
      "http://[fd00::1]:9000",
    ]
  ) {
    assertEquals(
      objectStoreConfigFromEnv({
        ...base,
        S3_ENDPOINT: endpoint,
        S3_ALLOW_INSECURE: "true",
      })?.endpoint,
      endpoint,
    );
  }
});

Deno.test("S3 object store streams put/get and supports delete/readiness", async () => {
  const commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
  const sendOptions: Array<{ abortSignal?: AbortSignal } | undefined> = [];
  let destroyed = false;
  const client = {
    send(command: unknown, options?: { abortSignal?: AbortSignal }) {
      const value = command as { constructor: { name: string }; input: Record<string, unknown> };
      commands.push(value);
      sendOptions.push(options);
      if (value.constructor.name === "PutObjectCommand") {
        return Promise.resolve({ ETag: "etag-put" });
      }
      if (value.constructor.name === "GetObjectCommand") {
        return Promise.resolve({
          Body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("stored"));
              controller.close();
            },
          }),
          ContentLength: 6,
          ContentType: "text/plain",
          ETag: "etag-get",
          Metadata: { sha256: "a".repeat(64) },
        });
      }
      return Promise.resolve({});
    },
    destroy() {
      destroyed = true;
    },
  };
  const store = new S3ObjectStore({
    bucket: "dg-chat-files",
    region: "us-east-1",
    forcePathStyle: true,
  }, client);
  const uploadController = new AbortController();
  const put = await store.put({
    key: "users/user/files/file.txt",
    body: new Blob(["stored"]).stream(),
    contentLength: 6,
    contentType: "text/plain",
    metadata: { sha256: "a".repeat(64) },
    signal: uploadController.signal,
  });
  assertEquals(put.etag, "etag-put");
  assertEquals(commands[0].input.Bucket, "dg-chat-files");
  assertEquals(commands[0].input.ContentLength, 6);
  assertEquals(commands[0].input.IfNoneMatch, "*");
  assertEquals(sendOptions[0]?.abortSignal, uploadController.signal);
  const found = await store.get("users/user/files/file.txt");
  assertEquals(await new Response(found!.body).text(), "stored");
  assertEquals(found!.contentType, "text/plain");
  await store.delete("users/user/files/file.txt");
  assertEquals(await store.readiness(), true);
  assertEquals(commands.map((command) => command.constructor.name), [
    "PutObjectCommand",
    "GetObjectCommand",
    "DeleteObjectCommand",
    "HeadBucketCommand",
  ]);
  store.close();
  assertEquals(destroyed, true);
  await assertRejects(
    () =>
      store.put({
        key: "../unsafe",
        body: new Blob([]).stream(),
        contentLength: 0,
        contentType: "text/plain",
      }),
    TypeError,
  );
});

Deno.test("S3 object store refuses to overwrite an immutable key", async () => {
  const store = new S3ObjectStore({
    bucket: "dg-chat-files",
    region: "us-east-1",
    forcePathStyle: true,
  }, {
    send() {
      return Promise.reject({ name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    },
  });
  await assertRejects(
    () =>
      store.put({
        key: "users/user/files/existing.txt",
        body: new Blob(["new"]).stream(),
        contentLength: 3,
        contentType: "text/plain",
      }),
    ObjectAlreadyExistsError,
  );
});

Deno.test("S3 object store maps missing keys and readiness failures", async () => {
  const missing = new S3ObjectStore({
    bucket: "dg-chat-files",
    region: "us-east-1",
    forcePathStyle: true,
  }, {
    send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "GetObjectCommand") {
        return Promise.reject({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      }
      return Promise.reject(new Error("offline"));
    },
  });
  assertEquals(await missing.get("users/user/missing.txt"), undefined);
  assertEquals(await missing.readiness(), false);
});

Deno.test("S3 readiness forwards cancellation to the SDK request", async () => {
  let observedSignal: AbortSignal | undefined;
  const store = new S3ObjectStore({
    bucket: "dg-chat-files",
    region: "us-east-1",
    forcePathStyle: true,
  }, {
    send(_command: unknown, options?: { abortSignal?: AbortSignal }) {
      observedSignal = options?.abortSignal;
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => reject(options.abortSignal?.reason),
          { once: true },
        );
      });
    },
  });
  const controller = new AbortController();
  const readiness = store.readiness(controller.signal);
  controller.abort(new DOMException("test deadline", "TimeoutError"));
  assertEquals(await readiness, false);
  assertEquals(observedSignal, controller.signal);
});

Deno.test("S3 get and delete abort active SDK requests", async () => {
  const observed: AbortSignal[] = [];
  const store = new S3ObjectStore({
    bucket: "dg-chat-files",
    region: "us-east-1",
    forcePathStyle: true,
  }, {
    send(_command: unknown, options?: { abortSignal?: AbortSignal }) {
      if (!options?.abortSignal) throw new Error("missing operation signal");
      observed.push(options.abortSignal);
      return new Promise((_resolve, reject) => {
        options.abortSignal!.addEventListener(
          "abort",
          () => reject(options.abortSignal!.reason),
          { once: true },
        );
      });
    },
  });
  for (
    const operation of [
      (signal: AbortSignal) => store.get("users/user/files/file.txt", signal),
      (signal: AbortSignal) => store.delete("users/user/files/file.txt", signal),
    ]
  ) {
    const controller = new AbortController();
    const pending = operation(controller.signal);
    controller.abort(new DOMException("Worker stopping", "AbortError"));
    await assertRejects(() => pending, DOMException, "Worker stopping");
    assertEquals(observed.at(-1), controller.signal);
  }
});
