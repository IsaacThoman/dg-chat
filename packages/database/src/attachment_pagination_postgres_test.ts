import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "PostgreSQL attachment pages preserve microsecond keysets and owner isolation",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 1 });
    const owner = await repo.createUser({
      email: `files-page-${crypto.randomUUID()}@example.test`,
      name: "Files page",
      approvalStatus: "approved",
    });
    const stranger = await repo.createUser({
      email: `files-page-other-${crypto.randomUUID()}@example.test`,
      name: "Files page other",
      approvalStatus: "approved",
    });
    const create = (ownerId: string, ordinal: number) =>
      repo.createAttachment({
        ownerId,
        objectKey: `users/${ownerId}/postgres-page-${ordinal}`,
        filename: `postgres-page-${ordinal}.txt`,
        mimeType: "text/plain",
        sizeBytes: ordinal,
        sha256: ordinal.toString(16).padStart(64, "a"),
        state: "ready",
        inspectionComplete: true,
      });
    try {
      const first = (await create(owner.id, 1)).attachment;
      const second = (await create(owner.id, 2)).attachment;
      const third = (await create(owner.id, 3)).attachment;
      const deleted = (await create(owner.id, 4)).attachment;
      const foreign = (await create(stranger.id, 5)).attachment;
      await sql`UPDATE attachments SET created_at='2026-01-01 00:00:00.123455+00'
        WHERE id=${first.id}`;
      await sql`UPDATE attachments SET created_at='2026-01-02 00:00:00.123456+00'
        WHERE id IN (${second.id},${third.id})`;
      await sql`UPDATE attachments SET created_at='2026-01-01 12:00:00.123456+00'
        WHERE id=${deleted.id}`;
      const tied = [second.id, third.id].sort();
      const expected = [first.id, ...tied];

      const pageBeforeDelete = await repo.listAttachmentPage(owner.id, {
        limit: 2,
        order: "asc",
      });
      assertEquals(pageBeforeDelete.data.map((file) => file.id), [first.id, deleted.id]);
      await repo.deleteAttachment(deleted.id, owner.id);
      assertEquals(
        (await repo.listAttachmentPage(owner.id, {
          limit: 10,
          order: "asc",
          after: deleted.id,
        })).data.map((file) => file.id),
        tied,
      );

      const visited: string[] = [];
      let after: string | undefined;
      for (let pageNumber = 0; pageNumber < expected.length + 1; pageNumber++) {
        const page = await repo.listAttachmentPage(owner.id, { limit: 1, order: "asc", after });
        visited.push(...page.data.map((file) => file.id));
        if (!page.hasMore) break;
        assertEquals(page.data.length, 1, "A page with a successor must advance its cursor");
        after = page.data[0].id;
      }
      assertEquals(visited, expected);
      const visitedDescending: string[] = [];
      after = undefined;
      for (let pageNumber = 0; pageNumber < expected.length + 1; pageNumber++) {
        const page = await repo.listAttachmentPage(owner.id, { limit: 1, order: "desc", after });
        visitedDescending.push(...page.data.map((file) => file.id));
        if (!page.hasMore) break;
        assertEquals(page.data.length, 1, "A descending page with a successor must advance");
        after = page.data[0].id;
      }
      assertEquals(visitedDescending, expected.toReversed());
      assertEquals(
        (await repo.listAttachmentPage(owner.id, { limit: 10, order: "desc" })).data.map((file) =>
          file.id
        ),
        expected.toReversed(),
      );
      assertEquals(visited.includes(deleted.id), false);
      assertEquals(visited.includes(foreign.id), false);
      await assertRejects(
        () => repo.listAttachmentPage(owner.id, { limit: 1, order: "asc", after: foreign.id }),
        DomainError,
        "invalid for this owner",
      );
    } finally {
      await sql`DELETE FROM attachments WHERE owner_id IN (${owner.id},${stranger.id})`;
      await sql`DELETE FROM users WHERE id IN (${owner.id},${stranger.id})`;
      await sql.end();
      await repo.close();
    }
  },
});
