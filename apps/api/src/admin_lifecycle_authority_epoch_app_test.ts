import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";

Deno.test("admitted admin lifecycle HTTP mutation rejects a completed-reset epoch", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({
    repository,
    setupToken: "stale-lifecycle-http-setup",
    requestErrorLogSink: () => undefined,
  });
  await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "stale-lifecycle-http-setup",
    },
    body: JSON.stringify({
      email: "stale-lifecycle-http-admin@example.test",
      password: "correct horse battery staple",
      name: "Stale lifecycle HTTP admin",
    }),
  });
  const actor = repository.findUserByEmail("stale-lifecycle-http-admin@example.test")!;
  const target = repository.createUser({
    email: "stale-lifecycle-http-target@example.test",
    name: "Stale lifecycle HTTP target",
    approvalStatus: "approved",
  });
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: actor.email,
      password: "correct horse battery staple",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(cookie);

  const setState = repository.setAdminUserState.bind(repository);
  let intercepted = false;
  repository.setAdminUserState = (input) => {
    if (!intercepted) {
      intercepted = true;
      // Simulate a reset completing after authenticate/admin middleware captured epoch 1.
      repository.users.get(actor.id)!.authorityEpoch++;
    }
    return setState(input);
  };

  const response = await app.request(`/api/admin/users/${target.id}/state`, {
    method: "PATCH",
    headers: {
      cookie,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expectedVersion: target.version,
      state: "suspended",
      reason: "Must not run under a stale session",
    }),
  });
  assertEquals(response.status, 403, await response.clone().text());
  assertEquals(
    (await response.json() as { error: { code: string } }).error.code,
    "admin_authority_required",
  );
  assertEquals(repository.getAdminUser(target.id).state, "active");
  assertEquals(
    repository.auditEvents.some((event) =>
      event.action === "user.state.suspended" && event.targetId === target.id
    ),
    false,
  );
});
