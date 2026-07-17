import { afterEach, describe, expect, it, vi } from "vitest";
import { adminAttachmentsQuery, api, pollAttachmentInspection } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("admin storage API", () => {
  it("encodes only typed inventory filters", () => {
    expect(
      Object.fromEntries(
        new URLSearchParams(adminAttachmentsQuery({
          ownerId: "00000000-0000-4000-8000-000000000001",
          state: "quarantined",
          deletion: "all",
          cursor: "opaque_cursor",
          limit: 25,
        })),
      ),
    ).toEqual({
      ownerId: "00000000-0000-4000-8000-000000000001",
      state: "quarantined",
      deletion: "all",
      cursor: "opaque_cursor",
      limit: "25",
    });
  });

  it("uses session credentials and an optimistic reason-bound reinspection command", async () => {
    const attachment = {
      id: "00000000-0000-4000-8000-000000000001",
      version: 7,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ summary: { physicalBytes: 0 } }))
      .mockResolvedValueOnce(Response.json({ data: [], nextCursor: null }))
      .mockResolvedValueOnce(
        Response.json({ attachment: { ...attachment, state: "pending" }, inspectionJobId: "job" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await api.adminStorageSummary();
    await api.adminAttachments({ deletion: "present", limit: 25 });
    await api.reinspectAdminAttachment(attachment, "Scanner policy was upgraded");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/storage/summary");
    expect(fetchMock.mock.calls[1][0]).toContain("/api/admin/storage/attachments?");
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/admin/storage/attachments/00000000-0000-4000-8000-000000000001/reinspect",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
        body: JSON.stringify({
          expectedVersion: 7,
          reason: "Scanner policy was upgraded",
        }),
      }),
    ]);
  });
});

describe("attachment inspection polling", () => {
  it("backs off through pending states and returns the terminal attachment", async () => {
    const states = ["pending", "inspecting", "ready"];
    const waits: number[] = [];
    const attachment = await pollAttachmentInspection(
      "00000000-0000-4000-8000-000000000001",
      new AbortController().signal,
      {
        load: (id) =>
          Promise.resolve({
            id,
            filename: "scan.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            state: states.shift()!,
            createdAt: "2026-07-17T00:00:00.000Z",
          }),
        wait: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      },
    );
    expect(attachment.state).toBe("ready");
    expect(waits).toEqual([500, 800]);
  });

  it("stops immediately when its owning composer cancels", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("removed", "AbortError"));
    await expect(
      pollAttachmentInspection("00000000-0000-4000-8000-000000000001", controller.signal, {
        load: () => {
          throw new Error("must not load");
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["quarantined", "failed"])(
    "returns the terminal %s inspection result without another wait",
    async (state) => {
      const wait = vi.fn(() => Promise.resolve());
      const attachment = await pollAttachmentInspection(
        "00000000-0000-4000-8000-000000000001",
        new AbortController().signal,
        {
          load: (id) =>
            Promise.resolve({
              id,
              filename: "scan.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
              state,
              inspectionError: "Scanner rejected the file",
              createdAt: "2026-07-17T00:00:00.000Z",
            }),
          wait,
        },
      );
      expect(attachment.state).toBe(state);
      expect(attachment.inspectionError).toBe("Scanner rejected the file");
      expect(wait).not.toHaveBeenCalled();
    },
  );

  it("times out without starting a wait that would cross the deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const wait = vi.fn(() => Promise.resolve());
    await expect(
      pollAttachmentInspection(
        "00000000-0000-4000-8000-000000000001",
        new AbortController().signal,
        {
          timeoutMs: 499,
          load: (id) =>
            Promise.resolve({
              id,
              filename: "scan.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
              state: "pending",
              createdAt: "2026-07-17T00:00:00.000Z",
            }),
          wait,
        },
      ),
    ).rejects.toThrow("Inspection is still running");
    expect(wait).not.toHaveBeenCalled();
  });

  it("aborts an active wait, removes its listener, and performs no further loads", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const load = vi.fn((id: string) =>
      Promise.resolve({
        id,
        filename: "scan.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        state: "pending",
        createdAt: "2026-07-17T00:00:00.000Z",
      })
    );
    const polling = pollAttachmentInspection(
      "00000000-0000-4000-8000-000000000001",
      controller.signal,
      { load },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException("removed", "AbortError"));
    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes the default wait listener when the timer resolves", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const states = ["pending", "ready"];
    const polling = pollAttachmentInspection(
      "00000000-0000-4000-8000-000000000001",
      controller.signal,
      {
        load: (id) =>
          Promise.resolve({
            id,
            filename: "scan.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            state: states.shift()!,
            createdAt: "2026-07-17T00:00:00.000Z",
          }),
      },
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(polling).resolves.toMatchObject({ state: "ready" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
