import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { sha256 } from "./crypto.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function responseCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return cookie;
}

async function fixture() {
  const repository = new MemoryRepository();
  let now = Date.now();
  const { app } = createApp({
    repository,
    setupToken: "admin-security-billing-setup",
    now: () => now,
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "admin-security-billing-setup",
    },
    body: JSON.stringify({
      email: "admin-security@example.com",
      password: "correct horse battery",
      name: "Security administrator",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const admin = (await json(bootstrap)).user;
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin-security@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(login.status, 200);
  const headers = {
    cookie: responseCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "controlled-user@example.com",
      password: "correct horse battery",
      name: "Controlled user",
    }),
  });
  assertEquals(signup.status, 201);
  const applicant = (await json(signup)).user;
  const approval = await app.request(`/api/admin/users/${applicant.id}/approval`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "approved",
      expectedVersion: applicant.version,
      startingCreditMicros: 5_000_000,
    }),
  });
  assertEquals(approval.status, 200);
  return {
    app,
    repository,
    admin,
    user: await json(approval),
    headers,
    advance: (milliseconds: number) => now += milliseconds,
  };
}

function assertPrivate(response: Response) {
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("pragma"), "no-cache");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(
    response.headers.get("vary")?.split(",").map((value) => value.trim()).includes("Cookie"),
    true,
  );
}

Deno.test("admin user detail lists and atomically revokes target sessions and token families", async () => {
  const { app, repository, admin, user, headers } = await fixture();
  const targetSession = repository.createSession(
    user.id,
    await sha256("target-session-secret"),
    false,
  );
  const token = repository.createApiToken(user.id, {
    name: "Automation",
    scopes: ["chat:write"],
    tokenHash: await sha256("target-api-token"),
    preview: "dg_…test",
    rpmLimit: 60,
    burstLimit: 10,
  });

  const sessions = await app.request(`/api/admin/users/${user.id}/sessions?limit=25`, {
    headers: { cookie: headers.cookie },
  });
  assertEquals(sessions.status, 200);
  assertPrivate(sessions);
  const sessionPage = await json(sessions);
  assertEquals(sessionPage.data[0].id, `legacy:${targetSession.id}`);
  assertEquals(sessionPage.data[0].current, false);
  assertEquals("tokenHash" in sessionPage.data[0], false);

  const crossOwnerSession = await app.request(
    `/api/admin/users/${admin.id}/sessions/legacy/${targetSession.id}/revoke`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "Must remain target-bound" }),
    },
  );
  assertEquals(crossOwnerSession.status, 404);
  assertPrivate(crossOwnerSession);

  const revokeSession = await app.request(
    `/api/admin/users/${user.id}/sessions/legacy/${targetSession.id}/revoke`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "Lost managed device" }),
    },
  );
  assertEquals(revokeSession.status, 204);
  assertPrivate(revokeSession);
  assertEquals(
    repository.listSessions(user.id).find((candidate) => candidate.id === targetSession.id)
      ?.invalidatedAt !== null,
    true,
  );

  const currentAdminSession = repository.listSessions(admin.id)[0];
  const protectCurrent = await app.request(
    `/api/admin/users/${admin.id}/sessions/legacy/${currentAdminSession.id}/revoke`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "Must not revoke the acting session" }),
    },
  );
  assertEquals(protectCurrent.status, 409);
  assertPrivate(protectCurrent);
  assertEquals((await json(protectCurrent)).error.code, "current_session_protected");

  const tokens = await app.request(`/api/admin/users/${user.id}/api-tokens?limit=25`, {
    headers: { cookie: headers.cookie },
  });
  assertEquals(tokens.status, 200);
  assertPrivate(tokens);
  const tokenPage = await json(tokens);
  assertEquals(tokenPage.data[0].id, token.id);
  assertEquals(tokenPage.data[0].scopes, ["chat:write"]);
  assertEquals("tokenHash" in tokenPage.data[0], false);

  const staleToken = await app.request(
    `/api/admin/users/${user.id}/api-tokens/${token.id}/revoke`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedVersion: token.version + 1, reason: "Stale command" }),
    },
  );
  assertEquals(staleToken.status, 409);
  assertPrivate(staleToken);
  assertEquals((await json(staleToken)).error.code, "version_conflict");
  assertEquals(repository.listApiTokens(user.id)[0].revokedAt, null);

  const revokeToken = await app.request(
    `/api/admin/users/${user.id}/api-tokens/${token.id}/revoke`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedVersion: token.version, reason: "Credential exposure" }),
    },
  );
  assertEquals(revokeToken.status, 204);
  assertEquals(repository.listApiTokens(user.id)[0].revokedAt !== null, true);
  assertEquals(
    repository.listAudit({ targetId: token.id, action: "user.api_token_family.revoked" }).data
      .length,
    1,
  );
});

