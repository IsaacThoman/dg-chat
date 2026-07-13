import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { createApp } from "./app.ts";
import { DomainError, MemoryRepository } from "@dg-chat/database";

const cookie = (response: Response) => {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
};

async function adminFixture() {
  const repository = new MemoryRepository();
  const { app } = createApp({ repository, setupToken: "operational-admin-setup" });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "operational-admin-setup" },
    body: JSON.stringify({
      email: "operations@example.com",
      password: "correct horse battery",
      name: "Operations Admin",
    }),
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "operations@example.com",
      password: "correct horse battery",
    }),
  });
  assertEquals(login.status, 200);
  return {
    app,
    repository,
    headers: { cookie: cookie(login), origin: "http://localhost:5173" },
  };
}

Deno.test("admin analytics validates bounded filters and exports formula-safe no-store CSV", async () => {
  const { app, repository, headers } = await adminFixture();
  let observedQuery: unknown;
  repository.adminAnalytics = (query) => {
    observedQuery = query;
    return {
      query,
      summary: {
        calls: 3,
        completed: 2,
        failed: 1,
        inputTokens: 12,
        cachedInputTokens: 2,
        reasoningTokens: 3,
        outputTokens: 8,
        customerCostMicros: 99,
        providerCostMicros: 70,
        successRate: 2 / 3,
        avgLatencyMs: 40,
        p95LatencyMs: 55,
        avgTtftMs: 10,
      },
      points: [{
        start: query.from,
        calls: 3,
        completed: 2,
        failed: 1,
        customerCostMicros: 99,
        inputTokens: 12,
        outputTokens: 8,
        avgLatencyMs: 40,
        avgTtftMs: 10,
      }],
      models: [{ key: "=unsafe-model", calls: 3, customerCostMicros: 99 }],
      providers: [{ key: "+unsafe-provider", calls: 3, customerCostMicros: 99 }],
      statuses: [{ key: "completed", calls: 2, customerCostMicros: 80 }],
    };
  };

  assertEquals((await app.request("/api/admin/analytics")).status, 401);
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Admin automation", scopes: ["models:read"] }),
  });
  assertEquals(tokenResponse.status, 201);
  const adminToken = (await tokenResponse.json() as { token: string }).token;
  assertEquals(
    (await app.request("/api/admin/analytics", {
      headers: { authorization: `Bearer ${adminToken}` },
    })).status,
    403,
  );
  const url = "/api/admin/analytics?from=2026-07-01T00:00:00Z&to=2026-07-03T00:00:00Z" +
    "&bucket=day&model=model-a&provider=provider-a&status=completed";
  const response = await app.request(url, { headers });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(observedQuery, {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-03T00:00:00.000Z",
    bucket: "day",
    userId: undefined,
    model: "model-a",
    provider: "provider-a",
    status: "completed",
  });

  for (
    const invalid of [
      "?from=bad",
      "?from=2026-07-03&to=2026-07-01",
      "?from=2026-01-01&to=2026-07-01",
      "?from=2026-07-01&to=2026-08-01&bucket=hour",
      "?from=2026-07-01T00:00:00&to=2026-07-02T00:00:00Z",
      "?from=2026-02-30T00:00:00Z&to=2026-03-03T00:00:00Z",
      `?model=${"m".repeat(201)}`,
      `?provider=${"p".repeat(201)}`,
      "?bucket=minute",
      "?status=unknown",
      "?userId=not-a-uuid",
    ]
  ) {
    assertEquals((await app.request(`/api/admin/analytics${invalid}`, { headers })).status, 422);
  }

  const csv = await app.request(`${url.replace("/analytics", "/analytics.csv")}`, { headers });
  assertEquals(csv.status, 200);
  assertEquals(csv.headers.get("cache-control"), "private, no-store");
  assertEquals(csv.headers.get("x-content-type-options"), "nosniff");
  const body = await csv.text();
  const rows = body.trimEnd().split("\r\n");
  assertEquals(
    rows[0],
    '"section","key","start","calls","completed","failed","success_rate","input_tokens",' +
      '"cached_input_tokens","reasoning_tokens","output_tokens","customer_cost_micros",' +
      '"provider_cost_micros","avg_latency_ms","p95_latency_ms","avg_ttft_ms"',
  );
  assertEquals(
    rows[1],
    '"summary","total","2026-07-01T00:00:00.000Z","3","2","1",' +
      '"0.6666666666666666","12","2","3","8","99","70","40","55","10"',
  );
  assertStringIncludes(body, '"\'=unsafe-model"');
  assertStringIncludes(body, '"\'+unsafe-provider"');
});

