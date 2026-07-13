import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name:
    "PostgreSQL temporary promotion and purge are CAS, bounded, owner-safe, and attachment-safe",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 1 });
    const suffix = crypto.randomUUID();
    const owner = await repo.createUser({
      email: `temp-owner-${suffix}@example.com`,
      name: "Owner",
    });
    const other = await repo.createUser({
      email: `temp-other-${suffix}@example.com`,
      name: "Other",
    });
    try {
      const promotedCandidate = await repo.createConversation(
        owner.id,
        "promote",
        true,
        undefined,
        1,
      );
      const expired = await repo.createConversation(owner.id, "expired", true, "expired-replay", 1);
      const later = await repo.createConversation(owner.id, "later", true, undefined, 1);
      const foreign = await repo.createConversation(other.id, "foreign", true, undefined, 1);
      assertEquals(promotedCandidate.temporaryExpiresAt !== null, true);
      await assertRejects(
        () => repo.promoteTemporaryConversation(owner.id, promotedCandidate.id, 9),
        DomainError,
        "changed",
      );
      const promoted = await repo.promoteTemporaryConversation(owner.id, promotedCandidate.id, 0);
      assertEquals({
        temporary: promoted.temporary,
        expiry: promoted.temporaryExpiresAt,
        version: promoted.version,
      }, {
        temporary: false,
        expiry: null,
        version: 1,
      });

      const message = await repo.appendMessage({
        conversationId: expired.id,
        ownerId: owner.id,
        parentId: null,
        role: "user",
        content: "attached",
        expectedVersion: 0,
        idempotencyKey: "temporary-postgres-message",
      });
      const attachment = (await repo.createAttachment({
        ownerId: owner.id,
        objectKey: `users/${owner.id}/objects/${suffix}`,
        filename: "temporary.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        sha256: crypto.randomUUID().replaceAll("-", "").repeat(2),
      })).attachment;
      await repo.transitionAttachment(attachment.id, owner.id, "pending", "inspecting");
      await repo.transitionAttachment(attachment.id, owner.id, "inspecting", "ready");
      await repo.linkAttachmentToMessage(message.id, attachment.id, owner.id);
      await sql`UPDATE conversations SET temporary_expires_at='2025-12-31T00:00:00Z'
        WHERE id=${expired.id}`;
      await sql`UPDATE conversations SET temporary_expires_at='2026-01-01T00:00:00Z'
        WHERE id IN (${later.id},${foreign.id})`;

      assertEquals(
        await repo.purgeExpiredTemporaryConversations({
          ownerId: owner.id,
          limit: 1,
          now: "2026-01-02T00:00:00Z",
        }),
        { conversationIds: [expired.id] },
      );
      await assertRejects(() => repo.detail(expired.id, owner.id), DomainError, "not found");
      assertEquals((await repo.getAttachment(attachment.id, owner.id)).id, attachment.id);
      assertEquals((await repo.detail(later.id, owner.id)).id, later.id);
      assertEquals((await repo.detail(foreign.id, other.id)).id, foreign.id);
      assertEquals((await repo.detail(promoted.id, owner.id)).temporary, false);
      assertEquals(
        (await repo.listAudit({
          action: "conversation.temporary_kept",
          targetId: promoted.id,
        })).data.length,
        1,
      );
      const recreated = await repo.createConversation(
        owner.id,
        "expired",
        true,
        "expired-replay",
        1,
      );
      assertEquals(recreated.id === expired.id, false);
      assertEquals(
        (await repo.listAudit({
          action: "conversation.temporary_purged",
          targetId: expired.id,
        })).data.length,
        1,
      );
    } finally {
      await sql`DELETE FROM attachments WHERE owner_id IN (${owner.id},${other.id})`;
      await sql`DELETE FROM users WHERE id IN (${owner.id},${other.id})`;
      await sql.end();
      await repo.close();
    }
  },
});
