import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert@1.0.14";
import { assertEmailVerificationAdminReadiness, createApp } from "./app.ts";
import { MemoryRepository } from "@dg-chat/database";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return cookie;
}

async function fixture(startingCreditMicros?: number, requireEmailVerification = false) {
  const repository = new MemoryRepository();
  let now = Date.now();
  const { app } = createApp({
    repository,
    setupToken: "admin-lifecycle-setup",
    startingCreditMicros,
    requireEmailVerification,
    now: () => now,
  });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "admin-lifecycle-setup" },
    body: JSON.stringify({
      email: "admin@example.com",
      password: "correct horse battery",
      name: "Administrator",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const admin = (await json(bootstrap)).user;
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
  });
  assertEquals(login.status, 200);
  const headers = {
    cookie: sessionCookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "person@example.com",
      password: "correct horse battery",
      name: "Person",
    }),
  });
  assertEquals(signup.status, 201);
  const applicant = (await json(signup)).user;
  return {
    app,
    repository,
    admin,
    applicant,
    headers,
    advance: (milliseconds: number) => now += milliseconds,
  };
}

Deno.test("required email verification fails startup before an unusable admin lockout", () => {
  const repository = new MemoryRepository();
  const unavailableAdmin = repository.createUser({
    email: "unverified-admin@example.com",
    name: "Unverified administrator",
    role: "admin",
    approvalStatus: "pending",
  });
  unavailableAdmin.approvalStatus = "approved";

  assertThrows(
    () => assertEmailVerificationAdminReadiness(repository.listUsers(), true),
    Error,
    "needs at least one verified, approved, active administrator",
  );
  assertEmailVerificationAdminReadiness(repository.listUsers(), false);
  unavailableAdmin.emailVerifiedAt = new Date().toISOString();
  assertEmailVerificationAdminReadiness(repository.listUsers(), true);
});

Deno.test("required email verification rejects promotion of an unverified approved user", async () => {
  const { app, repository, applicant, headers } = await fixture(undefined, true);
  const approved = repository.decideUserApproval({
    actorId: repository.listUsers().find((user) => user.role === "admin")!.id,
    targetUserId: applicant.id,
    expectedVersion: applicant.version,
    status: "approved",
    startingCreditMicros: 0,
  });
  const response = await app.request(`/api/admin/users/${applicant.id}/role`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      role: "admin",
      expectedVersion: approved.version,
      reason: "Must verify before promotion",
    }),
  });
  assertEquals(response.status, 409);
  assertEquals((await json(response)).error.code, "email_not_verified");
  assertEquals(repository.findUser(applicant.id)?.role, "user");
});

Deno.test("admin settings expose and approval applies the configured default credit", async () => {
  const { app, applicant, headers } = await fixture(6_750_001);
  const settingsResponse = await app.request("/api/admin/settings", {
    headers: { cookie: headers.cookie },
  });
  assertEquals(settingsResponse.status, 200);
  assertEquals(settingsResponse.headers.get("cache-control"), "private, no-store");
  assertEquals(
    settingsResponse.headers.get("vary")?.split(",").map((value) => value.trim()).includes(
      "Cookie",
    ),
    true,
  );
  assertEquals((await json(settingsResponse)).defaultApprovalCreditMicros, 6_750_001);

  const approval = await app.request(`/api/admin/users/${applicant.id}/approval`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "approved",
      expectedVersion: applicant.version,
    }),
  });
  assertEquals(approval.status, 200);
  assertEquals((await json(approval)).balanceMicros, 6_750_001);
});

Deno.test("starting credit configuration cannot exceed the approval contract", () => {
  assertThrows(
    () => createApp({ startingCreditMicros: 1_000_000_001 }),
    Error,
    "between 0 and 1,000,000,000",
  );
});

