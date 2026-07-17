import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import { type AuditEventInput, MemoryRepository, type StoredUser } from "@dg-chat/database";
import { createApp } from "./app.ts";
import type { BetterAuthService } from "./better-auth.ts";
import { hashPassword, sha256, verifyPassword } from "./crypto.ts";

class FaultingIdentityAuditRepository extends MemoryRepository {
  readonly failedActions = new Set<string>();

  override recordAudit(input: AuditEventInput) {
    if (this.failedActions.has(input.action)) {
      throw new Error("audit-private-payload-secret");
    }
    return super.recordAudit(input);
  }
}

class BetterAuthResetFaultRepository extends FaultingIdentityAuditRepository {
  override resetBetterAuthPassword(_token: string, passwordHash: string): StoredUser {
    return this.resetPassword("better-auth-reset-stage", passwordHash);
  }
}

const jsonHeaders = { "content-type": "application/json" };

Deno.test("bootstrap audit failure rolls the complete setup transaction back", async () => {
  const repository = new FaultingIdentityAuditRepository();
  repository.failedActions.add("identity.bootstrap_admin");
  const errorLogs: string[] = [];
  const { app } = createApp({
    repository,
    setupToken: "audit-atomic-bootstrap",
    requestErrorLogSink: (line) => errorLogs.push(line),
  });
  const request = () =>
    app.request("/api/setup/bootstrap", {
      method: "POST",
      headers: { ...jsonHeaders, "x-setup-token": "audit-atomic-bootstrap" },
      body: JSON.stringify({
        email: "atomic-bootstrap@example.test",
        name: "Atomic bootstrap",
        password: "correct horse battery",
      }),
    });

  assertEquals((await request()).status, 500);
  assertEquals(repository.listUsers(), []);
  assertEquals(repository.ledger, []);
  assertEquals(repository.auditEvents, []);
  assertEquals(errorLogs.join("\n").includes("audit-private-payload-secret"), false);

  repository.failedActions.clear();
  assertEquals((await request()).status, 201);
  assertEquals(repository.listUsers().length, 1);
  assertEquals(
    repository.auditEvents.map((event) => event.action),
    ["identity.bootstrap_admin"],
  );
});

Deno.test("verification and legacy password reset audit failures roll authority back for retry", async () => {
  const repository = new FaultingIdentityAuditRepository();
  const verificationUser = repository.createUser({
    email: "atomic-verification@example.test",
    name: "Atomic verification",
    passwordHash: await hashPassword("original verification password"),
  });
  const verificationToken = "verify_atomic_audit_failure_token_0001";
  repository.createIdentityToken(
    verificationUser.id,
    "email_verification",
    await sha256(verificationToken),
    new Date(Date.now() + 60_000).toISOString(),
    verificationUser.authorityEpoch,
  );
  const resetUser = repository.createUser({
    email: "atomic-reset@example.test",
    name: "Atomic reset",
    passwordHash: await hashPassword("original reset password"),
    approvalStatus: "approved",
  });
  const resetToken = "reset_atomic_audit_failure";
  repository.createIdentityToken(
    resetUser.id,
    "password_reset",
    await sha256(resetToken),
    new Date(Date.now() + 60_000).toISOString(),
    resetUser.authorityEpoch,
  );
  const originalResetEpoch = resetUser.authorityEpoch;
  const originalResetHash = resetUser.passwordHash!;
  const { app } = createApp({ repository, requestErrorLogSink: () => undefined });

  repository.failedActions.add("identity.email_verified");
  assertEquals(
    (await app.request("/api/auth/verify-email", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ token: verificationToken }),
    })).status,
    500,
  );
  assertEquals(repository.findUser(verificationUser.id)?.emailVerifiedAt, null);
  repository.failedActions.delete("identity.email_verified");
  assertEquals(
    (await app.request("/api/auth/verify-email", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ token: verificationToken }),
    })).status,
    200,
  );

  repository.failedActions.add("identity.password_reset_completed");
  assertEquals(
    (await app.request("/api/auth/password-reset", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ token: resetToken, password: "replacement reset password" }),
    })).status,
    500,
  );
  assertEquals(repository.findUser(resetUser.id)?.authorityEpoch, originalResetEpoch);
  assertEquals(repository.findUser(resetUser.id)?.passwordHash, originalResetHash);
  repository.failedActions.delete("identity.password_reset_completed");
  assertEquals(
    (await app.request("/api/auth/password-reset", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ token: resetToken, password: "replacement reset password" }),
    })).status,
    204,
  );
  assert(
    await verifyPassword(
      "replacement reset password",
      repository.findUser(resetUser.id)?.passwordHash ?? "",
    ),
  );
});

Deno.test("legacy signup and login outcomes remain truthful when best-effort audit fails", async () => {
  const repository = new FaultingIdentityAuditRepository();
  const errorLogs: string[] = [];
  const { app } = createApp({
    repository,
    requestErrorLogSink: (line) => errorLogs.push(line),
  });
  repository.failedActions.add("identity.signup");
  const signup = await app.request("/api/auth/register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      email: "best-effort-signup@example.test",
      name: "Best effort signup",
      password: "correct horse battery",
    }),
  });
  assertEquals(signup.status, 201);
  assert(signup.headers.get("set-cookie"));

  const user = repository.findUserByEmail("best-effort-signup@example.test")!;
  repository.failedActions.delete("identity.signup");
  repository.failedActions.add("identity.login_succeeded");
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      email: user.email,
      password: "correct horse battery",
    }),
  });
  assertEquals(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie);

  repository.failedActions.add("identity.login_failed");
  assertEquals(
    (await app.request("/api/auth/login", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email: user.email, password: "incorrect password" }),
    })).status,
    401,
  );
  repository.failedActions.add("session.signed_out");
  const signOut = await app.request("/api/auth/sign-out", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:5173" },
  });
  assertEquals(signOut.status, 204);
  assertEquals(
    repository.listSessions(user.id).filter((session) => session.invalidatedAt === null).length,
    1,
  );
  assertEquals(errorLogs.join("\n").includes("audit-private-payload-secret"), false);
});

Deno.test("Better Auth product password reset completion is transactionally audited", async () => {
  const repository = new BetterAuthResetFaultRepository();
  const user = repository.createUser({
    email: "better-auth-atomic-reset@example.test",
    name: "Better Auth atomic reset",
    approvalStatus: "approved",
  });
  repository.createIdentityToken(
    user.id,
    "password_reset",
    "better-auth-reset-stage",
    new Date(Date.now() + 60_000).toISOString(),
    user.authorityEpoch,
  );
  const browserAuth = {} as BetterAuthService;
  const { app } = createApp({
    repository,
    browserAuth,
    requestErrorLogSink: () => undefined,
  });
  const request = () =>
    app.request("/api/auth/password-reset", {
      method: "POST",
      headers: { ...jsonHeaders, origin: "http://localhost:5173" },
      body: JSON.stringify({
        token: "better-auth-product-reset-token",
        password: "replacement Better Auth password",
      }),
    });

  repository.failedActions.add("identity.password_reset_completed");
  assertEquals((await request()).status, 500);
  assertEquals(repository.findUser(user.id)?.authorityEpoch, user.authorityEpoch);
  repository.failedActions.clear();
  assertEquals((await request()).status, 204);
  assertEquals(
    repository.auditEvents.map((event) => event.action),
    ["identity.password_reset_completed"],
  );
});
