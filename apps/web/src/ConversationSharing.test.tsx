import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createConversationShare,
  getPublicConversationShare,
  listConversationShares,
  revokeConversationShare,
} from "./api.ts";
import { ConversationShareButton, createShareCapability } from "./ConversationSharing.tsx";
import { PublicConversationShareView } from "./PublicConversationShare.tsx";

afterEach(() => vi.unstubAllGlobals());

const summary = {
  id: "share-1",
  conversationId: "conversation-1",
  leafId: "message-1",
  conversationVersion: 3,
  title: "Snapshot",
  identityVisibility: "anonymous" as const,
  attachmentPolicy: "redact" as const,
  attachmentCount: 0,
  messageCount: 1,
  version: 1,
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
};

describe("conversation sharing", () => {
  it("generates 256-bit unpadded base64url capabilities", () => {
    const one = createShareCapability();
    const two = createShareCapability();
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(two).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one).not.toBe(two);
  });

  it("labels temporary and empty chats honestly", () => {
    const temporary = renderToString(
      <ConversationShareButton
        conversation={{
          id: "conversation-1",
          title: "Temporary",
          preview: "",
          updatedAt: "now",
          temporary: true,
          activeLeafId: "message-1",
          version: 1,
        }}
        messages={[]}
      />,
    );
    expect(temporary).toContain("Temporary chats cannot be shared");
    expect(temporary).toContain("disabled");
  });

  it("sends the capability and idempotency header only to the authenticated create route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          share: summary,
          capability: "a".repeat(43),
          path: `/share/${"a".repeat(43)}`,
          replayed: false,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await createConversationShare({
      conversationId: "conversation-1",
      leafId: "message-1",
      expectedConversationVersion: 3,
      identityVisibility: "anonymous",
      attachmentPolicy: "redact",
      selectedAttachmentIds: [],
      expiresAt: null,
      capability: "a".repeat(43),
      idempotencyKey: "stable-share-create-key",
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/conversations/conversation-1/shares");
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({ "Idempotency-Key": "stable-share-create-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({ capability: "a".repeat(43) });
  });

  it("lists, revokes, and resolves a public capability with the correct credential modes", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [summary] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ share: { ...summary, revokedAt: "now" } }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            share: {
              id: "public-share-1",
              title: "Snapshot",
              conversationVersion: 3,
              identity: { visibility: "anonymous", displayName: null },
              attachmentPolicy: "redact",
              messages: [],
              attachments: [],
              createdAt: summary.createdAt,
              expiresAt: null,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await listConversationShares()).toHaveLength(1);
    expect((await revokeConversationShare("share-1", 1)).revokedAt).toBe("now");
    expect((await getPublicConversationShare("a".repeat(43))).title).toBe("Snapshot");
    expect(fetch.mock.calls[2][1]).toMatchObject({ credentials: "omit" });
  });

  it("renders invalid public capabilities as unavailable without fetching", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    const html = renderToString(
      <QueryClientProvider client={client}>
        <PublicConversationShareView capability="invalid" />
      </QueryClientProvider>,
    );
    expect(html).toContain("Snapshot unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
