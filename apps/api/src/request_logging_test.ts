import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";
import type { BetterAuthService } from "./better-auth.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parsed(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

Deno.test("safe request logs exclude caller-controlled secrets and use route templates", async () => {
  const requestLogs: string[] = [];
  const { app } = createApp({
    repository: new MemoryRepository(),
    requestLogSink: (line) => requestLogs.push(line),
    requestErrorLogSink: () => {},
  });
  const secrets = {
    capability: "capability-secret-" + "c".repeat(32),
    code: "oidc-code-secret",
    state: "oidc-state-secret",
    token: "api-token-secret",
    signature: "signed-url-secret",
    search: "private-user@example.test",
    authorization: "Bearer authorization-secret",
    cookie: "dg_session=cookie-secret",
    malformedRequestId: "bad-request-id-forged-log-entry",
  };

  const query = new URLSearchParams({
    code: secrets.code,
    state: secrets.state,
    token: secrets.token,
    signature: secrets.signature,
    search: secrets.search,
  });
  const response = await app.request(
    `/api/public/shares/${secrets.capability}?${query}`,
    {
      headers: {
        authorization: secrets.authorization,
        cookie: secrets.cookie,
        "x-request-id": secrets.malformedRequestId,
      },
    },
  );

  assertEquals(requestLogs.length, 1);
  const line = requestLogs[0];
  for (const secret of Object.values(secrets)) assertFalse(line.includes(secret));
  const log = parsed(line);
  assertEquals(Object.keys(log).sort(), [
    "durationMs",
    "method",
    "path",
    "requestId",
    "status",
  ]);
  assertEquals(log.method, "GET");
  assertEquals(log.path, "/api/public/shares/:capability");
  assertEquals(log.status, response.status);
  assert(typeof log.durationMs === "number" && log.durationMs >= 0);
  assertMatch(String(log.requestId), uuidPattern);
  assertEquals(response.headers.get("x-request-id"), log.requestId);
});

Deno.test("OIDC and user-search query strings are never present even for unmatched routes", async () => {
  const requestLogs: string[] = [];
  const browserAuth = {
    oidcEnabled: true,
    // A provider callback returns its own Response in production. This also verifies that the
    // request-ID middleware reapplies its header after a downstream fresh Response.
    handler: () => new Response(null, { status: 302, headers: { location: "/" } }),
  } as unknown as BetterAuthService;
  const { app } = createApp({
    repository: new MemoryRepository(),
    browserAuth,
    requestLogSink: (line) => requestLogs.push(line),
    requestErrorLogSink: () => {},
  });
  const values = ["oidc-code", "oidc-state", "user-search@example.test"];
  const response = await app.request(
    `/api/auth/oidc/callback?code=${values[0]}&state=${values[1]}&search=${values[2]}`,
  );

  assertEquals(response.status, 302);
  assertMatch(response.headers.get("x-request-id") ?? "", uuidPattern);
  assertEquals(parsed(requestLogs[0]).path, "/api/auth/oidc/callback");
  for (const value of values) assertFalse(requestLogs[0].includes(value));

  const attackerPath = "attacker-controlled-unmatched-path";
  assertEquals((await app.request(`/${attackerPath}`)).status, 404);
  assertEquals(parsed(requestLogs[1]).path, "/*");
  assertFalse(requestLogs[1].includes(attackerPath));
});

class ThrowingListUsersRepository extends MemoryRepository {
  override listUsers(): never {
    throw new Error("database-password-secret user-content-secret");
  }
}

class ThrowingAuditRepository extends MemoryRepository {
  failAudit = false;
  override recordAudit(input: Parameters<MemoryRepository["recordAudit"]>[0]) {
    if (this.failAudit) throw new Error("audit-database-password-secret");
    return super.recordAudit(input);
  }
}

