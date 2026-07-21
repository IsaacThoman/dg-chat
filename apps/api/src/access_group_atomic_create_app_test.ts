import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

Deno.test("POST access group creates its initial policy in one operation", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({
    repository,
    setupToken: "atomic-group-create-http",
    requestErrorLogSink: () => undefined,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "atomic-group-create-http",
    },
    body: JSON.stringify({
      email: "atomic-group-http@example.test",
      password: "correct horse battery staple",
      name: "Atomic group HTTP administrator",
    }),
  });
  const actor = repository.findUserByEmail("atomic-group-http@example.test")!;
  const now = new Date().toISOString();
  const modelId = crypto.randomUUID();
  repository.providerModels.set(modelId, {
    id: modelId,
    providerId: crypto.randomUUID(),
    publicModelId: "atomic/http",
    upstreamModelId: "atomic-http",
    displayName: "Atomic HTTP",
    capabilities: ["chat"],
    contextWindow: 4_096,
    enabled: true,
    version: 1,
    customParams: {},
    createdAt: now,
    updatedAt: now,
  });
  const original = repository.createApiToken(actor.id, {
    name: "HTTP family",
    scopes: ["models:read"],
    tokenHash: "atomic-http-old",
    preview: "dg_http_old",
  }, actor.authorityEpoch);
  const rotated = repository.rotateApiToken(actor.id, original.id, {
    expectedVersion: original.version,
    tokenHash: "atomic-http-new",
    preview: "dg_http_new",
    overlapSeconds: 60,
  }, actor.authorityEpoch);
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: actor.email,
      password: "correct horse battery staple",
    }),
  });
  const headers = {
    cookie: cookie(login),
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };

  const response = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "HTTP initial policy",
      userIds: [actor.id],
      modelIds: [modelId],
      tokenIds: [rotated.replacement.id],
    }),
  });
  assertEquals(response.status, 201, await response.clone().text());
  const created = await response.json();
  assertEquals(created.version, 1);
  assertEquals(created.userIds, [actor.id]);
  assertEquals(created.modelIds, [modelId]);
  assertEquals(
    [...created.tokenIds].sort(),
    [original.id, rotated.replacement.id].sort(),
  );
  const event = repository.auditEvents.at(-1)!;
  assertEquals(event.action, "model_access_group.created");
  assertEquals(event.metadata?.userCount, 1);
  assertEquals(event.metadata?.modelCount, 1);
  assertEquals(event.metadata?.tokenCount, 1);

  const invalid = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Owner omitted",
      tokenIds: [original.id],
    }),
  });
  assertEquals(invalid.status, 422, await invalid.clone().text());
  assertEquals((await invalid.json()).error.code, "validation_error");
  assertEquals(
    repository.listAccessGroups({
      actorId: actor.id,
      requireEmailVerification: false,
      expectedAuthorityEpoch: actor.authorityEpoch,
    }).map((group) => group.name),
    ["HTTP initial policy"],
  );

  const legacy = await app.request("/api/admin/model-access/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Legacy empty" }),
  });
  assertEquals(legacy.status, 201, await legacy.clone().text());
  assertEquals((await legacy.json()).tokenIds, []);
});