Deno.test("admin balance adjustments are exact, CAS-bound, replayable, and confidential", async () => {
  const { app, repository, user, headers } = await fixture();
  const endpoint = `/api/admin/users/${user.id}/balance-adjustments`;
  const request = {
    amountMicros: 1_234_567,
    expectedBalanceMicros: 5_000_000,
    reason: "  Service recovery credit  ",
  };
  const first = await app.request(endpoint, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "billing-adjustment-0001" },
    body: JSON.stringify(request),
  });
  assertEquals(first.status, 200);
  assertPrivate(first);
  const result = await json(first);
  assertEquals(result.balanceBeforeMicros, 5_000_000);
  assertEquals(result.balanceAfterMicros, 6_234_567);
  assertEquals(result.reason, "Service recovery credit");
  assertEquals(result.replayed, false);
  assertEquals("idempotencyKey" in result, false);
  assertEquals(repository.findUser(user.id)?.balanceMicros, 6_234_567);

  const replay = await app.request(endpoint, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "billing-adjustment-0001" },
    body: JSON.stringify(request),
  });
  assertEquals(replay.status, 200);
  const replayed = await json(replay);
  assertEquals(replayed.id, result.id);
  assertEquals(replayed.ledgerEntryId, result.ledgerEntryId);
  assertEquals(replayed.replayed, true);
  assertEquals(
    repository.listLedger(user.id).filter((entry) => entry.kind === "adjustment").length,
    1,
  );

  const conflict = await app.request(endpoint, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "billing-adjustment-0001" },
    body: JSON.stringify({ ...request, amountMicros: 2_000_000 }),
  });
  assertEquals(conflict.status, 409);
  assertEquals((await json(conflict)).error.code, "idempotency_conflict");

  const ledger = await app.request(`/api/admin/users/${user.id}/ledger?kind=adjustment&limit=1`, {
    headers: { cookie: headers.cookie },
  });
  assertEquals(ledger.status, 200);
  assertPrivate(ledger);
  const page = await json(ledger);
  assertEquals(page.data.length, 1);
  assertEquals(page.data[0].amountMicros, 1_234_567);
  assertEquals(page.data[0].adjustment.reason, "Service recovery credit");
  assertEquals("metadata" in page.data[0], false);
});

Deno.test("admin security and billing mutations enforce origin, session auth, and recent proof", async () => {
  const { app, repository, admin, user, headers, advance } = await fixture();
  const session = repository.createSession(user.id, await sha256("origin-target"), false);
  const path = `/api/admin/users/${user.id}/sessions/legacy/${session.id}/revoke`;

  const noOrigin = await app.request(path, {
    method: "POST",
    headers: { cookie: headers.cookie, "content-type": "application/json" },
    body: JSON.stringify({ reason: "No origin" }),
  });
  assertEquals(noOrigin.status, 403);
  assertEquals((await json(noOrigin)).error.code, "invalid_origin");

  const duplicateQuery = await app.request(
    `/api/admin/users/${user.id}/sessions?limit=1&limit=2`,
    { headers: { cookie: headers.cookie } },
  );
  assertEquals(duplicateQuery.status, 422);

  const bearer = `dg_${crypto.randomUUID()}`;
  repository.createApiToken(admin.id, {
    name: "Admin bearer cannot administer",
    scopes: ["chat:write"],
    tokenHash: await sha256(bearer),
    preview: bearer.slice(-4),
  });
  const tokenAuth = await app.request(`/api/admin/users/${user.id}/ledger`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assertEquals(tokenAuth.status, 403);
  assertEquals((await json(tokenAuth)).error.code, "session_required");

  advance(11 * 60 * 1_000);
  const stale = await app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "Old session" }),
  });
  assertEquals(stale.status, 403);
  assertEquals((await json(stale)).error.code, "recent_authentication_required");
  assertEquals(repository.listSessions(user.id)[0].invalidatedAt, null);
});
