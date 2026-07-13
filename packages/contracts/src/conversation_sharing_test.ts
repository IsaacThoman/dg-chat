import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { parsePublicConversationShare } from "./conversation_sharing.ts";
import type { PublicConversationShare } from "./types.ts";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const NOW = "2026-07-13T12:00:00.000Z";
const valid = (): PublicConversationShare => ({
  id: id(1),
  title: "Exact branch",
  conversationVersion: 2,
  identity: { visibility: "anonymous", displayName: null },
  attachmentPolicy: "selected",
  messages: [{
    id: id(2),
    parentId: null,
    role: "user",
    content: "Question",
    status: "complete",
    attachmentIds: [id(4)],
    createdAt: NOW,
  }, {
    id: id(3),
    parentId: id(2),
    role: "assistant",
    content: "Answer",
    status: "complete",
    attachmentIds: [],
    createdAt: NOW,
  }],
  attachments: [{
    id: id(4),
    filename: "image.png",
    mimeType: "image/png",
    sizeBytes: 100,
    width: 10,
    height: 20,
    createdAt: NOW,
  }],
  createdAt: NOW,
  expiresAt: null,
});

Deno.test("public conversation share contract accepts one strict materialized path", () => {
  assertEquals(parsePublicConversationShare(valid()), valid());
});

Deno.test("public conversation share contract rejects unknown, identifying, and graph data", () => {
  for (
    const mutate of [
      (value: Record<string, unknown>) =>
        Object.assign(value, { ownerEmail: "private@example.com" }),
      (value: Record<string, unknown>) => {
        (value.identity as Record<string, unknown>).displayName = "Leaked";
      },
      (value: Record<string, unknown>) => {
        (value.messages as Array<Record<string, unknown>>)[1].parentId = id(99);
      },
      (value: Record<string, unknown>) => {
        (value.messages as Array<Record<string, unknown>>)[0].attachmentIds = [id(99)];
      },
      (value: Record<string, unknown>) => {
        (value.messages as Array<Record<string, unknown>>)[0].metadata = { internal: true };
      },
      (value: Record<string, unknown>) => {
        (value.messages as Array<Record<string, unknown>>)[0].model = "private/provider-route";
      },
      (value: Record<string, unknown>) => {
        (value.messages as Array<Record<string, unknown>>)[0].role = "developer";
      },
      (value: Record<string, unknown>) => {
        (value.messages as Array<Record<string, unknown>>)[0].status = "tombstoned";
      },
    ]
  ) {
    const value = structuredClone(valid()) as unknown as Record<string, unknown>;
    mutate(value);
    assertThrows(() => parsePublicConversationShare(value));
  }
});

Deno.test("redacted public shares cannot smuggle attachment metadata", () => {
  const value = valid();
  value.attachmentPolicy = "redact";
  assertThrows(() => parsePublicConversationShare(value));
});
