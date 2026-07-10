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
      S3_ENDPOINT: "http://minio:9000",
      S3_ACCESS_KEY: "scoped-user",
      S3_SECRET_KEY: "scoped-secret",
    }),
    {
      bucket: "dg-chat-files",
      region: "us-east-1",
      endpoint: "http://minio:9000",
      accessKey: "scoped-user",
      secretKey: "scoped-secret",
      forcePathStyle: true,
    },
  );
});

Deno.test("S3 object store streams put/get and supports delete/readiness", async () => {
  const commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
  let destroyed = false;
  const client = {
    send(command: unknown) {
      const value = command as { constructor: { name: string }; input: Record<string, unknown> };
      commands.push(value);
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
  const put = await store.put({
    key: "users/user/files/file.txt",
    body: new Blob(["stored"]).stream(),
    contentLength: 6,
    contentType: "text/plain",
    metadata: { sha256: "a".repeat(64) },
  });
  assertEquals(put.etag, "etag-put");
  assertEquals(commands[0].input.Bucket, "dg-chat-files");
  assertEquals(commands[0].input.ContentLength, 6);
  assertEquals(commands[0].input.IfNoneMatch, "*");
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
