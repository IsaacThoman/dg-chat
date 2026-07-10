import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import type { Conversation } from "./types.ts";

afterEach(() => vi.unstubAllGlobals());

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
