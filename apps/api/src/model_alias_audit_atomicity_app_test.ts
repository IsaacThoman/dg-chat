import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import type { AuditEventInput } from "@dg-chat/database";
import { createApp } from "./app.ts";

class FailingModelAliasAuditRepository extends MemoryRepository {
  failAction: string | null = null;

  override recordAudit(input: AuditEventInput) {
    if (input.action === this.failAction) throw new Error("injected model-alias audit failure");
    return super.recordAudit(input);
  }
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

async function fixture() {
  const repository = new FailingModelAliasAuditRepository();
  const { app } = createApp({
    repository,
    setupToken: "model-alias-audit-http",
    requestErrorLogSink: () => undefined,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "model-alias-audit-http",
    },
    body: JSON.stringify({
      email: "model-alias-http@example.test",
      password: "correct horse battery staple",
      name: "Model alias HTTP admin",
    }),
  });
  const actor = repository.findUserByEmail("model-alias-http@example.test")!;
  const now = new Date().toISOString();
  const modelId = crypto.randomUUID();
  repository.providerModels.set(modelId, {
    id: modelId,
    providerId: crypto.randomUUID(),
    publicModelId: "canonical/model",
    upstreamModelId: "canonical-upstream",
    displayName: "Canonical model",
    capabilities: ["chat"],
    contextWindow: 4_096,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: actor.email,
      password: "correct horse battery staple",
    }),
  });
  return {
    app,
    repository,
    actor,
    modelId,
    headers: {
      cookie: cookie(login),
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
  };
}

Deno.test("model-alias HTTP mutations roll back when mandatory audit insertion fails", async () => {
  const { app, repository, modelId, headers } = await fixture();

  repository.failAction = "model_alias.created";
  const failedCreate = await app.request("/api/admin/model-access/aliases", {
    method: "POST",
    headers,
    body: JSON.stringify({ alias: "must-not-exist", targetModelId: modelId }),
  });
  assertEquals(failedCreate.status, 500);
  assertEquals(repository.listModelAliases(), []);

  repository.failAction = null;
  const createdResponse = await app.request("/api/admin/model-access/aliases", {
    method: "POST",
    headers,
    body: JSON.stringify({
      alias: "durable/alias",
      targetModelId: modelId,
      description: "before",
    }),
  });
  assertEquals(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json();

  repository.failAction = "model_alias.updated";
  const failedUpdate = await app.request(`/api/admin/model-access/aliases/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedVersion: created.version,
      alias: "must-not-persist",
    }),
  });
  assertEquals(failedUpdate.status, 500);
  assertEquals(repository.listModelAliases(), [created]);

  repository.failAction = "model_alias.deleted";
  const failedDelete = await app.request(`/api/admin/model-access/aliases/${created.id}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedVersion: created.version }),
  });
  assertEquals(failedDelete.status, 500);
  assertEquals(repository.listModelAliases(), [created]);
  assertEquals(
    repository.auditEvents.filter((event) => event.action.startsWith("model_alias.")).map(
      (event) => event.action,
    ),
    ["model_alias.created"],
  );
});

Deno.test("admitted model-alias HTTP mutations reject stale authority across every operation", async () => {
  const { app, repository, actor, modelId, headers } = await fixture();
  const createdResponse = await app.request("/api/admin/model-access/aliases", {
    method: "POST",
    headers,
    body: JSON.stringify({ alias: "durable/alias", targetModelId: modelId }),
  });
  assertEquals(createdResponse.status, 201);
  const created = await createdResponse.json();
  const original = structuredClone(created);

  const originalCreate = repository.createModelAlias.bind(repository);
  repository.createModelAlias = (input, audit) => {
    repository.users.get(actor.id)!.authorityEpoch++;
    return originalCreate(input, audit);
  };
  const staleCreate = await app.request("/api/admin/model-access/aliases", {
    method: "POST",
    headers,
    body: JSON.stringify({ alias: "stale-create", targetModelId: modelId }),
  });
  assertEquals(staleCreate.status, 403, await staleCreate.clone().text());
  assertEquals((await staleCreate.json()).error.code, "admin_authority_required");
  repository.createModelAlias = originalCreate;
  repository.users.get(actor.id)!.authorityEpoch = 1;

  const originalUpdate = repository.updateModelAlias.bind(repository);
  repository.updateModelAlias = (id, input, audit) => {
    repository.users.get(actor.id)!.authorityEpoch++;
    return originalUpdate(id, input, audit);
  };
  const staleUpdate = await app.request(`/api/admin/model-access/aliases/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedVersion: created.version, alias: "stale-update" }),
  });
  assertEquals(staleUpdate.status, 403, await staleUpdate.clone().text());
  assertEquals((await staleUpdate.json()).error.code, "admin_authority_required");
  repository.updateModelAlias = originalUpdate;
  repository.users.get(actor.id)!.authorityEpoch = 1;

  const originalDelete = repository.deleteModelAlias.bind(repository);
  repository.deleteModelAlias = (id, expectedVersion, audit) => {
    repository.users.get(actor.id)!.authorityEpoch++;
    return originalDelete(id, expectedVersion, audit);
  };
  const staleDelete = await app.request(`/api/admin/model-access/aliases/${created.id}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedVersion: created.version }),
  });
  assertEquals(staleDelete.status, 403, await staleDelete.clone().text());
  assertEquals((await staleDelete.json()).error.code, "admin_authority_required");
  repository.deleteModelAlias = originalDelete;
  repository.users.get(actor.id)!.authorityEpoch = 1;

  assertEquals(repository.listModelAliases(), [original]);
  assertEquals(
    repository.auditEvents.filter((event) => event.action.startsWith("model_alias.")).map(
      (event) => event.action,
    ),
    ["model_alias.created"],
  );
});