Deno.test("admin jobs are paginated, redacted, validated, and retry failed jobs with audit", async () => {
  const { app, repository, headers } = await adminFixture();
  const jobId = crypto.randomUUID();
  let observedQuery: unknown;
  let observedActorId: string | undefined;
  repository.listJobs = (query) => {
    observedQuery = query;
    return {
      items: [{
        id: jobId,
        type: "attachment.ingest",
        status: "failed" as const,
        attempts: 3,
        availableAt: "2026-07-10T00:00:00.000Z",
        lockedAt: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        completedAt: "2026-07-10T00:01:00.000Z",
        lastError: "bounded failure context",
      }],
      nextCursor: "opaque-next",
      previousCursor: null,
      hasPrevious: false,
    };
  };
  repository.retryFailedJob = (id, actorId) => {
    assertEquals(id, jobId);
    observedActorId = actorId;
    return {
      priorAttempts: 3,
      job: {
        id: jobId,
        type: "attachment.ingest",
        status: "queued" as const,
        attempts: 0,
        availableAt: "2026-07-11T00:00:00.000Z",
        lockedAt: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        completedAt: null,
        lastError: null,
      },
    };
  };

  const response = await app.request(
    "/api/admin/jobs?status=failed&type=attachment.ingest&limit=25&cursor=opaque",
    { headers },
  );
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(observedQuery, {
    limit: 25,
    status: "failed",
    type: "attachment.ingest",
    cursor: "opaque",
  });
  const page = await response.json() as Record<string, unknown>;
  assertEquals(JSON.stringify(page).includes("payload"), false);
  assertEquals(JSON.stringify(page).includes("lockedBy"), false);

  for (const invalid of ["?limit=0", "?limit=101", "?limit=1.5", "?status=unknown"]) {
    assertEquals((await app.request(`/api/admin/jobs${invalid}`, { headers })).status, 422);
  }
  assertEquals(
    (await app.request("/api/admin/jobs/not-a-uuid/retry", {
      method: "POST",
      headers,
    })).status,
    422,
  );
  const retried = await app.request(`/api/admin/jobs/${jobId}/retry`, {
    method: "POST",
    headers,
  });
  assertEquals(retried.status, 200, await retried.clone().text());
  assertEquals(retried.headers.get("cache-control"), "private, no-store");
  assertEquals((await retried.json() as { priorAttempts: number }).priorAttempts, 3);
  assertEquals(
    observedActorId,
    repository.listUsers().find((user) => user.email === "operations@example.com")?.id,
  );

  repository.retryFailedJob = () => {
    throw new DomainError("conflict", "Only failed jobs can be retried", 409);
  };
  const conflict = await app.request(`/api/admin/jobs/${jobId}/retry`, {
    method: "POST",
    headers,
  });
  assertEquals(conflict.status, 409);
  assertEquals(conflict.headers.get("cache-control"), "private, no-store");
  assertEquals((await conflict.json() as { error: { code: string } }).error.code, "conflict");

  repository.retryFailedJob = () => {
    throw new DomainError("not_found", "Job not found", 404);
  };
  const missing = await app.request(`/api/admin/jobs/${crypto.randomUUID()}/retry`, {
    method: "POST",
    headers,
  });
  assertEquals(missing.status, 404);
  assertEquals((await missing.json() as { error: { code: string } }).error.code, "not_found");
});
