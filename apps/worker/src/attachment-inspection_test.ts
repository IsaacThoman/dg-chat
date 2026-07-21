import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AttachmentRecord, DomainRepository, StoredObject } from "@dg-chat/database";
import {
  ATTACHMENT_INSPECTION_POLICY_VERSION,
  ATTACHMENT_INSPECTION_REASON,
  DomainError,
} from "@dg-chat/database";
import {
  inspectAttachmentLocally,
  parseAttachmentInspectionPayload,
  processAttachmentInspection,
} from "./attachment-inspection.ts";

Deno.test("attachment inspection payload binds ownership and epoch", () => {
  assertEquals(
    parseAttachmentInspectionPayload({
      attachmentId: "file",
      ownerId: "owner",
      inspectionEpoch: 3,
      requiredInspectionMode: "local",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    }),
    {
      attachmentId: "file",
      ownerId: "owner",
      inspectionEpoch: 3,
      requiredInspectionMode: "local",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    },
  );
  assertThrows(() => parseAttachmentInspectionPayload(null));
  assertThrows(() => parseAttachmentInspectionPayload({ attachmentId: "file" }));
  assertThrows(() =>
    parseAttachmentInspectionPayload({
      attachmentId: "file",
      ownerId: "owner",
      inspectionEpoch: 0,
      requiredInspectionMode: "local",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    })
  );
  assertThrows(() =>
    parseAttachmentInspectionPayload({
      attachmentId: "file",
      ownerId: "owner",
      inspectionEpoch: 1,
      requiredInspectionMode: "unknown",
      inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    })
  );
  assertThrows(() =>
    parseAttachmentInspectionPayload({
      attachmentId: "file",
      ownerId: "owner",
      inspectionEpoch: 1,
      requiredInspectionMode: "external",
      inspectionPolicyVersion: "unknown-policy",
    })
  );
});

const bytes = (value: string) => new TextEncoder().encode(value);
const publicDns = (_hostname: string, type: "A" | "AAAA") =>
  Promise.resolve(type === "A" ? ["93.184.216.34"] : []);
async function digest(value: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", value.slice().buffer as ArrayBuffer),
    ),
  ]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}
function stored(value: Uint8Array, metadata: Record<string, string> = {}): StoredObject {
  return {
    key: "files/object",
    body: new ReadableStream({
      start(controller) {
        const split = Math.floor(value.length / 2);
        controller.enqueue(value.slice(0, split));
        controller.enqueue(value.slice(split));
        controller.close();
      },
    }),
    contentLength: value.length,
    contentType: "text/plain",
    etag: null,
    metadata,
  };
}
async function fixture(content = "hello") {
  const value = bytes(content);
  const attachment: AttachmentRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    ownerId: "00000000-0000-4000-8000-000000000002",
    objectKey: "files/object",
    filename: "note.txt",
    mimeType: "text/plain",
    sizeBytes: value.length,
    sha256: await digest(value),
    state: "pending",
    inspectionError: null,
    requiredInspectionMode: "local",
    inspectionPolicyVersion: ATTACHMENT_INSPECTION_POLICY_VERSION,
    inspectionEpoch: 2,
    version: 2,
    ingestionStatus: "not_applicable",
    ingestionError: null,
    ingestedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    deletedAt: null,
  };
  return { value, attachment };
}
function inspectionPayload(
  source: Awaited<ReturnType<typeof fixture>>,
  inspectionEpoch = source.attachment.inspectionEpoch,
) {
  return {
    attachmentId: source.attachment.id,
    ownerId: source.attachment.ownerId,
    inspectionEpoch,
    requiredInspectionMode: source.attachment.requiredInspectionMode,
    inspectionPolicyVersion: source.attachment.inspectionPolicyVersion,
  };
}
function storedFor(value: Awaited<ReturnType<typeof fixture>>): StoredObject {
  return stored(value.value, {
    owner: value.attachment.ownerId,
    sha256: value.attachment.sha256,
  });
}

function fakeRepository(initial: AttachmentRecord) {
  let record = structuredClone(initial);
  const transitions: string[] = [];
  const repository = {
    getAttachment(id: string, ownerId: string) {
      if (id !== record.id || ownerId !== record.ownerId) {
        throw new DomainError("not_found", "Attachment not found", 404);
      }
      return structuredClone(record);
    },
    transitionAttachmentInspection(input: {
      attachmentId: string;
      ownerId: string;
      inspectionEpoch: number;
      requiredInspectionMode: "local" | "external";
      inspectionPolicyVersion: typeof ATTACHMENT_INSPECTION_POLICY_VERSION;
      expectedState: "pending" | "inspecting";
      nextState: "inspecting" | "ready" | "quarantined" | "failed";
      inspectionError?: string | null;
    }) {
      if (
        input.attachmentId !== record.id || input.ownerId !== record.ownerId ||
        input.inspectionEpoch !== record.inspectionEpoch ||
        input.requiredInspectionMode !== record.requiredInspectionMode ||
        input.inspectionPolicyVersion !== record.inspectionPolicyVersion ||
        input.expectedState !== record.state
      ) {
        throw new DomainError(
          "attachment_inspection_conflict",
          "Attachment inspection epoch or state changed",
          409,
        );
      }
      transitions.push(`${input.expectedState}->${input.nextState}`);
      record = {
        ...record,
        state: input.nextState,
        inspectionError: input.inspectionError ?? null,
        version: record.version + 1,
      };
      return structuredClone(record);
    },
  } as Pick<DomainRepository, "getAttachment" | "transitionAttachmentInspection">;
  return {
    repository,
    transitions,
    current: () => structuredClone(record),
    replace: (next: AttachmentRecord) => record = structuredClone(next),
  };
}

