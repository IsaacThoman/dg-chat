import { assert, assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import { hashPassword } from "./crypto.ts";

Deno.test("an admitted stale browser request cannot mint a token after authority restoration", async () => {
  const repository = new MemoryRepository();
  const actor = repository.bootstrapAdmin({
    email: "epoch-route-admin@example.com",
    name: "Epoch route admin",
    passwordHash: await hashPassword("admin password for testing"),
  }, 0);
  const target = repository.createUser({
    email: "epoch-route-user@example.com",
    name: "Epoch route user",
    passwordHash: await hashPassword("user password for testing"),
    approvalStatus: "approved",
    emailVerified: true,
  });
  let managed = repository.getAdminUser(target.id);
  const { app } = createApp({ repository, requireEmailVerification: false });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({
      email: target.email,
      password: "user password for testing",
    }),
  });
  assertEquals(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);

  const createToken = repository.createApiToken.bind(repository);
  repository.createApiToken = (userId, input, expectedAuthorityEpoch) => {
    managed = repository.setAdminUserState({
      actorId: actor.id,
      expectedAuthorityEpoch: 1,
      targetUserId: target.id,
      expectedVersion: managed.version,
      state: "suspended",
      reason: "Advance authority after middleware admission",
    });
    managed = repository.setAdminUserState({
      actorId: actor.id,
      expectedAuthorityEpoch: 1,
      targetUserId: target.id,
      expectedVersion: managed.version,
      state: "active",
      reason: "Restore after middleware admission",
    });
    return createToken(userId, input, expectedAuthorityEpoch);
  };

  const response = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Must not exist", scopes: ["models:read"] }),
  });
  assertEquals(response.status, 403);
  assertEquals(
    (await response.json() as { error: { code: string } }).error.code,
    "account_unavailable",
  );
  assertEquals(repository.listApiTokens(target.id).length, 0);
});

Deno.test("authority epochs never cross public user or personal-token projections", async () => {
  const repository = new MemoryRepository();
  const user = repository.bootstrapAdmin({
    email: "epoch-projection@example.com",
    name: "Epoch projection",
    passwordHash: await hashPassword("projection password for testing"),
  }, 0);
  const { app } = createApp({ repository, requireEmailVerification: false });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({
      email: user.email,
      password: "projection password for testing",
    }),
  });
  const loginBody = await login.clone().json() as { user: Record<string, unknown> };
  assert(!("authorityEpoch" in loginBody.user));
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  const headers = {
    cookie,
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const me = await app.request("/api/auth/me", { headers: { cookie } });
  const meBody = await me.json() as { user: Record<string, unknown> };
  assert(!("authorityEpoch" in meBody.user));

  const createdResponse = await app.request("/api/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Projection token", scopes: ["models:read"] }),
  });
  assertEquals(createdResponse.status, 201);
  const created = await createdResponse.json() as Record<string, unknown> & {
    id: string;
    version: number;
  };
  assert(!("authorityEpoch" in created));
  const listed = await (await app.request("/api/tokens", { headers: { cookie } })).json() as {
    data: Array<Record<string, unknown>>;
  };
  assertEquals(listed.data.length, 1);
  assert(!("authorityEpoch" in listed.data[0]));
  assert(!("authorityEpoch" in repository.listApiTokens(user.id)[0]));

  const rotatedResponse = await app.request(`/api/tokens/${created.id}/rotate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: created.version, overlapSeconds: 0 }),
  });
  assertEquals(rotatedResponse.status, 201, await rotatedResponse.clone().text());
  const rotated = await rotatedResponse.json() as {
    previous: Record<string, unknown>;
    replacement: Record<string, unknown>;
  };
  assert(!("authorityEpoch" in rotated));
  assert(!("authorityEpoch" in rotated.previous));
  assert(!("authorityEpoch" in rotated.replacement));
});
