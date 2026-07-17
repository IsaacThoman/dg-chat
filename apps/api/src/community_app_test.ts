import { assert, assertEquals, assertExists, assertFalse } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { Buffer } from "node:buffer";
import { createApp } from "./app.ts";

function assertPrivateCommunityHeaders(response: Response) {
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("pragma"), "no-cache");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assert(
    response.headers.get("vary")?.split(",").some((value) =>
      value.trim().toLowerCase() === "cookie"
    ),
  );
}

async function approvedSession(
  app: ReturnType<typeof createApp>["app"],
  setupToken: string,
) {
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": setupToken },
    body: JSON.stringify({
      email: "community-owner@example.test",
      password: "correct horse battery",
      name: "Private owner name",
    }),
  });
  const owner = (await bootstrap.json()).user as { id: string };
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "community-owner@example.test",
      password: "correct horse battery",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return {
    owner,
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
  };
}

Deno.test("community API enforces private approved sessions, consent CAS, and opaque pages", async () => {
  const repository = new MemoryRepository();
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const { app } = createApp({
    repository,
    setupToken: "community-api-test",
    communityCursorSecret: "community-api-test-secret",
    now: () => now,
  });
  const unauthorized = await app.request("/api/community/profile");
  assertEquals(unauthorized.status, 401);
  assertPrivateCommunityHeaders(unauthorized);
  const { owner, headers } = await approvedSession(app, "community-api-test");
  const pendingSignup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({
      email: "pending-community@example.test",
      password: "correct horse battery",
      name: "Pending private name",
    }),
  });
  assertEquals(pendingSignup.status, 201);
  const pendingCookie = pendingSignup.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(pendingCookie);
  const pendingProfile = await app.request("/api/community/profile", {
    headers: { cookie: pendingCookie, origin: "http://localhost:5173" },
  });
  assertEquals(pendingProfile.status, 403);
  assertPrivateCommunityHeaders(pendingProfile);

  const initial = await app.request("/api/community/profile", { headers });
  assertEquals(initial.status, 200);
  assertPrivateCommunityHeaders(initial);
  assertEquals((await initial.json()).optedIn, false);

  const updatedResponse = await app.request("/api/community/profile", {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedVersion: 1,
      optedIn: true,
      identityMode: "nickname",
      nickname: "Community-owner",
      color: "violet",
    }),
  });
  assertEquals(updatedResponse.status, 200);
  assertPrivateCommunityHeaders(updatedResponse);
  assertEquals((await updatedResponse.json()).version, 2);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Community forbidden token", scopes: ["models:read"] }),
  });
  assertEquals(tokenResponse.status, 201);
  const apiToken = (await tokenResponse.json()).token;
  const tokenLeaderboard = await app.request("/api/community/leaderboard", {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assertEquals(tokenLeaderboard.status, 403);
  assertPrivateCommunityHeaders(tokenLeaderboard);
  const stale = await app.request("/api/community/profile", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: 1, color: "blue" }),
  });
  assertEquals(stale.status, 409);
  assertPrivateCommunityHeaders(stale);
  assertEquals((await stale.json()).error.code, "version_conflict");

  const optedOut = await app.request("/api/community/profile", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: 2, optedIn: false }),
  });
  assertEquals(optedOut.status, 200);
  const invalidMergedState = await app.request("/api/community/profile", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: 3, shareBalance: true }),
  });
  assertEquals(invalidMergedState.status, 422);
  assertEquals((await invalidMergedState.json()).error.code, "validation_error");
  await app.request("/api/community/profile", {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedVersion: 3,
      optedIn: true,
      identityMode: "nickname",
      nickname: "Community-owner",
    }),
  });

  const anonymous = repository.createUser({
    id: "20000000-0000-4000-8000-000000000002",
    email: "private-anonymous@example.test",
    name: "Private Anonymous",
    approvalStatus: "approved",
  });
  repository.updateCommunityProfile(
    anonymous.id,
    { expectedVersion: 1, optedIn: true, color: "blue" },
    { actorId: anonymous.id },
  );

  const first = await app.request(
    "/api/community/leaderboard?metric=calls&window=7d&limit=1",
    { headers },
  );
  assertEquals(first.status, 200);
  assertPrivateCommunityHeaders(first);
  const firstPage = await first.json();
  assertEquals(firstPage.data.length, 1);
  assertExists(firstPage.nextCursor);
  const serialized = JSON.stringify(firstPage);
  assertFalse(serialized.includes(owner.id));
  assertFalse(serialized.includes(anonymous.id));
  assertFalse(serialized.includes("private-anonymous"));
  const cursorBytes = Buffer.from(firstPage.nextCursor, "base64url").toString("utf8");
  assertFalse(cursorBytes.includes(owner.id));
  assertFalse(cursorBytes.includes(anonymous.id));

  const second = await app.request(
    `/api/community/leaderboard?metric=calls&window=7d&limit=1&cursor=${
      encodeURIComponent(firstPage.nextCursor)
    }`,
    { headers },
  );
  assertEquals(second.status, 200);
  const secondPage = await second.json();
  assertEquals(secondPage.data[0].position, 1);
  const anonymousRow = [...firstPage.data, ...secondPage.data].find((row) =>
    row.identityMode === "anonymous"
  );
  assertEquals(anonymousRow?.nickname, null);
  assertEquals(anonymousRow?.color, null);
  assertEquals(
    (await app.request(
      `/api/community/leaderboard?metric=tokens&window=7d&cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
      { headers },
    )).status,
    422,
  );
  assertEquals(
    (await app.request("/api/community/leaderboard?metric=balance&window=7d", { headers })).status,
    422,
  );
  assertEquals(
    (await app.request("/api/community/leaderboard?limit=1&limit=2", { headers })).status,
    422,
  );
  assertEquals(
    (await app.request("/api/community/leaderboard?unknown=true", { headers })).status,
    422,
  );
  assert(
    (await app.request(
      `/api/community/leaderboard?metric=calls&window=7d&cursor=${
        firstPage.nextCursor.slice(0, 16)
      }${firstPage.nextCursor[16] === "A" ? "B" : "A"}${firstPage.nextCursor.slice(17)}`,
      { headers },
    )).status === 422,
  );
  const ninetyDays = await app.request(
    "/api/community/leaderboard?metric=calls&window=90d&limit=100",
    {
      headers,
    },
  );
  assertEquals(ninetyDays.status, 200);
  assertEquals(typeof (await ninetyDays.json()).from, "string");
  for (const limit of ["1e2", "+25", "025", "0", "101"]) {
    const invalidLimit = await app.request(
      `/api/community/leaderboard?limit=${encodeURIComponent(limit)}`,
      { headers },
    );
    assertEquals(invalidLimit.status, 422);
    assertPrivateCommunityHeaders(invalidLimit);
  }
});
