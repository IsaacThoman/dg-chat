import { assertEquals } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import { createApp } from "./app.ts";

async function json(response: Response) {
  // deno-lint-ignore no-explicit-any
  return await response.json() as Record<string, any>;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected session cookie");
  return cookie;
}

Deno.test("OpenAI file listing validates and paginates an owner-scoped stable result", async () => {
  const repository = new MemoryRepository();
  const { app } = createApp({ repository, setupToken: "files-pagination-setup" });
  const bootstrap = await app.request("/api/setup/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": "files-pagination-setup",
    },
    body: JSON.stringify({
      email: "files-pagination@example.test",
      password: "correct horse battery",
      name: "Files pagination",
    }),
  });
  assertEquals(bootstrap.status, 201);
  const owner = (await json(bootstrap)).user as { id: string };
  const login = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "files-pagination@example.test",
      password: "correct horse battery",
    }),
  });
  const tokenResponse = await app.request("/api/tokens", {
    method: "POST",
    headers: {
      cookie: sessionCookie(login),
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Files pagination", scopes: ["files:read"] }),
  });
  assertEquals(tokenResponse.status, 201);
  const authorization = `Bearer ${(await json(tokenResponse)).token}`;
  const create = (ownerId: string, ordinal: number) =>
    repository.createAttachment({
      ownerId,
      objectKey: `users/${ownerId}/pagination-${ordinal}`,
      filename: `pagination-${ordinal}.txt`,
      mimeType: "text/plain",
      sizeBytes: ordinal,
      sha256: ordinal.toString(16).padStart(64, "0"),
      state: "ready",
      inspectionComplete: true,
    }).attachment;
  const first = create(owner.id, 1);
  const second = create(owner.id, 2);
  const third = create(owner.id, 3);
  first.createdAt = "2026-01-01T00:00:00.000Z";
  second.createdAt = "2026-01-02T00:00:00.000Z";
  third.createdAt = "2026-01-03T00:00:00.000Z";
  const stranger = repository.createUser({
    email: "files-pagination-other@example.test",
    name: "Files pagination other",
    approvalStatus: "approved",
  });
  const foreign = create(stranger.id, 4);

  const request = (query: string) =>
    app.request(`/v1/files${query}`, { headers: { authorization } });
  const firstPageResponse = await request("?limit=2&order=asc&purpose=assistants");
  assertEquals(firstPageResponse.status, 200);
  const firstPage = await json(firstPageResponse);
  assertEquals(firstPage.data.map((file: { id: string }) => file.id), [first.id, second.id]);
  assertEquals(firstPage.first_id, first.id);
  assertEquals(firstPage.last_id, second.id);
  assertEquals(firstPage.has_more, true);

  const secondPage = await json(await request(`?limit=2&order=asc&after=${second.id}`));
  assertEquals(secondPage.data.map((file: { id: string }) => file.id), [third.id]);
  assertEquals(secondPage.first_id, third.id);
  assertEquals(secondPage.last_id, third.id);
  assertEquals(secondPage.has_more, false);

  const descending = await json(await request("?limit=2&order=desc"));
  assertEquals(descending.data.map((file: { id: string }) => file.id), [third.id, second.id]);
  const filtered = await json(await request("?purpose=fine-tune&limit=1"));
  assertEquals(filtered, {
    object: "list",
    data: [],
    first_id: null,
    last_id: null,
    has_more: false,
  });
  for (const purpose of ["", "CUSTOM purpose/with spaces", "x".repeat(200)]) {
    const response = await request(`?purpose=${encodeURIComponent(purpose)}`);
    assertEquals(response.status, 200);
    assertEquals((await json(response)).data, []);
  }

  for (
    const [query, parameter, code] of [
      ["?limit=0", "limit", "invalid_file_limit"],
      ["?limit=1.5", "limit", "invalid_file_limit"],
      ["?limit=10001", "limit", "invalid_file_limit"],
      ["?order=newest", "order", "invalid_file_order"],
      ["?after=not-a-file", "after", "invalid_file_cursor"],
      ["?limit=1&limit=2", "limit", "invalid_parameter"],
      ["?order=asc&order=desc", "order", "invalid_parameter"],
      [`?after=${first.id}&after=${second.id}`, "after", "invalid_parameter"],
      ["?purpose=assistants&purpose=fine-tune", "purpose", "invalid_parameter"],
    ] as const
  ) {
    const response = await request(query);
    assertEquals(response.status, 400);
    const body = await json(response);
    assertEquals(body.error.param, parameter);
    assertEquals(body.error.code, code);
  }

  const foreignCursor = await request(`?after=${foreign.id}`);
  assertEquals(foreignCursor.status, 400);
  const foreignError = await json(foreignCursor);
  assertEquals(foreignError.error.param, "after");
  assertEquals(foreignError.error.code, "invalid_file_cursor");
  assertEquals(JSON.stringify(foreignError).includes(foreign.filename), false);
  const filteredForeignCursor = await request(
    `?purpose=fine-tune&after=${foreign.id}`,
  );
  assertEquals(filteredForeignCursor.status, 400);
  assertEquals((await json(filteredForeignCursor)).error.code, "invalid_file_cursor");

  repository.deleteAttachment(first.id, owner.id);
  const afterDeleted = await json(
    await request(`?limit=10&order=asc&after=${first.id}`),
  );
  assertEquals(afterDeleted.data.map((file: { id: string }) => file.id), [second.id, third.id]);
});
