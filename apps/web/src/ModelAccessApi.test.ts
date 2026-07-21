import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import type { AdminTokenAccessItem, ModelAccessGroup, ModelAlias, Token } from "./types.ts";

afterEach(() => vi.unstubAllGlobals());

describe("token governance and model access API", () => {
  it("sends nullable limits, overlap, and optimistic token versions", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetchMock);
    const token = { id: "token/id", version: 4 } as Token;
    await api.createToken({
      name: "SDK",
      scopes: ["chat:write"],
      expiresAt: null,
      rpmLimit: null,
      burstLimit: null,
    });
    await api.rotateToken(token, 300);
    await api.revokeToken(token);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/tokens",
      "/api/tokens/token%2Fid/rotate",
      "/api/tokens/token%2Fid",
    ]);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      JSON.stringify({
        name: "SDK",
        scopes: ["chat:write"],
        expiresAt: null,
        rpmLimit: null,
        burstLimit: null,
      }),
    );
    expect(fetchMock.mock.calls[1][1].body).toBe(
      JSON.stringify({ expectedVersion: 4, overlapSeconds: 300 }),
    );
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 4 }),
    });
  });

  it("uses bounded token lookup and versioned group and alias assignments", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(Response.json({ data: [], nextCursor: null }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const group = { id: "group/id", version: 2 } as ModelAccessGroup;
    const token = { id: "token/id", ownerId: "owner", version: 7 } as AdminTokenAccessItem;
    const alias = { id: "alias/id", version: 3 } as ModelAlias;
    await api.replaceAdminModelAccessGroupMembers(group, ["user"]);
    await api.replaceAdminModelAccessGroupModels(group, ["model"], ["became-public"]);
    await api.setAdminTokenAccessGroups(token, ["group"]);
    await api.adminModelAccessTokens("alice", "opaque+/=", 25);
    await api.deleteAdminModelAlias(alias);
    await api.previewAdminModelAccessGroupPolicy(group, {
      userIds: ["owner"],
      modelIds: ["model"],
      tokenIds: ["token/id"],
    });
    await api.replaceAdminModelAccessGroupPolicy(group, {
      name: "Private",
      description: "",
      userIds: ["owner"],
      modelIds: ["model"],
      tokenIds: ["token/id"],
      acknowledgePublicModelIds: ["became-public"],
    });
    await api.deleteAdminModelAccessGroup(group, ["became-public"]);
    await api.setAdminTokenAccessMode(token, "restricted");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/admin/model-access/groups/group%2Fid/users",
      "/api/admin/model-access/groups/group%2Fid/models",
      "/api/admin/model-access/tokens/token%2Fid/groups",
      "/api/admin/model-access/tokens?query=alice&limit=25&cursor=opaque%2B%2F%3D",
      "/api/admin/model-access/aliases/alias%2Fid",
      "/api/admin/model-access/groups/group%2Fid/impact",
      "/api/admin/model-access/groups/group%2Fid/policy",
      "/api/admin/model-access/groups/group%2Fid",
      "/api/admin/model-access/tokens/token%2Fid/access-mode",
    ]);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      JSON.stringify({ expectedVersion: 2, ids: ["user"] }),
    );
    expect(fetchMock.mock.calls[1][1].body).toBe(
      JSON.stringify({
        expectedVersion: 2,
        ids: ["model"],
        acknowledgePublicModelIds: ["became-public"],
      }),
    );
    expect(fetchMock.mock.calls[2][1].body).toBe(
      JSON.stringify({ ownerId: "owner", expectedVersion: 7, groupIds: ["group"] }),
    );
    expect(fetchMock.mock.calls[5][1].body).toBe(JSON.stringify({
      proposal: { userIds: ["owner"], modelIds: ["model"], tokenIds: ["token/id"] },
    }));
    expect(fetchMock.mock.calls[6][1].body).toBe(JSON.stringify({
      expectedVersion: 2,
      name: "Private",
      description: "",
      userIds: ["owner"],
      modelIds: ["model"],
      tokenIds: ["token/id"],
      acknowledgePublicModelIds: ["became-public"],
    }));
    expect(fetchMock.mock.calls[7][1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({
        expectedVersion: 2,
        acknowledgePublicModelIds: ["became-public"],
      }),
    });
    expect(fetchMock.mock.calls[8][1].body).toBe(JSON.stringify({
      ownerId: "owner",
      expectedVersion: 7,
      accessMode: "restricted",
    }));
  });
});
