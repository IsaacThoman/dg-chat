import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { assertSafeE2ETarget } from "./target-safety.ts";

Deno.test("E2E target safety permits explicit loopback URLs with local fixture defaults", () => {
  for (
    const target of [
      "http://localhost:5173",
      "http://127.0.0.1:8000",
      "http://[::1]:8000",
    ]
  ) {
    assertEquals(assertSafeE2ETarget({ targetUrls: [target] }), undefined);
  }
});

Deno.test("E2E target safety rejects invalid and non-HTTP targets", () => {
  assertThrows(
    () => assertSafeE2ETarget({ targetUrls: ["not a URL"] }),
    Error,
    "target URL is invalid",
  );
  assertThrows(
    () => assertSafeE2ETarget({ targetUrls: ["file:///tmp/app"] }),
    Error,
    "must use HTTP or HTTPS",
  );
});

Deno.test("E2E target safety errors do not disclose URL credentials or paths", () => {
  const error = assertThrows(
    () =>
      assertSafeE2ETarget({
        targetUrls: ["https://user:password@chat.example.test/private?token=secret"],
      }),
    Error,
  );
  assertEquals(error.message.includes("password"), false);
  assertEquals(error.message.includes("private"), false);
  assertEquals(error.message.includes("secret"), false);
  assertEquals(error.message.includes('"https://chat.example.test"'), true);
});

Deno.test("E2E target safety fails closed for remote targets", () => {
  const complete = {
    targetUrls: ["https://chat.example.test"],
    allowDestructiveRemote: "true",
    setupToken: "remote-setup-token",
    adminEmail: "administrator@example.test",
    adminPassword: "explicit-remote-password",
  };

  for (
    const omitted of [
      "allowDestructiveRemote",
      "setupToken",
      "adminEmail",
      "adminPassword",
    ] as const
  ) {
    assertThrows(
      () => assertSafeE2ETarget({ ...complete, [omitted]: undefined }),
      Error,
      "Refusing to run destructive E2E tests against remote target",
    );
  }
  assertEquals(assertSafeE2ETarget(complete), undefined);
});

Deno.test("E2E target safety protects the browser base URL as well as the API URL", () => {
  assertThrows(
    () =>
      assertSafeE2ETarget({
        targetUrls: ["http://127.0.0.1:8000", "https://chat.example.test"],
      }),
    Error,
    '"https://chat.example.test"',
  );
});
