import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import type { AuditEventInput } from "@dg-chat/database";
import { createApp } from "./app.ts";

class FailingAccessGroupAuditRepository extends MemoryRepository {
  failAction: string | null = null;

  override recordAudit(input: AuditEventInput) {
    if (input.action === this.failAction) throw new Error("injected access-group audit failure");
    return super.recordAudit(input);
  }
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("access-group HTTP mutations never outlive a failed mandatory audit", async () => {
  const repository = new FailingAccessGroupAuditRepository();
  const { app } = createApp({
    repository,
    setupToken: "access-group-audit-atomicity",
    requestErrorLogSink: () => undefined,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "access-group-audit-atomicity",
    },
    body: JSON.stringify({
      email: "access-group-http@example.test",
      password: "correct horse battery staple",
      name: "Access group HTTP admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "access-group-http@example.test",
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const actor = repository.findUserByEmail("access-group-http@example.test")!;
  const readContext = {
    actorId: actor.id,
    requireEmailVerification: false,
    expectedAuthorityEpoch: actor.authorityEpoch,
  };

  repository.failAction = "model_access_group.created";
  const failedCreate = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Must roll back" }),
  });
  assertEquals(failedCreate.status, 500);
  assertEquals(repository.listAccessGroups(readContext), []);

  repository.failAction = null;
  const createdResponse = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Durable", description: "before" }),
  });
  assertEquals(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json();

  const duplicateCreate = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "durable" }),
  });
  assertEquals(duplicateCreate.status, 409, await duplicateCreate.clone().text());

  const secondResponse = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Second" }),
  });
  assertEquals(secondResponse.status, 201, await secondResponse.clone().text());
  const second = await secondResponse.json();
  const duplicateUpdate = await app.request(`/api/admin/model-access/groups/${second.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: second.version, name: "DURABLE" }),
  });
  assertEquals(duplicateUpdate.status, 409, await duplicateUpdate.clone().text());
  assertEquals((await duplicateUpdate.json()).error.code, "conflict");
  assertEquals(
    repository.listAccessGroups(readContext).find((group) => group.id === second.id),
    second,
  );

  const noOpUpdate = await app.request(`/api/admin/model-access/groups/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: created.version }),
  });
  assertEquals(noOpUpdate.status, 422, await noOpUpdate.clone().text());
  assertEquals(repository.listAccessGroups(readContext)[0], created);

  repository.failAction = "model_access_group.updated";
  const failedUpdate = await app.request(`/api/admin/model-access/groups/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedVersion: created.version,
      name: "Must not persist",
      description: "must not persist",
    }),
  });
  assertEquals(failedUpdate.status, 500);
  assertEquals(repository.listAccessGroups(readContext)[0], created);
  assertEquals(
    repository.auditEvents.filter((event) =>
      event.action === "model_access_group.created" ||
      event.action === "model_access_group.updated"
    ).map((event) => event.action),
    ["model_access_group.created", "model_access_group.created"],
  );
});
