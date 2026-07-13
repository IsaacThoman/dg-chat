import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { downloadConversationPortability, importConversationPortability } from "./api.ts";
import {
  PORTABILITY_MAX_BYTES,
  UserPortability,
  validatePortabilityFile,
} from "./UserPortability.tsx";

afterEach(() => vi.unstubAllGlobals());

describe("user portability", () => {
  it("rejects unsafe local files before upload", () => {
    expect(validatePortabilityFile({ name: "archive.txt", size: 10, type: "text/plain" })).toMatch(
      /\.dgchat/,
    );
    expect(validatePortabilityFile({ name: "archive.json", size: 0, type: "application/json" }))
      .toMatch(/empty/);
    expect(
      validatePortabilityFile({
        name: "archive.json",
        size: PORTABILITY_MAX_BYTES + 1,
        type: "application/json",
      }),
    ).toMatch(/16 MiB/);
    expect(validatePortabilityFile({ name: "archive.json", size: 10, type: "application/json" }))
      .toBeNull();
    expect(validatePortabilityFile({ name: "archive.dgchat", size: 10, type: "application/json" }))
      .toBeNull();
    expect(validatePortabilityFile({ name: "archive.json", size: 10, type: "" })).toBeNull();
  });

  it("describes the exact export scope and conservative defaults", () => {
    const html = renderToString(<UserPortability />);
    expect(html).toContain("every message branch");
    expect(html).toContain(
      "Attachment object bytes, account credentials, API tokens, billing, and provider secrets are never included",
    );
    expect(html).toContain("Archived conversations are included");
    expect(html).not.toContain('checked=""');
  });

  it("downloads with explicit scope and the server filename", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "Content-Disposition": 'attachment; filename="owner-export.json"' },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const value = await downloadConversationPortability({
      includeDeleted: true,
      includeTemporary: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/portability/export?includeDeleted=true&includeTemporary=false",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(value.filename).toBe("owner-export.json");
  });

  it("uses dry-run first and an idempotency key only for apply", async () => {
    const payload = {
      dryRun: true,
      replayed: false,
      conversations: 1,
      messages: 2,
      attachments: 0,
      folders: 0,
      tags: 0,
      idMap: {},
    };
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
        }),
      )
    );
    vi.stubGlobal("fetch", fetch);
    await importConversationPortability("{}", true);
    await importConversationPortability("{}", false, "stable-import-key");
    expect(fetch.mock.calls[0][0]).toBe("/api/portability/import/dry-run");
    expect((fetch.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("Idempotency-Key");
    expect(fetch.mock.calls[1][0]).toBe("/api/portability/import");
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      "Idempotency-Key": "stable-import-key",
    });
  });
});
