import {
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import type {
  AuditEventInput,
  CreateApiTokenInput,
  RotateApiTokenInput,
  UpdateApiTokenInput,
} from "@dg-chat/database";
import { createApp } from "./app.ts";

class FailingPersonalTokenAuditRepository extends MemoryRepository {
  failAction: string | null = null;

  override recordAudit(input: AuditEventInput) {
    if (input.action === this.failAction) throw new Error("injected token audit failure");
    return super.recordAudit(input);
  }
}

class EpochCapturingPersonalTokenRepository extends MemoryRepository {
  createEpochs: number[] = [];
  updateEpochs: number[] = [];
  rotateEpochs: number[] = [];
  revokeEpochs: number[] = [];

  override createApiToken(
    userId: string,
    input: CreateApiTokenInput,
    expectedAuthorityEpoch: number,
  ) {
    this.createEpochs.push(expectedAuthorityEpoch);
    return super.createApiToken(userId, input, expectedAuthorityEpoch);
  }

  override updateApiToken(
    userId: string,
    id: string,
    input: UpdateApiTokenInput,
    expectedAuthorityEpoch: number,
  ) {
    this.updateEpochs.push(expectedAuthorityEpoch);
    return super.updateApiToken(userId, id, input, expectedAuthorityEpoch);
  }

  override revokeApiTokenFamily(
    id: string,
    userId: string,
    expectedVersion: number,
    expectedAuthorityEpoch: number,
  ) {
    this.revokeEpochs.push(expectedAuthorityEpoch);
    return super.revokeApiTokenFamily(id, userId, expectedVersion, expectedAuthorityEpoch);
  }

  override rotateApiToken(
    userId: string,
    id: string,
    input: RotateApiTokenInput,
    expectedAuthorityEpoch: number,
  ) {
    this.rotateEpochs.push(expectedAuthorityEpoch);
    return super.rotateApiToken(userId, id, input, expectedAuthorityEpoch);
  }
}

async function body(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function cookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("personal token and entitlement mutations roll back when mandatory audit fails", async () => {
  const repository = new FailingPersonalTokenAuditRepository();
  const { app } = createApp({
    repository,
    setupToken: "personal-token-audit-failure",
    requestErrorLogSink: () => undefined,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "personal-token-audit-failure",
    },
    body: JSON.stringify({
      email: "token-audit-failure@example.com",
      password: "correct horse battery",
      name: "Token audit failure",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "token-audit-failure@example.com",
      password: "correct horse battery",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  repository.failAction = "api_token.created";

  const response = await app.request("/api/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Never revealed", scopes: ["models:read"] }),
  });
  const responseText = await response.text();
  assertEquals(response.status, 500);
  assertEquals(responseText.includes('"token"'), false);
  assertEquals(responseText.includes("dg_"), false);
  const owner = [...repository.users.values()].find((user) =>
    user.email === "token-audit-failure@example.com"
  )!;
  const readContext = {
    actorId: owner.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: owner.authorityEpoch,
  };
  assertEquals(repository.listApiTokens(owner.id), []);
  assertEquals(
    repository.auditEvents.some((event) => event.action === "api_token.created"),
    false,
  );

  repository.failAction = null;
  const createdResponse = await app.request("/api/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Atomic entitlement", scopes: ["models:read"] }),
  });
  assertEquals(createdResponse.status, 201);
  const created = await body(createdResponse);
  const groupResponse = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Atomic entitlement group" }),
  });
  const group = await body(groupResponse);
  const membershipResponse = await app.request(
    `/api/admin/model-access/groups/${group.id}/users`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedVersion: group.version, ids: [owner.id] }),
    },
  );
  assertEquals(membershipResponse.status, 200);

  repository.failAction = "api_token.access_groups_set";
  const accessGroupsFailure = await app.request(
    `/api/admin/model-access/tokens/${created.id}/groups`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ownerId: owner.id,
        expectedVersion: created.version,
        groupIds: [group.id],
      }),
    },
  );
  assertEquals(accessGroupsFailure.status, 500);
  assertEquals(repository.listApiTokens(owner.id)[0].version, created.version);
  assertEquals(repository.listApiTokens(owner.id)[0].accessMode, "inherit");
  assertEquals(repository.listAccessGroups(readContext)[0].tokenIds, []);

  repository.failAction = null;
  const assignedResponse = await app.request(
    `/api/admin/model-access/tokens/${created.id}/groups`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ownerId: owner.id,
        expectedVersion: created.version,
        groupIds: [group.id],
      }),
    },
  );
  assertEquals(assignedResponse.status, 200);
  const assigned = await body(assignedResponse);
  repository.failAction = "api_token.access_mode_set";
  const accessModeFailure = await app.request(
    `/api/admin/model-access/tokens/${created.id}/access-mode`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ownerId: owner.id,
        expectedVersion: assigned.version,
        accessMode: "inherit",
      }),
    },
  );
  assertEquals(accessModeFailure.status, 500);
  assertEquals(repository.listApiTokens(owner.id)[0].version, assigned.version);
  assertEquals(repository.listApiTokens(owner.id)[0].accessMode, "restricted");
  assertEquals(repository.listAccessGroups(readContext)[0].tokenIds, [created.id]);
});

