import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { hashPassword, sha256 } from "./crypto.ts";
import { TestIdentityMailer } from "./mail.ts";
import type { RateLimiter } from "./rate-limit.ts";

function assertPrivateCookieResponse(response: Response): void {
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("pragma"), "no-cache");
  const vary = (response.headers.get("vary") ?? "").split(",").map((value) => value.trim());
  assertEquals(vary.includes("Cookie"), true);
}

Deno.test("identity, session, and token responses are private and never cacheable", async () => {
  const setupToken = "cache-policy-setup-token";
  const { app } = createApp({ setupToken });
  const rejectedBootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "wrong-cache-policy-setup-token",
    },
    body: JSON.stringify({
      email: "cache-policy@example.test",
      name: "Cache policy",
      password: "correct horse battery",
    }),
  });
  assertEquals(rejectedBootstrap.status, 401);
  assertEquals(rejectedBootstrap.headers.get("cache-control"), "private, no-store");
  assertEquals(rejectedBootstrap.headers.get("pragma"), "no-cache");
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": setupToken,
    },
    body: JSON.stringify({
      email: "cache-policy@example.test",
      name: "Cache policy",
      password: "correct horse battery",
    }),
  });
  assertEquals(bootstrap.status, 201);
  assertEquals(bootstrap.headers.get("cache-control"), "private, no-store");
  assertEquals(bootstrap.headers.get("pragma"), "no-cache");
  const setupStatus = await app.request("/api/setup/status");
  assertEquals(setupStatus.headers.get("cache-control"), "private, no-store");
  assertEquals(setupStatus.headers.get("pragma"), "no-cache");
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "cache-policy@example.test",
      password: "correct horse battery",
    }),
  });
  assertEquals(login.status, 200);
  assertPrivateCookieResponse(login);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);

  for (
    const response of [
      await app.request("/api/auth/me", { headers: { cookie } }),
      await app.request("/api/auth/status", { headers: { cookie } }),
      await app.request("/api/sessions", { headers: { cookie } }),
      await app.request("/api/tokens", { headers: { cookie } }),
      await app.request("/api/auth/me"),
      await app.request("/api/sessions"),
      await app.request("/api/tokens"),
    ]
  ) {
    assertPrivateCookieResponse(response);
  }

  const created = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "One-time secret", scopes: ["models:read"] }),
  });
  assertEquals(created.status, 201);
  assertPrivateCookieResponse(created);
  const token = await created.json() as { id: string; token: string; version: number };
  assertEquals(token.token.startsWith("dg_"), true);

  const rotated = await app.request(`/api/tokens/${token.id}/rotate`, {
    method: "POST",
    headers: {
      cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedVersion: token.version, overlapSeconds: 0 }),
  });
  assertEquals(rotated.status, 201);
  assertPrivateCookieResponse(rotated);
});

Deno.test("credential cache policy survives early middleware and unmatched routes", async () => {
  const deniedRateLimiter: RateLimiter = {
    implementation: "custom",
    consume: () =>
      Promise.resolve({
        allowed: false,
        limit: 1,
        remaining: 0,
        retryAfterSeconds: 30,
      }),
    health: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  const denied = createApp({ rateLimiter: deniedRateLimiter }).app;
  const rateLimited = await denied.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cache@example.test", password: "password" }),
  });
  assertEquals(rateLimited.status, 429);
  assertPrivateCookieResponse(rateLimited);

  const { app } = createApp();
  const oversized = await app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(3 * 1024 * 1024),
    },
    body: "{}",
  });
  assertEquals(oversized.status, 413);
  assertPrivateCookieResponse(oversized);

  const preflight = await app.request("/api/auth/login", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
    },
  });
  assertEquals(preflight.status, 204);
  assertPrivateCookieResponse(preflight);

  const missing = await app.request("/api/auth/not-a-route");
  assertEquals(missing.status, 404);
  assertPrivateCookieResponse(missing);
});

Deno.test("rejected legacy identities cannot request or consume password resets", async () => {
  const repository = new MemoryRepository();
  const administrator = repository.bootstrapAdmin({
    email: "legacy-reset-admin@example.test",
    name: "Legacy reset admin",
    passwordHash: await hashPassword("administrator password"),
  }, 0);
  const applicant = repository.createUser({
    email: "legacy-reset-applicant@example.test",
    name: "Legacy reset applicant",
    passwordHash: await hashPassword("applicant password"),
  });
  const resetToken = "reset_legacy_rejection_regression";
  await repository.createIdentityToken(
    applicant.id,
    "password_reset",
    await sha256(resetToken),
    new Date(Date.now() + 60_000).toISOString(),
    applicant.authorityEpoch,
  );
  repository.decideUserApproval({
    actorId: administrator.id,
    expectedAuthorityEpoch: 1,
    targetUserId: applicant.id,
    expectedVersion: applicant.version,
    status: "rejected",
    startingCreditMicros: 0,
    reason: "Exercise rejected reset authority",
  });
  const mailer = new TestIdentityMailer();
  const { app, drainIdentityDeliveries } = createApp({ repository, mailer });

  const request = await app.request("/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: applicant.email }),
  });
  assertEquals(request.status, 202);
  await drainIdentityDeliveries();
  assertEquals(mailer.messages, []);

  const consume = await app.request("/api/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: resetToken, password: "replacement password" }),
  });
  assertEquals(consume.status, 400);
  assertEquals(
    (await consume.json() as { error: { code: string } }).error.code,
    "invalid_identity_token",
  );
});