Deno.test("admin lifecycle HTTP API is paginated, versioned, atomic, and no-store", async () => {
  const { app, repository, applicant, headers } = await fixture();
  const list = await app.request("/api/admin/users?approvalStatus=pending&limit=1", {
    headers: { cookie: headers.cookie },
  });
  assertEquals(list.status, 200);
  assertEquals(list.headers.get("cache-control"), "private, no-store");
  assertEquals(
    list.headers.get("vary")?.split(",").map((value) => value.trim()).includes("Cookie"),
    true,
  );
  const page = await json(list);
  assertEquals(page.data.length, 1);
  assertEquals(page.data[0].id, applicant.id);
  assertEquals(page.data[0].deletedAt, null);
  assertEquals(page.data[0].version, 1);

  const malformed = await app.request("/api/admin/users?limit=101", {
    headers: { cookie: headers.cookie },
  });
  assertEquals(malformed.status, 422);
  const duplicate = await app.request("/api/admin/users?limit=1&limit=2", {
    headers: { cookie: headers.cookie },
  });
  assertEquals(duplicate.status, 422);

  const approval = await app.request(`/api/admin/users/${applicant.id}/approval`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "approved",
      expectedVersion: applicant.version,
      startingCreditMicros: 7_000_000,
    }),
  });
  assertEquals(approval.status, 200);
  const approved = await json(approval);
  assertEquals(approved.version, 2);
  assertEquals(approved.balanceMicros, 7_000_000);
  assertEquals(
    repository.listAudit({ targetId: applicant.id, action: "user.approval.approved" }).data.length,
    1,
  );

  const stale = await app.request(`/api/admin/users/${applicant.id}/state`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      state: "suspended",
      expectedVersion: applicant.version,
      reason: "Stale operation",
    }),
  });
  assertEquals(stale.status, 409);
  assertEquals((await json(stale)).error.code, "version_conflict");
  assertEquals(
    repository.listAudit({ targetId: applicant.id, action: "user.approval.approved" }).data.length,
    1,
  );

  const role = await app.request(`/api/admin/users/${applicant.id}/role`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ role: "admin", expectedVersion: approved.version, reason: "Coverage" }),
  });
  assertEquals(role.status, 200);
  assertEquals((await json(role)).effectiveAdmin, true);
});

Deno.test("admin lifecycle HTTP API enforces origin, recent auth, self protection, and explicit deletion", async () => {
  const { app, admin, applicant, headers, advance } = await fixture();
  const noOrigin = await app.request(`/api/admin/users/${applicant.id}/approval`, {
    method: "PATCH",
    headers: { cookie: headers.cookie, "content-type": "application/json" },
    body: JSON.stringify({ status: "approved", expectedVersion: applicant.version }),
  });
  assertEquals(noOrigin.status, 403);
  assertEquals((await json(noOrigin)).error.code, "invalid_origin");

  const selfDelete = await app.request(`/api/admin/users/${admin.id}/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: admin.version, reason: "Mistake" }),
  });
  assertEquals(selfDelete.status, 403);
  assertEquals((await json(selfDelete)).error.code, "self_action_forbidden");

  const deleted = await app.request(`/api/admin/users/${applicant.id}/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: applicant.version, reason: "Requested deletion" }),
  });
  assertEquals(deleted.status, 200);
  const deletedUser = await json(deleted);
  assertEquals(deletedUser.state, "active");
  assertEquals(typeof deletedUser.deletedAt, "string");

  const restored = await app.request(`/api/admin/users/${applicant.id}/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: deletedUser.version, reason: "Appeal accepted" }),
  });
  assertEquals(restored.status, 200);
  assertEquals((await json(restored)).deletedAt, null);

  advance(11 * 60 * 1_000);
  const staleAuthentication = await app.request(`/api/admin/users/${applicant.id}/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedVersion: deletedUser.version + 1,
      reason: "Requires reauthentication",
    }),
  });
  assertEquals(staleAuthentication.status, 403);
  assertEquals((await json(staleAuthentication)).error.code, "recent_authentication_required");
});
