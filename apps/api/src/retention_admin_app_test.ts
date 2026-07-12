import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";

const cookie = (response: Response) => {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
};

async function fixture() {
  const repository = new MemoryRepository();
  const { app } = createApp({ repository, setupToken: "retention-setup-token" });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "retention-setup-token" },
    body: JSON.stringify({
      email: "retention@example.com",
      password: "correct horse battery",
      name: "Retention Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "retention@example.com", password: "correct horse battery" }),
  });
  return {
    app,
    repository,
    headers: { cookie: cookie(login), origin: "http://localhost:5173" },
  };
}

Deno.test("retention administration is session-only, versioned, bounded, and body-free", async () => {
  const { app, repository, headers } = await fixture();
  const policy = {
    version: 1,
    captureEnabled: false,
    requestBodyDays: 7 as const,
    responseBodyDays: 7 as const,
    updatedAt: "2026-07-12T00:00:00.000Z",
    updatedBy: null,
  };
  const run = {
    id: crypto.randomUUID(),
    idempotencyKey: "retention-run-key",
    status: "queued" as const,
    policy,
    capturesScrubbed: 0,
    requestBodiesScrubbed: 0,
    responseBodiesScrubbed: 0,
    bytesScrubbed: 0,
    requestCutoffAt: "2026-07-05T00:00:00.000Z",
    responseCutoffAt: "2026-07-05T00:00:00.000Z",
    createdAt: "2026-07-12T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    error: null,
  };
  let updateInput: unknown;
  let enqueueInput: unknown;
  repository.getRetentionPolicy = () => policy;
  repository.updateRetentionPolicy = (input, actorId) => {
    updateInput = { input, actorId };
    return { ...policy, ...input, version: 2, updatedBy: actorId };
  };
  repository.previewRetentionScrub = () => ({
    policyVersion: 1,
    requestCutoffAt: "2026-07-04T00:00:00.000Z",
    responseCutoffAt: "2026-07-05T00:00:00.000Z",
    captures: 2,
    requestBodies: 1,
    responseBodies: 1,
    requestBytes: 25,
    responseBytes: 35,
  });
  repository.enqueueRetentionScrub = (input, actorId) => {
    enqueueInput = { input, actorId };
    return run;
  };
  repository.listRetentionScrubRuns = () => ({ items: [run] });
  repository.getRetentionScrubRun = () => run;

  assertEquals((await app.request("/api/admin/retention/policy")).status, 401);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Retention automation", scopes: ["models:read"] }),
  });
  const token = (await tokenResponse.json() as { token: string }).token;
  assertEquals(
    (await app.request("/api/admin/retention/policy", {
      headers: { authorization: `Bearer ${token}` },
    })).status,
    403,
  );

  const get = await app.request("/api/admin/retention/policy", { headers });
  assertEquals(get.status, 200);
  assertEquals(get.headers.get("cache-control"), "private, no-store");
  assertEquals(await get.json(), policy);

  const update = await app.request("/api/admin/retention/policy", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: 1,
      captureEnabled: true,
      requestBodyDays: 14,
      responseBodyDays: 30,
    }),
  });
  assertEquals(update.status, 200, await update.clone().text());
  assertEquals((updateInput as { input: unknown }).input, {
    expectedVersion: 1,
    captureEnabled: true,
    requestBodyDays: 14,
    responseBodyDays: 30,
  });

  const preview = await app.request("/api/admin/retention/previews", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ expectedPolicyVersion: 1 }),
  });
  assertEquals(preview.status, 200);
  const previewBody = await preview.text();
  assertEquals(previewBody.includes("provider secret"), false);
  assertEquals(previewBody.includes("requestBody"), false);

  const enqueue = await app.request("/api/admin/retention/scrub-runs", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      expectedPolicyVersion: 1,
      idempotencyKey: "retention-run-key",
      requestCutoffAt: "2026-07-04T00:00:00.000Z",
      responseCutoffAt: "2026-07-05T00:00:00.000Z",
    }),
  });
  assertEquals(enqueue.status, 202, await enqueue.clone().text());
  assertEquals((enqueueInput as { input: unknown }).input, {
    expectedPolicyVersion: 1,
    idempotencyKey: "retention-run-key",
    requestCutoffAt: "2026-07-04T00:00:00.000Z",
    responseCutoffAt: "2026-07-05T00:00:00.000Z",
  });
  assertEquals(
    (await app.request("/api/admin/retention/scrub-runs?limit=0", { headers })).status,
    422,
  );
  assertEquals(
    (await app.request("/api/admin/retention/scrub-runs?status=unknown", { headers })).status,
    422,
  );
  assertEquals(
    (await app.request("/api/admin/retention/scrub-runs/not-a-uuid", { headers })).status,
    422,
  );

  for (
    const invalid of [
      {},
      { expectedVersion: 1, captureEnabled: true, requestBodyDays: 2, responseBodyDays: 7 },
      {
        expectedVersion: 1,
        captureEnabled: true,
        requestBodyDays: 7,
        responseBodyDays: 7,
        extra: true,
      },
    ]
  ) {
    assertEquals(
      (await app.request("/api/admin/retention/policy", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(invalid),
      })).status,
      422,
    );
  }
});
