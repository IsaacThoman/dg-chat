import { afterEach, describe, expect, it, vi } from "vitest";
import { api, uploadAttachment } from "./api.ts";
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

describe("attachment API", () => {
  it("uploads multipart data and reports progress", async () => {
    const progress: number[] = [];
    let sent: FormData | undefined;
    const xhr = {
      status: 201,
      responseText: JSON.stringify({
        attachment: {
          id: "attachment-1",
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          state: "ready",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      }),
      upload: {} as XMLHttpRequestUpload,
      open: vi.fn(),
      send: vi.fn((body: FormData) => {
        sent = body;
        xhr.upload.onprogress?.call(
          xhr as unknown as XMLHttpRequest,
          { lengthComputable: true, loaded: 2, total: 5 } as ProgressEvent,
        );
        xhr.onload?.({} as ProgressEvent);
      }),
      abort: vi.fn(),
      onload: null as ((event: ProgressEvent) => void) | null,
      onerror: null as ((event: ProgressEvent) => void) | null,
      onabort: null as ((event: ProgressEvent) => void) | null,
      withCredentials: false,
    };
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await expect(
      uploadAttachment(
        file,
        (value) => progress.push(value),
        new AbortController().signal,
        () => xhr as unknown as XMLHttpRequest,
      ),
    ).resolves.toMatchObject({ id: "attachment-1", filename: "notes.txt" });
    expect(xhr.open).toHaveBeenCalledWith("POST", "/api/attachments");
    expect(xhr.withCredentials).toBe(true);
    expect(sent?.get("file")).toBe(file);
    expect(progress).toEqual([40, 100]);
  });

  it("aborts the underlying upload when the caller cancels", async () => {
    const controller = new AbortController();
    const xhr = {
      upload: {} as XMLHttpRequestUpload,
      open: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(() => xhr.onabort?.({} as ProgressEvent)),
      onload: null as ((event: ProgressEvent) => void) | null,
      onerror: null as ((event: ProgressEvent) => void) | null,
      onabort: null as ((event: ProgressEvent) => void) | null,
      withCredentials: false,
      status: 0,
      responseText: "",
    };
    const uploading = uploadAttachment(
      new File(["cancel"], "cancel.txt"),
      () => undefined,
      controller.signal,
      () => xhr as unknown as XMLHttpRequest,
    );
    controller.abort(new DOMException("User cancelled", "AbortError"));
    await expect(uploading).rejects.toThrow("User cancelled");
    expect(xhr.abort).toHaveBeenCalledOnce();
  });

  it("passes ready attachment ids to generation and deletes with an encoded id", async () => {
    const rawConversation = {
      id: "chat",
      title: "Chat",
      activeLeafId: "assistant-1",
      version: 2,
      pinned: false,
      archivedAt: null,
      deletedAt: null,
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    const rawMessage = (id: string, role: "user" | "assistant") => ({
      id,
      parentId: null,
      supersedesId: null,
      siblingIndex: 0,
      role,
      content: role,
      model: null,
      metadata: {},
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: rawMessage("user-1", "user"),
            assistant: rawMessage("assistant-1", "assistant"),
            conversation: rawConversation,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const conversation: Conversation = {
      id: "chat",
      title: "Chat",
      preview: "",
      updatedAt: "now",
      version: 1,
    };
    await api.generate(
      conversation,
      "hello",
      "model",
      undefined,
      "operation-1",
      ["attachment-1"],
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/conversations/chat/generate",
      expect.objectContaining({
        body: expect.stringContaining('"attachmentIds":["attachment-1"]'),
      }),
    );
    await api.deleteAttachment("attachment/1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/attachments/attachment%2F1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
