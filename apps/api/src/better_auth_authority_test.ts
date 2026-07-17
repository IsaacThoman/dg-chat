import { assertEquals } from "jsr:@std/assert@1.0.14";
import { matchesPasswordResetObservation } from "./better-auth.ts";

Deno.test("password-reset verification requires a reset-specific authority observation", () => {
  const base = {
    userId: "00000000-0000-4000-8000-000000000001",
    authorityEpoch: 7,
    eligible: true,
  } as const;

  assertEquals(
    matchesPasswordResetObservation({ ...base, kind: "password_reset" }, base.userId),
    true,
  );
  assertEquals(
    matchesPasswordResetObservation({ ...base, kind: "sign_in" }, base.userId),
    false,
  );
  assertEquals(
    matchesPasswordResetObservation(
      { ...base, kind: "password_reset", eligible: false },
      base.userId,
    ),
    false,
  );
  assertEquals(
    matchesPasswordResetObservation(
      { ...base, kind: "password_reset" },
      "00000000-0000-4000-8000-000000000002",
    ),
    false,
  );
  assertEquals(matchesPasswordResetObservation(undefined, base.userId), false);
});
