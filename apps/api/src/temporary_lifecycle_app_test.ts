import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { createApp } from "./app.ts";
import { MemoryRepository } from "@dg-chat/database";

async function body(response: Response) {
  return await response.json() as Record<string, unknown>;
}
async function approvedSession(
  app: ReturnType<typeof createApp>["app"],
  token: string,
  email: string,
) {
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": token },
    body: JSON.stringify({ email, password: "correct horse battery", name: "Owner" }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);
  return { cookie, origin: "http://localhost:5173", "content-type": "application/json" };
}

Deno.test("temporary chats expose expiry and authenticated owner-scoped CAS keep", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({
    repository,
    setupToken: "temporary-route",
    temporaryRetentionDays: 7,
  });
  const headers = await approvedSession(app, "temporary-route", "temporary@example.test");
  const createdResponse = await app.request("/api/conversations", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Private scratch", temporary: true }),
  });
  assertEquals(createdResponse.status, 201);
  const created = await body(createdResponse);
  assertEquals(created.temporary, true);
  assertEquals(
    Date.parse(String(created.temporaryExpiresAt)) - Date.parse(String(created.createdAt)),
    7 * 86_400_000,
  );
  const unauthenticated = await app.request(`/api/conversations/${created.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 0 }),
  });
  assertEquals(unauthenticated.status, 401);
  const malformed = await app.request(`/api/conversations/${created.id}/keep`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: 0, ownerId: "spoofed" }),
  });
  assertEquals(malformed.status, 422);
  const stale = await app.request(`/api/conversations/${created.id}/keep`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assertEquals(stale.status, 409);
  const keptResponse = await app.request(`/api/conversations/${created.id}/keep`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: 0 }),
  });
  assertEquals(keptResponse.status, 200);
  const kept = await body(keptResponse);
  assertEquals({
    temporary: kept.temporary,
    temporaryExpiresAt: kept.temporaryExpiresAt,
    version: kept.version,
  }, {
    temporary: false,
    temporaryExpiresAt: null,
    version: 1,
  });
  assertEquals(
    (await repository.listAudit({ action: "conversation.temporary_kept" })).data.length,
    1,
  );
  const replay = await app.request(`/api/conversations/${created.id}/keep`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assertEquals(replay.status, 409);
});
