import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { createApp } from "./app.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

Deno.test("bootstrap, signup, approval, immutable chat, API token and OpenAI completion", async () => {
  const { app, repository } = createApp({
    setupToken: "setup-secret",
    startingCreditMicros: 5_000_000,
  });
  const adminResponse = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": "setup-secret" },
    body: JSON.stringify({
      email: "admin@example.com",
      password: "correct horse battery",
      name: "Admin",
    }),
  });
  assertEquals(adminResponse.status, 201);
  const loginAdmin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
  });
  const admin = await json(loginAdmin);
  const adminAuth = { authorization: `Bearer ${admin.token}`, "content-type": "application/json" };
  const signup = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "person@example.com",
      password: "correct horse battery",
      name: "Person",
    }),
  });
  const signed = await json(signup);
  assertEquals(signed.user.approvalStatus, "pending");
  assertStringIncludes(signup.headers.get("set-cookie") ?? "", "HttpOnly");
  const blocked = await app.request("/api/conversations", {
    headers: { authorization: `Bearer ${signed.token}` },
  });
  assertEquals(blocked.status, 403);
  const approval = await app.request(`/api/admin/users/${signed.user.id}/approval`, {
    method: "PATCH",
    headers: adminAuth,
    body: JSON.stringify({ status: "approved" }),
  });
  assertEquals(approval.status, 200);
  const conversationResponse = await app.request("/api/conversations", {
    method: "POST",
    headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Test" }),
  });
  const conversation = await json(conversationResponse);
  assertExists(conversation.id);
  const generationResponse = await app.request(`/api/conversations/${conversation.id}/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      content: "hello from the web",
      model: "simulated/dg-chat",
      parentId: null,
      supersedesId: null,
      expectedVersion: 0,
      idempotencyKey: "web-generation-0001",
    }),
  });
  const generation = await json(generationResponse);
  assertEquals(generationResponse.status, 201);
  assertEquals(generation.user.content, "hello from the web");
  assertStringIncludes(generation.assistant.content, "hello from the web");
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "SDK", scopes: ["models:read", "chat:write"] }),
  });
  const apiToken = await json(tokenResponse);
  assertStringIncludes(apiToken.token, "dg_");
  const completion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "simulated/dg-chat",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const result = await json(completion);
  assertEquals(completion.status, 200);
  assertStringIncludes(result.choices[0].message.content, "hello");
  assertEquals(repository.usage(signed.user.id).calls, 2);
});
