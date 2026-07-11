import { describe, expect, it, vi } from "vitest";
import { createImageApi, ImageApiError, imageRequest } from "./imageApi.ts";

describe("imageApi", () => {
  it("uses typed web endpoints, encoded asset IDs, filters, and idempotency", async () => {
    const request = vi.fn().mockResolvedValue({ assets: [], data: [] });
    const api = createImageApi(request);
    const signal = new AbortController().signal;
    await api.generate({ prompt: "A lighthouse", model: "p/image", count: 2 }, "key-1", signal);
    await api.edit({ prompt: "At dusk", model: "p/image", sourceAssetId: "asset/1" }, "key-2");
    await api.list({
      operation: "edit",
      query: "dusk",
      includeDeleted: false,
      cursor: "next-page",
      limit: 20,
    });
    await api.retrieve("asset/1");
    await api.remove("asset/1");
    await api.restore("asset/1");
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/images/generations",
      expect.objectContaining({
        method: "POST",
        signal,
        headers: expect.objectContaining({ "Idempotency-Key": "key-1" }),
      }),
    );
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      prompt: "A lighthouse",
      model: "p/image",
      n: 2,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/images/edits",
      expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": "key-2" }) }),
    );
    expect(request.mock.calls[2][0]).toBe(
      "/api/images?operation=edit&query=dusk&include_deleted=false&cursor=next-page&limit=20",
    );
    expect(request.mock.calls.slice(3).map((call) => call[0])).toEqual([
      "/api/images/asset%2F1",
      "/api/images/asset%2F1",
      "/api/images/asset%2F1/restore",
    ]);
  });

  it("never reflects an untrusted HTML failure body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<script>secret</script>", { status: 502 })),
    );
    await expect(imageRequest("/api/images/assets")).rejects.toEqual(expect.objectContaining({
      name: "ImageApiError",
      status: 502,
      code: "request_failed",
      message: "Image request failed (502)",
    }));
    vi.unstubAllGlobals();
  });

  it("bounds structured provider error fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: { code: "x".repeat(200), message: "m".repeat(700) } }, {
          status: 400,
        }),
      ),
    );
    try {
      await imageRequest("/api/images/assets");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageApiError);
      expect((error as ImageApiError).code).toHaveLength(100);
      expect((error as Error).message).toHaveLength(500);
    }
    vi.unstubAllGlobals();
  });

  it("accepts an empty successful delete response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(imageRequest<void>("/api/images/assets/a", { method: "DELETE" })).resolves
      .toBeUndefined();
    vi.unstubAllGlobals();
  });
});