Deno.test("local inspection verifies immutable bytes and detects split EICAR marker", async () => {
  const clean = await fixture("ordinary text");
  assertEquals(
    await inspectAttachmentLocally(
      stored(clean.value, { owner: clean.attachment.ownerId, sha256: clean.attachment.sha256 }),
      clean.attachment,
      { maxBytes: 1024 },
    ),
    "clean",
  );
  const eicar = await fixture(`prefix-EICAR-STANDARD-ANTIVIRUS-TEST-FILE-suffix`);
  assertEquals(
    await inspectAttachmentLocally(
      storedFor(eicar),
      eicar.attachment,
      { maxBytes: 1024 },
    ),
    "infected",
  );
  await assertRejects(
    () =>
      inspectAttachmentLocally(
        stored(bytes("tampered")),
        clean.attachment,
        { maxBytes: 1024 },
      ),
    Error,
    "size",
  );
});

Deno.test("local inspection requires exact immutable object metadata", async () => {
  const source = await fixture("metadata-bound bytes");
  await assertRejects(
    () =>
      inspectAttachmentLocally(
        stored(source.value, { sha256: source.attachment.sha256 }),
        source.attachment,
        { maxBytes: 1024 },
      ),
    Error,
    "ownership",
  );
  await assertRejects(
    () =>
      inspectAttachmentLocally(
        stored(source.value, { owner: source.attachment.ownerId }),
        source.attachment,
        { maxBytes: 1024 },
      ),
    Error,
    "digest metadata",
  );
  await assertRejects(
    () =>
      inspectAttachmentLocally(
        stored(source.value, {
          owner: "00000000-0000-4000-8000-000000000099",
          sha256: source.attachment.sha256,
        }),
        source.attachment,
        { maxBytes: 1024 },
      ),
    Error,
    "ownership",
  );
  await assertRejects(
    () =>
      inspectAttachmentLocally(
        stored(source.value, {
          owner: source.attachment.ownerId,
          sha256: "0".repeat(64),
        }),
        source.attachment,
        { maxBytes: 1024 },
      ),
    Error,
    "digest metadata",
  );
});

Deno.test("initial epoch-one inspection transitions pending through inspecting to ready", async () => {
  const source = await fixture();
  source.attachment.inspectionEpoch = 1;
  source.attachment.version = 1;
  const fake = fakeRepository(source.attachment);
  const result = await processAttachmentInspection({
    payload: inspectionPayload(source, 1),
    repository: fake.repository,
    objectStore: { get: () => Promise.resolve(storedFor(source)) },
    limits: { maxBytes: 1024 },
  });
  assertEquals(result.status, "ready");
  assertEquals(fake.transitions, ["pending->inspecting", "inspecting->ready"]);
});

