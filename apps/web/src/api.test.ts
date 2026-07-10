import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import type { Conversation } from "./types.ts";

afterEach(() => vi.unstubAllGlobals());

describe("setup discovery API", () => {
  it("reads bootstrap and OIDC capabilities from the public status endpoint", async () => {
    const status = { bootstrapRequired: true, setupEnabled: true, oidcEnabled: false };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.setupStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setup/status",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("active branch API", () => {
  it("persists a selected leaf with the current conversation version", async () => {
    const conversation: Conversation = {
      id: "conversation-1",
      title: "Branches",
      preview: "",
      updatedAt: "now",
      activeLeafId: "old-leaf",
      version: 7,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: conversation.id,
          title: conversation.title,
          activeLeafId: "new-leaf",
          version: 8,
          pinned: false,
          archivedAt: null,
          updatedAt: "2026-07-10T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.setActiveLeaf(conversation, "new-leaf")).resolves.toMatchObject({
      activeLeafId: "new-leaf",
      version: 8,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conversation-1/active-leaf",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ leafId: "new-leaf", expectedVersion: 7 }),
      }),
    );
  });
});

describe("conversation creation API", () => {
  it("sends the stable operation id in both the header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "conversation-new",
          title: "New chat",
          activeLeafId: null,
          version: 0,
          pinned: false,
          archivedAt: null,
          updatedAt: "2026-07-10T00:00:00.000Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.createConversation("New chat", "operation-stable-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "operation-stable-1" }),
        body: JSON.stringify({ title: "New chat", idempotencyKey: "operation-stable-1" }),
      }),
    );
  });
});

describe("conversation lifecycle API", () => {
  const rawConversation = (id: string, deletedAt: string | null = null) => ({
    id,
    title: id,
    activeLeafId: null,
    version: 1,
    pinned: false,
    archivedAt: null,
    deletedAt,
    updatedAt: "2026-07-10T00:00:00.000Z",
  });

  it("lists only deleted conversations from the include-deleted endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            rawConversation("active"),
            rawConversation("deleted", "2026-07-10T01:00:00.000Z"),
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.deletedConversations()).resolves.toMatchObject([{
      id: "deleted",
      deleted: true,
    }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations?deleted=true", expect.anything());
  });

  it("sends typed rename, pin, archive, delete, and restore patches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rawConversation("chat")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.updateConversation("chat", {
      title: "Renamed",
      pinned: true,
      archived: true,
      deleted: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/chat",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed", pinned: true, archived: true, deleted: false }),
      }),
    );
  });
});
