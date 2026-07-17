import { assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1.0.14";
import { betterAuth } from "npm:better-auth@1.6.23/minimal";
import { APIError } from "npm:better-auth@1.6.23/api";
import {
  createSanitizedAuthOperationalEmitter,
  createSanitizedBetterAuthLogger,
  createSanitizedBetterAuthLogging,
  recordAuthAuditWithSanitizedFailure,
} from "./better-auth.ts";

Deno.test("Better Auth logs preserve severity without callback, identity, or exception details", () => {
  const lines: string[] = [];
  const logger = createSanitizedBetterAuthLogger((line) => lines.push(line));
  const secrets = [
    "oidc-state-secret",
    "oidc-code-secret",
    "private-user@example.test",
    "database-password-secret",
  ];

  logger.log(
    "error",
    `Invalid state ${secrets[0]}`,
    { code: secrets[1], email: secrets[2] },
    new Error(secrets[3]),
  );
  logger.log("warn", `Adapter warning for ${secrets[2]}`);

  assertEquals(lines.map((line) => JSON.parse(line)), [
    {
      level: "error",
      component: "better_auth",
      message: "Authentication subsystem event",
    },
    {
      level: "warn",
      component: "better_auth",
      message: "Authentication subsystem event",
    },
  ]);
  for (const secret of secrets) assertFalse(lines.join("\n").includes(secret));
});

Deno.test("Better Auth log sink failures never alter authentication control flow", () => {
  const logger = createSanitizedBetterAuthLogger(() => {
    throw new Error("stderr unavailable");
  });
  logger.log("error", "private authentication detail", { state: "secret" });
});

Deno.test("unexpected Better Auth errors become sanitized typed errors before global logging", () => {
  const lines: string[] = [];
  const logging = createSanitizedBetterAuthLogging((line) => lines.push(line));
  const error = assertThrows(
    () => logging.onAPIError.onError(new Error("reset-password:private-token")),
    APIError,
  );
  assertEquals(error.status, "INTERNAL_SERVER_ERROR");
  assertEquals(error.message, "Authentication request failed");
  assertEquals(lines.map((line) => JSON.parse(line)), [{
    level: "error",
    component: "better_auth",
    message: "Authentication subsystem event",
  }]);
  assertFalse(lines[0].includes("private-token"));
});

Deno.test("Better Auth logging replaces sensitive 5xx API errors but preserves intended 4xx", () => {
  const lines: string[] = [];
  const logging = createSanitizedBetterAuthLogging((line) => lines.push(line));
  const secret = "private-adapter-token";
  const internal = new APIError("INTERNAL_SERVER_ERROR", {
    message: secret,
    cause: new Error(`database:${secret}`),
  });
  const sanitized = assertThrows(() => logging.onAPIError.onError(internal), APIError);
  assertEquals(sanitized.statusCode, 500);
  assertEquals(sanitized.message, "Authentication request failed");
  assertFalse(JSON.stringify(sanitized.body).includes(secret));
  assertFalse(String(sanitized.cause).includes(secret));

  const intended = new APIError("BAD_REQUEST", { message: "Invalid authentication request" });
  logging.onAPIError.onError(intended);
  assertEquals(intended.statusCode, 400);
  assertEquals(intended.message, "Invalid authentication request");
  assertEquals(lines.length, 2);
  assertFalse(lines.join("\n").includes(secret));
});

Deno.test("auth audit and logging failures cannot reject an applied identity operation", async () => {
  let auditAttempted = false;
  const emit = createSanitizedAuthOperationalEmitter(() => {
    throw new Error("stderr unavailable");
  });

  await recordAuthAuditWithSanitizedFailure(
    () => {
      auditAttempted = true;
      throw new Error("audit database secret");
    },
    emit,
    { level: "error", message: "Password reset audit persistence failed" },
  );

  assertEquals(auditAttempted, true);
});

Deno.test("Better Auth handler API errors use the sanitized callback instead of global logging", async () => {
  const lines: string[] = [];
  const globalLines: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const auth = betterAuth({
    baseURL: "http://localhost:8000",
    basePath: "/api/auth",
    secret: "test-secret-that-is-at-least-thirty-two-bytes-long",
    emailAndPassword: { enabled: true },
    ...createSanitizedBetterAuthLogging((line) => lines.push(line)),
  });
  const secret = "malformed-auth-payload-secret@example.test";
  console.error = (...values: unknown[]) => globalLines.push(values.join(" "));
  console.warn = (...values: unknown[]) => globalLines.push(values.join(" "));
  const response = await (async () => {
    try {
      return await auth.handler(
        new Request("http://localhost:8000/api/auth/request-password-reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The disabled reset handler raises a real Better Auth APIError after parsing this value.
          body: JSON.stringify({ email: secret, redirectTo: "http://localhost:8000/reset" }),
        }),
      );
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  })();

  assertEquals(response.status, 400);
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), {
    level: "error",
    component: "better_auth",
    message: "Authentication subsystem event",
  });
  assertFalse(lines[0].includes(secret));
  assertEquals(globalLines, []);
});
