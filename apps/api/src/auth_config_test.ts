import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  DOCUMENTED_APP_SECRET_PLACEHOLDER,
  DOCUMENTED_SETUP_TOKEN_PLACEHOLDER,
  timingSafeTextEqual,
  validateAppSecret,
  validateSetupToken,
} from "./auth-config.ts";

Deno.test("production authentication secrets reject shipped placeholders and weak bounds", () => {
  assertThrows(
    () => validateAppSecret(DOCUMENTED_APP_SECRET_PLACEHOLDER, true),
    Error,
    "non-placeholder",
  );
  assertThrows(() => validateAppSecret("short", true), Error, "between 32 and 256 bytes");
  assertThrows(() => validateAppSecret("x".repeat(257), true), Error, "between 32 and 256 bytes");
  assertThrows(() => validateAppSecret(undefined, true), Error, "required");
  assertEquals(validateAppSecret("a".repeat(32), true), "a".repeat(32));
  assertEquals(validateAppSecret(undefined, false), undefined);

  assertThrows(
    () => validateSetupToken(DOCUMENTED_SETUP_TOKEN_PLACEHOLDER, true),
    Error,
    "non-placeholder",
  );
  assertThrows(() => validateSetupToken("short", true), Error, "between 32 and 256 bytes");
  assertEquals(validateSetupToken(undefined, true), undefined);
  assertEquals(validateSetupToken("short-development-token", false), "short-development-token");
  assertThrows(
    () => validateSetupToken("x".repeat(257), false),
    Error,
    "at most 256 bytes",
  );
  assertEquals(validateSetupToken("b".repeat(32), true), "b".repeat(32));
});

Deno.test("setup credential comparison handles equal, unequal, and unequal-length values", () => {
  assertEquals(timingSafeTextEqual("same value", "same value"), true);
  assertEquals(timingSafeTextEqual("same valuf", "same value"), false);
  assertEquals(timingSafeTextEqual("short", "a longer value"), false);
  assertEquals(timingSafeTextEqual(undefined, "configured"), false);
  assertEquals(timingSafeTextEqual("x".repeat(1_000_000), "configured"), false);
  assertThrows(
    () => timingSafeTextEqual("configured", "x".repeat(257)),
    TypeError,
    "exceeds the supported byte limit",
  );
});