Deno.test("local policy quarantines infected bytes without invoking a remote scanner", async () => {
  const source = await fixture("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
  const fake = fakeRepository(source.attachment);
  let fetches = 0;
  const result = await processAttachmentInspection({
    payload: inspectionPayload(source),
    repository: fake.repository,
    objectStore: { get: () => Promise.resolve(storedFor(source)) },
    limits: { maxBytes: 1024 },
    scanner: {
      endpoint: "https://scanner.example.test/scan",
      authorization: "Bearer not-a-real-token",
      timeoutMs: 100,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      allowPrivateNetwork: false,
    },
    resolveDns: publicDns,
    fetch: () => {
      fetches++;
      return Promise.resolve(new Response('{"status":"clean"}'));
    },
  });
  assertEquals(result.status, "quarantined");
  assertEquals(fake.transitions, ["pending->inspecting", "inspecting->quarantined"]);
  assertEquals(fetches, 0);
});

Deno.test("stale inspection epochs are superseded without reads or mutations", async () => {
  const source = await fixture();
  const fake = fakeRepository({ ...source.attachment, inspectionEpoch: 3 });
  let reads = 0;
  const result = await processAttachmentInspection({
    payload: inspectionPayload(source),
    repository: fake.repository,
    objectStore: {
      get: () => {
        reads++;
        return Promise.resolve(storedFor(source));
      },
    },
    limits: { maxBytes: 1024 },
  });
  assertEquals(result, { status: "superseded" });
  assertEquals(fake.transitions, []);
  assertEquals(reads, 0);
  assertEquals(fake.current().state, "pending");
});

Deno.test("an existing synchronous-policy quarantine is never scanned or promoted", async () => {
  const source = await fixture();
  const fake = fakeRepository({
    ...source.attachment,
    state: "quarantined",
    inspectionError: "image_guard_polyglot",
  });
  let reads = 0;
  const result = await processAttachmentInspection({
    payload: inspectionPayload(source),
    repository: fake.repository,
    objectStore: {
      get: () => {
        reads++;
        return Promise.resolve(storedFor(source));
      },
    },
    limits: { maxBytes: 1024 },
  });
  assertEquals(result, { status: "superseded" });
  assertEquals(reads, 0);
  assertEquals(fake.transitions, []);
  assertEquals(fake.current().inspectionError, "image_guard_polyglot");
});

Deno.test("external-required inspection fails closed when this worker has no scanner", async () => {
  const source = await fixture();
  source.attachment.requiredInspectionMode = "external";
  const fake = fakeRepository(source.attachment);
  let reads = 0;
  const result = await processAttachmentInspection({
    payload: inspectionPayload(source),
    repository: fake.repository,
    objectStore: {
      get: () => {
        reads++;
        return Promise.resolve(storedFor(source));
      },
    },
    limits: { maxBytes: 1024 },
  });
  assertEquals(result.status, "failed");
  assertEquals(reads, 0);
  assertEquals(fake.transitions, ["pending->inspecting", "inspecting->failed"]);
  assertEquals(
    fake.current().inspectionError,
    ATTACHMENT_INSPECTION_REASON.externalScannerUnavailable,
  );
});

Deno.test("inspection mode or policy mismatch is superseded before object access", async () => {
  const source = await fixture();
  const fake = fakeRepository(source.attachment);
  let reads = 0;
  const result = await processAttachmentInspection({
    payload: {
      ...inspectionPayload(source),
      requiredInspectionMode: "external",
    },
    repository: fake.repository,
    objectStore: {
      get: () => {
        reads++;
        return Promise.resolve(storedFor(source));
      },
    },
    limits: { maxBytes: 1024 },
  });
  assertEquals(result, { status: "superseded" });
  assertEquals(reads, 0);
  assertEquals(fake.transitions, []);
});

Deno.test("external scanner clean and infected outcomes become fenced terminal states", async () => {
  for (const scannerStatus of ["clean", "infected"] as const) {
    const source = await fixture();
    source.attachment.requiredInspectionMode = "external";
    const fake = fakeRepository(source.attachment);
    let reads = 0;
    const result = await processAttachmentInspection({
      payload: inspectionPayload(source),
      repository: fake.repository,
      objectStore: {
        get: () => {
          reads++;
          return Promise.resolve(storedFor(source));
        },
      },
      limits: { maxBytes: 1024 },
      scanner: {
        endpoint: "https://scanner.example.test/scan",
        authorization: "Bearer not-a-real-token",
        timeoutMs: 100,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
        allowPrivateNetwork: false,
      },
      resolveDns: publicDns,
      fetch: async (_url, init) => {
        await new Response(init?.body).arrayBuffer();
        return new Response(JSON.stringify({ status: scannerStatus }));
      },
    });
    assertEquals(result.status, scannerStatus === "clean" ? "ready" : "quarantined");
    assertEquals(
      fake.transitions,
      [
        "pending->inspecting",
        scannerStatus === "clean" ? "inspecting->ready" : "inspecting->quarantined",
      ],
    );
    assertEquals(reads, 2);
  }
});

Deno.test("external scanner errors remain inspecting for a durable retry", async () => {
  const source = await fixture();
  source.attachment.requiredInspectionMode = "external";
  const fake = fakeRepository(source.attachment);
  await assertRejects(
    () =>
      processAttachmentInspection({
        payload: inspectionPayload(source),
        repository: fake.repository,
        objectStore: { get: () => Promise.resolve(storedFor(source)) },
        limits: { maxBytes: 1024 },
        scanner: {
          endpoint: "https://scanner.example.test/scan",
          authorization: "Bearer not-a-real-token",
          timeoutMs: 100,
          maxRequestBytes: 1024,
          maxResponseBytes: 1024,
          allowPrivateNetwork: false,
        },
        resolveDns: publicDns,
        fetch: async (_url, init) => {
          await new Response(init?.body).arrayBuffer();
          return new Response('{"status":"error"}');
        },
      }),
    Error,
    "trustworthy",
  );
  assertEquals(fake.transitions, ["pending->inspecting"]);
  assertEquals(fake.current().state, "inspecting");

  const resumed = await processAttachmentInspection({
    payload: inspectionPayload(source),
    repository: fake.repository,
    objectStore: { get: () => Promise.resolve(storedFor(source)) },
    limits: { maxBytes: 1024 },
  });
  assertEquals(resumed.status, "failed");
  assertEquals(fake.transitions, ["pending->inspecting", "inspecting->failed"]);
  assertEquals(
    fake.current().inspectionError,
    ATTACHMENT_INSPECTION_REASON.externalScannerUnavailable,
  );
});