Deno.test("unhandled errors use a server-owned request ID without logging exception detail", async () => {
  const requestLogs: string[] = [];
  const errorLogs: string[] = [];
  const incomingRequestId = "0190c8a1-7c2d-7a31-8e52-6ce3b750d5f4";
  const { app } = createApp({
    repository: new ThrowingListUsersRepository(),
    requestLogSink: (line) => requestLogs.push(line),
    requestErrorLogSink: (line) => errorLogs.push(line),
  });

  const response = await app.request("/api/setup/status?search=private-search", {
    headers: { "x-request-id": incomingRequestId },
  });
  const body = await response.json() as { error: { message: string } };
  const requestId = response.headers.get("x-request-id") ?? "";

  assertEquals(response.status, 500);
  assertMatch(requestId, uuidPattern);
  assertFalse(requestId === incomingRequestId);
  assert(body.error.message.includes(requestId));
  assertEquals(requestLogs.length, 1);
  assertEquals(errorLogs.length, 1);
  assertEquals(parsed(requestLogs[0]).requestId, requestId);
  assertEquals(parsed(errorLogs[0]), {
    level: "error",
    message: "Unhandled request error",
    requestId,
  });
  const allLogs = [...requestLogs, ...errorLogs].join("\n");
  assertFalse(allLogs.includes("database-password-secret"));
  assertFalse(allLogs.includes("user-content-secret"));
  assertFalse(allLogs.includes("private-search"));
});

Deno.test("request IDs are server-owned and unique despite caller replay", async () => {
  const incomingRequestId = "0190c8a1-7c2d-7a31-8e52-6ce3b750d5f4";
  const { app } = createApp({
    repository: new MemoryRepository(),
    requestLogSink: () => {},
  });
  const request = () => app.request("/health", { headers: { "x-request-id": incomingRequestId } });
  const [first, second] = await Promise.all([request(), request()]);
  const firstId = first.headers.get("x-request-id") ?? "";
  const secondId = second.headers.get("x-request-id") ?? "";

  assertMatch(firstId, uuidPattern);
  assertMatch(secondId, uuidPattern);
  assertFalse(firstId === incomingRequestId);
  assertFalse(secondId === incomingRequestId);
  assertFalse(firstId === secondId);
});

Deno.test("CORS allows and exposes the server-owned request ID header", async () => {
  const { app } = createApp({
    repository: new MemoryRepository(),
    requestLogSink: () => {},
  });
  const origin = "http://localhost:5173";
  const preflight = await app.request("/health", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "X-Request-Id",
    },
  });
  const response = await app.request("/health", { headers: { origin } });

  assertEquals(preflight.status, 204);
  assert(
    (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase().includes(
      "x-request-id",
    ),
  );
  assertEquals(response.headers.get("access-control-allow-origin"), origin);
  assert(
    (response.headers.get("access-control-expose-headers") ?? "").toLowerCase().includes(
      "x-request-id",
    ),
  );
  assertMatch(response.headers.get("x-request-id") ?? "", uuidPattern);
});

Deno.test("logging sink failures never change successful or error responses", async () => {
  const success = createApp({
    repository: new MemoryRepository(),
    requestLogSink: () => {
      throw new Error("stdout unavailable");
    },
  });
  const health = await success.app.request("/health");
  assertEquals(health.status, 200);
  assertMatch(health.headers.get("x-request-id") ?? "", uuidPattern);

  const failure = createApp({
    repository: new ThrowingListUsersRepository(),
    requestLogSink: () => {
      throw new Error("stdout unavailable");
    },
    requestErrorLogSink: () => {
      throw new Error("stderr unavailable");
    },
  });
  const response = await failure.app.request("/api/setup/status");
  assertEquals(response.status, 500);
  assertMatch(response.headers.get("x-request-id") ?? "", uuidPattern);
});

Deno.test("background identity audit failures omit identity and exception details", async () => {
  const repository = new ThrowingAuditRepository();
  const user = repository.createUser({
    email: "private-reset-user@example.test",
    name: "Private reset user",
    passwordHash: "unused-test-hash",
  });
  repository.failAudit = true;
  const errorLogs: string[] = [];
  const { app } = createApp({
    repository,
    mailer: { send: () => Promise.resolve() },
    requestLogSink: () => {},
    requestErrorLogSink: (line) => errorLogs.push(line),
  });

  const response = await app.request("/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email }),
  });
  for (let attempt = 0; attempt < 20 && errorLogs.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assertEquals(response.status, 202);
  assertEquals(errorLogs.map(parsed), [{
    level: "error",
    message: "Identity delivery audit persistence failed",
    action: "identity.password_reset_requested",
  }]);
  const joined = errorLogs.join("\n");
  assertFalse(joined.includes(user.id));
  assertFalse(joined.includes(user.email));
  assertFalse(joined.includes("audit-database-password-secret"));
});
