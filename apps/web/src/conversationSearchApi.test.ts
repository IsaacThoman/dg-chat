import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoConversationSearch } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("conversation search API", () => {
  it("applies demo workspace scope before returning local matches", () => {
    const page = demoConversationSearch(
      [
        { id: "outside", title: "needle outside", preview: "", updatedAt: "now" },
        { id: "inside", title: "needle inside", preview: "", updatedAt: "now" },
      ],
      "needle",
      "chat",
      ["inside"],
    );
    expect(page.data.map((item) => item.id)).toEqual(["inside"]);
  });

  it("posts lifecycle and cursor and maps snippets as inert text data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      data: [{
        id: "00000000-0000-4000-8000-000000000001",
        title: "Search result",
        activeLeafId: "00000000-0000-4000-8000-000000000002",
        version: 2,
        pinned: false,
        temporary: false,
        temporaryExpiresAt: null,
        archivedAt: null,
        deletedAt: null,
        updatedAt: "2026-07-15T12:00:00.000Z",
        snippet: "<img src=x onerror=alert(1)> needle",
        matchSource: "message",
        messageId: "00000000-0000-4000-8000-000000000002",
        messageRole: "assistant",
      }],
      nextCursor: "opaque-next",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const page = await api.searchConversations(
      "needle",
      "archived",
      "opaque-current",
      controller.signal,
      "00000000-0000-4000-8000-000000000010",
      ["00000000-0000-4000-8000-000000000011"],
    );
    expect(page.nextCursor).toBe("opaque-next");
    expect(page.data[0].preview).toBe("<img src=x onerror=alert(1)> needle");
    expect(page.data[0].searchMatchSource).toBe("message");
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody).toEqual({
      query: "needle",
      view: "archived",
      limit: 25,
      folderId: "00000000-0000-4000-8000-000000000010",
      tagIds: ["00000000-0000-4000-8000-000000000011"],
      cursor: "opaque-current",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/search",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        signal: controller.signal,
      }),
    );
  });
});
