import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { createApp } from "./app.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function cookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("knowledge API lifecycle, versions, deleted parents, and owner isolation", async () => {
  const { app, repository } = createApp({ setupToken: "knowledge-setup" });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "knowledge-setup" },
    body: JSON.stringify({
      email: "knowledge-admin@example.com",
      password: "correct horse battery",
      name: "Knowledge Admin",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const adminLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "knowledge-admin@example.com",
      password: "correct horse battery",
    }),
  });
  const admin = (await json(adminLogin)).user;
  const adminHeaders = {
    cookie: cookie(adminLogin),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  const create = await app.request("/api/collections", {
    method: "POST",
    headers: { ...adminHeaders, "idempotency-key": "knowledge-api-docs-1" },
    body: JSON.stringify({ name: "Docs", description: "Reference material" }),
  });
  assertEquals(create.status, 201);
  assertEquals(create.headers.get("cache-control"), "private, no-store");
  const collection = await json(create);
  assertEquals(collection.version, 1);
  assertEquals(collection.ownerId, undefined);
  const replay = await app.request("/api/collections", {
    method: "POST",
    headers: { ...adminHeaders, "idempotency-key": "knowledge-api-docs-1" },
    body: JSON.stringify({ name: "Docs", description: "Reference material" }),
  });
  assertEquals((await json(replay)).id, collection.id);
  assertEquals(
    (await app.request("/api/collections/not-a-uuid", { headers: adminHeaders })).status,
    422,
  );

  const attachment = await repository.createAttachment({
    ownerId: admin.id,
    objectKey: `users/${admin.id}/knowledge-api.txt`,
    filename: "knowledge-api.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    sha256: "a".repeat(64),
    state: "ready",
  });
  const linkedResponse = await app.request(
    `/api/collections/${collection.id}/attachments/${attachment.attachment.id}`,
    { method: "POST", headers: adminHeaders, body: JSON.stringify({ expectedVersion: 1 }) },
  );
  assertEquals(linkedResponse.status, 200);
  const linkedPayload = await json(linkedResponse);
  assertEquals(linkedPayload.collection.version, 2);
  assertEquals(linkedPayload.collection.attachmentCount, 1);
  const detail = await app.request(`/api/collections/${collection.id}`, {
    headers: adminHeaders,
  });
  assertEquals((await json(detail)).attachments[0].id, attachment.attachment.id);
  const staleUnlink = await app.request(
    `/api/collections/${collection.id}/attachments/${attachment.attachment.id}`,
    { method: "DELETE", headers: adminHeaders, body: JSON.stringify({ expectedVersion: 1 }) },
  );
  assertEquals(staleUnlink.status, 409);
  assertEquals((await json(staleUnlink)).error.code, "version_conflict");

  const conversationResponse = await app.request("/api/conversations", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ title: "Knowledge conversation" }),
  });
  const conversation = await json(conversationResponse);
  const bind = await app.request(`/api/conversations/${conversation.id}/knowledge`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ collectionIds: [collection.id], mode: "retrieval" }),
  });
  assertEquals(bind.status, 200);
  assertEquals((await json(bind)).bindings[0].version, 1);
  const changed = await app.request(
    `/api/conversations/${conversation.id}/knowledge/${collection.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ mode: "full_context", expectedVersion: 1 }),
    },
  );
  assertEquals((await json(changed)).binding.version, 2);

  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "knowledge-other@example.com",
      password: "correct horse battery",
      name: "Other User",
    }),
  });
  const other = (await json(signup)).user;
  await repository.decideUserApproval({
    actorId: admin.id,
    expectedAuthorityEpoch: 1,
    targetUserId: other.id,
    expectedVersion: other.version,
    status: "approved",
    startingCreditMicros: 5_000_000,
  });
  const otherLogin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "knowledge-other@example.com",
      password: "correct horse battery",
    }),
  });
  const otherHeaders = {
    cookie: cookie(otherLogin),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  assertEquals(
    (await app.request(`/api/collections/${collection.id}`, { headers: otherHeaders })).status,
    404,
  );
  const otherConversation = await json(
    await app.request("/api/conversations", {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ title: "Other conversation" }),
    }),
  );
  const crossOwnerBind = await app.request(
    `/api/conversations/${otherConversation.id}/knowledge`,
    {
      method: "PUT",
      headers: otherHeaders,
      body: JSON.stringify({ collectionIds: [collection.id], mode: "retrieval" }),
    },
  );
  assertEquals(crossOwnerBind.status, 404);

  const unlink = await app.request(
    `/api/collections/${collection.id}/attachments/${attachment.attachment.id}`,
    { method: "DELETE", headers: adminHeaders, body: JSON.stringify({ expectedVersion: 2 }) },
  );
  const unlinkedPayload = await json(unlink);
  assertEquals(unlinkedPayload.collection.version, 3);
  assertEquals(unlinkedPayload.collection.attachmentCount, 0);
  const updated = await app.request(`/api/collections/${collection.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ name: "Updated docs", expectedVersion: 3 }),
  });
  assertEquals((await json(updated)).version, 4);
  const staleDelete = await app.request(`/api/collections/${collection.id}`, {
    method: "DELETE",
    headers: adminHeaders,
    body: JSON.stringify({ expectedVersion: 3 }),
  });
  assertEquals(staleDelete.status, 409);
  const deleted = await app.request(`/api/collections/${collection.id}`, {
    method: "DELETE",
    headers: adminHeaders,
    body: JSON.stringify({ expectedVersion: 4 }),
  });
  assertEquals(deleted.status, 204);
  const deletedReplay = await app.request("/api/collections", {
    method: "POST",
    headers: { ...adminHeaders, "idempotency-key": "knowledge-api-docs-1" },
    body: JSON.stringify({ name: "Docs", description: "Reference material" }),
  });
  assertEquals(deletedReplay.status, 409);
  assertEquals((await json(deletedReplay)).error.code, "idempotency_conflict");
  assertEquals(
    (await app.request(`/api/collections/${collection.id}`, { headers: adminHeaders })).status,
    404,
  );
  const deletedParentBind = await app.request(`/api/conversations/${conversation.id}/knowledge`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ collectionIds: [collection.id], mode: "retrieval" }),
  });
  assertEquals(deletedParentBind.status, 404);
});