Deno.test("personal token HTTP commands forward the authenticated authority epoch", async () => {
  const repository = new EpochCapturingPersonalTokenRepository();
  const { app } = createApp({
    repository,
    setupToken: "personal-token-authority-forwarding",
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "personal-token-authority-forwarding",
    },
    body: JSON.stringify({
      email: "token-authority-http@example.com",
      password: "correct horse battery",
      name: "Token authority HTTP",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "token-authority-http@example.com",
      password: "correct horse battery",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const created = await body(
    await app.request("/api/tokens", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Authority fenced", scopes: ["models:read"] }),
    }),
  );
  const owner = [...repository.users.values()].find((user) =>
    user.email === "token-authority-http@example.com"
  )!;
  assertEquals(repository.createEpochs, [owner.authorityEpoch]);

  const updatedResponse = await app.request(`/api/tokens/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: created.version, name: "Authority fenced update" }),
  });
  assertEquals(updatedResponse.status, 200);
  const updated = await body(updatedResponse);
  assertEquals(repository.updateEpochs, [owner.authorityEpoch]);

  const rotateResponse = await app.request(`/api/tokens/${created.id}/rotate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: updated.version, overlapSeconds: 0 }),
  });
  assertEquals(rotateResponse.status, 201);
  const rotated = await body(rotateResponse);
  assertEquals(repository.rotateEpochs, [owner.authorityEpoch]);

  const revokeResponse = await app.request(`/api/tokens/${rotated.replacement.id}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedVersion: rotated.replacement.version }),
  });
  assertEquals(revokeResponse.status, 204);
  assertEquals(repository.revokeEpochs, [owner.authorityEpoch]);
});

Deno.test("personal token HTTP ownership, CAS, lifecycle, policy, and secrecy edges", async () => {
  const { app, repository } = createApp({ setupToken: "personal-token-edges" });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "personal-token-edges" },
    body: JSON.stringify({
      email: "token-admin@example.com",
      password: "correct horse battery",
      name: "Token admin",
    }),
  });
  const adminLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "token-admin@example.com",
      password: "correct horse battery",
    }),
  });
  const adminHeaders = {
    cookie: cookie(adminLogin),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "other-token-owner@example.com",
      password: "correct horse battery",
      name: "Other owner",
    }),
  });
  const otherUser = (await body(signup)).user;
  assertEquals(
    (await app.request(`/api/admin/users/${otherUser.id}/approval`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "approved", expectedVersion: otherUser.version }),
    })).status,
    200,
  );
  const otherLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "other-token-owner@example.com",
      password: "correct horse battery",
    }),
  });
  const otherHeaders = {
    cookie: cookie(otherLogin),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  const createResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      name: "Secret sentinel SDK",
      scopes: ["models:read", "chat:write"],
      rpmLimit: 60,
      burstLimit: 5,
    }),
  });
  assertEquals(createResponse.status, 201);
  const created = await body(createResponse);
  assertStringIncludes(created.token, "dg_");
  const secret = created.token as string;

  const ownerListText = await (await app.request("/api/tokens", { headers: adminHeaders })).text();
  assertEquals(ownerListText.includes(secret), false);
  assertEquals(ownerListText.includes("tokenHash"), false);
  const otherList = await body(await app.request("/api/tokens", { headers: otherHeaders }));
  assertEquals(otherList.data, []);

  for (
    const invalidPolicy of [
      { name: "Bad scope", scopes: ["admin:all"] },
      { name: "Bad rates", scopes: ["models:read"], rpmLimit: 2, burstLimit: 3 },
    ]
  ) {
    const invalid = await app.request("/api/tokens", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify(invalidPolicy),
    });
    assertEquals(invalid.status, 422);
    assertEquals((await invalid.text()).includes(secret), false);
  }

  for (
    const request of [
      app.request(`/api/tokens/${created.id}`, {
        method: "PATCH",
        headers: otherHeaders,
        body: JSON.stringify({ expectedVersion: created.version, name: "stolen" }),
      }),
      app.request(`/api/tokens/${created.id}/rotate`, {
        method: "POST",
        headers: otherHeaders,
        body: JSON.stringify({ expectedVersion: created.version, overlapSeconds: 0 }),
      }),
      app.request(`/api/tokens/${created.id}`, {
        method: "DELETE",
        headers: otherHeaders,
        body: JSON.stringify({ expectedVersion: created.version }),
      }),
    ]
  ) {
    const response = await request;
    assertEquals(response.status, 404);
    const text = await response.text();
    assertEquals(text.includes(secret), false);
    assertEquals(text.includes("Secret sentinel SDK"), false);
  }

  const updatedResponse = await app.request(`/api/tokens/${created.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({
      expectedVersion: created.version,
      name: "Restricted SDK",
      scopes: ["chat:write"],
      rpmLimit: 12,
      burstLimit: 3,
    }),
  });
  assertEquals(updatedResponse.status, 200);
  const updated = await body(updatedResponse);
  assertEquals(updated.scopes, ["chat:write"]);
  assertEquals(updated.rpmLimit, 12);
  assertEquals(updated.burstLimit, 3);
  assertEquals(
    (await app.request("/v1/models", { headers: { authorization: `Bearer ${secret}` } })).status,
    403,
  );

  for (const method of ["PATCH", "DELETE"] as const) {
    const stale = await app.request(`/api/tokens/${created.id}`, {
      method,
      headers: adminHeaders,
      body: JSON.stringify(
        method === "PATCH"
          ? { expectedVersion: created.version, name: "stale" }
          : { expectedVersion: created.version },
      ),
    });
    assertEquals(stale.status, 409);
  }

  const zeroOverlapResponse = await app.request(`/api/tokens/${created.id}/rotate`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ expectedVersion: updated.version, overlapSeconds: 0 }),
  });
  assertEquals(zeroOverlapResponse.status, 201);
  const zeroOverlap = await body(zeroOverlapResponse);
  assertEquals(
    (await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "simulated/dg-chat",
        messages: [{ role: "user", content: "x" }],
      }),
    })).status,
    401,
  );
  assertEquals(
    (await app.request(`/api/tokens/${created.id}/rotate`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ expectedVersion: zeroOverlap.previous.version, overlapSeconds: 0 }),
    })).status,
    409,
  );

  const maxOverlapResponse = await app.request(
    `/api/tokens/${zeroOverlap.replacement.id}/rotate`,
    {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        expectedVersion: zeroOverlap.replacement.version,
        overlapSeconds: 3600,
      }),
    },
  );
  assertEquals(maxOverlapResponse.status, 201);
  const maxOverlap = await body(maxOverlapResponse);
  const maxSecret = maxOverlap.token as string;
  assertEquals(
    (await app.request(
      `/api/tokens/${maxOverlap.replacement.id}/rotate`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          expectedVersion: maxOverlap.replacement.version,
          overlapSeconds: 3601,
        }),
      },
    )).status,
    422,
  );

  const revoked = await app.request(`/api/tokens/${maxOverlap.replacement.id}`, {
    method: "DELETE",
    headers: adminHeaders,
    body: JSON.stringify({ expectedVersion: maxOverlap.replacement.version }),
  });
  assertEquals(revoked.status, 204);
  const afterRevoke = await body(await app.request("/api/tokens", { headers: adminHeaders }));
  const revokedCurrent = afterRevoke.data.find((token: { id: string }) =>
    token.id === maxOverlap.replacement.id
  );
  assertExists(revokedCurrent);
  assertEquals(
    (await app.request(`/api/tokens/${revokedCurrent.id}/rotate`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ expectedVersion: revokedCurrent.version, overlapSeconds: 0 }),
    })).status,
    409,
  );

  const expiredResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      name: "Expired SDK",
      scopes: ["models:read"],
      expiresAt: "2020-01-01T00:00:00.000Z",
    }),
  });
  assertEquals(expiredResponse.status, 201);
  const expired = await body(expiredResponse);
  assertEquals(
    (await app.request("/v1/models", {
      headers: { authorization: `Bearer ${expired.token}` },
    })).status,
    401,
  );

  const auditText = await (await app.request("/api/admin/audit?limit=100", {
    headers: adminHeaders,
  })).text();
  for (const value of [secret, zeroOverlap.token as string, maxSecret, expired.token as string]) {
    assertEquals(auditText.includes(value), false);
  }
  assertEquals(auditText.includes("tokenHash"), false);
  const tokenAuditActions = new Set(
    (JSON.parse(auditText).data as { action: string }[])
      .filter((event) => event.action.startsWith("api_token."))
      .map((event) => event.action),
  );
  assertEquals(
    tokenAuditActions,
    new Set([
      "api_token.created",
      "api_token.updated",
      "api_token.rotated",
      "api_token.revoked",
    ]),
  );
  assertEquals(
    (await app.request("/api/admin/model-access/tokens?cursor=not-a-uuid", {
      headers: adminHeaders,
    })).status,
    422,
  );
  const admin = await repository.findUserByEmail("token-admin@example.com");
  assertExists(admin);
  assertThrows(() =>
    repository.searchApiTokens(
      {
        actorId: admin.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: admin.authorityEpoch,
      },
      "",
      50,
      "not-a-uuid",
    )
  );
});
