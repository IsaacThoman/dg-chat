import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { withAuditTestMaintenance } from "./postgres-test-maintenance.ts";
import type { CreateConversationShareInput } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "PostgreSQL shares are transactional, idempotent, immutable, revocable, and private",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const repo = await PostgresRepository.connect(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 4 });
    const suffix = crypto.randomUUID();
    const owner = await repo.createUser({
      email: `share-${suffix}@example.com`,
      name: "Postgres Owner",
      approvalStatus: "approved",
    });
    const other = await repo.createUser({
      email: `share-other-${suffix}@example.com`,
      name: "Other Owner",
      approvalStatus: "approved",
    });
    const conversationId = crypto.randomUUID();
    const rootId = crypto.randomUUID();
    const leafId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    try {
      await sql`INSERT INTO conversations(id,owner_id,title,version)
        VALUES(${conversationId},${owner.id},'Postgres immutable',2)`;
      await sql`INSERT INTO messages(
        id,conversation_id,parent_id,sibling_index,role,content,status,metadata,idempotency_key
      ) VALUES(${rootId},${conversationId},NULL,0,'user','Question','complete','{}','pg-share-root')`;
      await sql`INSERT INTO messages(
        id,conversation_id,parent_id,sibling_index,role,content,model,status,metadata,idempotency_key
      ) VALUES(${leafId},${conversationId},${rootId},0,'assistant','Original answer',
        'provider/model','complete','{}','pg-share-leaf')`;
      await sql`UPDATE conversations SET active_leaf_id=${leafId} WHERE id=${conversationId}`;
      await sql`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,width,height,state,
        ingestion_status
      ) VALUES(${attachmentId},${owner.id},${`private/${owner.id}/${attachmentId}`},
        'diagram.png','image/png',128,${"a".repeat(64)},20,10,'ready','not_applicable')`;
      await sql`INSERT INTO message_attachments(message_id,attachment_id,position)
        VALUES(${rootId},${attachmentId},0)`;
      const input: CreateConversationShareInput = {
        conversationId,
        leafId,
        expectedConversationVersion: 2,
        identityVisibility: "owner",
        attachmentPolicy: "include",
        selectedAttachmentIds: [],
        expiresAt: null,
        idempotencyKey: "pg-share-create",
        secretHash: "d".repeat(64),
      };
      const [first, second] = await Promise.all([
        repo.createConversationShare(owner.id, input),
        repo.createConversationShare(owner.id, input),
      ]);
      assertEquals([first.replayed, second.replayed].sort(), [false, true]);
      assertEquals(first.share.id, second.share.id);
      assertEquals((await repo.listConversationShares(owner.id)).length, 1);
      assertEquals(await repo.listConversationShares(other.id), []);
      const snapshot = (await repo.resolvePublicConversationShare(input.secretHash))!;
      assertEquals(snapshot.messages.map((value) => value.content), [
        "Question",
        "Original answer",
      ]);
      assertNotEquals(snapshot.messages[0].id, rootId);
      assertNotEquals(snapshot.attachments[0].id, attachmentId);
      assertEquals(JSON.stringify(snapshot).includes(owner.email), false);
      assertEquals(JSON.stringify(snapshot).includes(conversationId), false);
      assertEquals(JSON.stringify(snapshot).includes("private/"), false);
      assertEquals(
        JSON.stringify(await repo.exportConversationPortability(owner.id)).includes(
          input.secretHash,
        ),
        false,
      );
      const access = await repo.resolvePublicShareAttachment(
        input.secretHash,
        snapshot.attachments[0].id,
      );
      assertEquals(access?.objectKey, `private/${owner.id}/${attachmentId}`);

      const later = crypto.randomUUID();
      await sql`INSERT INTO messages(
        id,conversation_id,parent_id,sibling_index,role,content,status,metadata,idempotency_key
      ) VALUES(${later},${conversationId},${leafId},0,'user','Later edit','complete','{}','later')`;
      await sql`UPDATE conversations SET active_leaf_id=${later},version=3 WHERE id=${conversationId}`;
      assertEquals(
        (await repo.resolvePublicConversationShare(input.secretHash))!.messages.map((value) =>
          value.content
        ),
        ["Question", "Original answer"],
      );
      await assertRejects(
        () => repo.createConversationShare(owner.id, { ...input, secretHash: "e".repeat(64) }),
        DomainError,
        "differs",
      );
      await sql`UPDATE users SET state='suspended' WHERE id=${owner.id}`;
      assertEquals(await repo.resolvePublicConversationShare(input.secretHash), undefined);
      await sql`UPDATE users SET state='active' WHERE id=${owner.id}`;
      await sql`UPDATE users SET deleted_at=now() WHERE id=${owner.id}`;
      assertEquals(await repo.resolvePublicConversationShare(input.secretHash), undefined);
      await assertRejects(
        () => repo.createConversationShare(owner.id, input),
        DomainError,
        "cannot create shares",
      );
      await assertRejects(
        () =>
          repo.createConversationShare(owner.id, {
            ...input,
            idempotencyKey: "pg-deleted-owner-share",
            secretHash: "f".repeat(64),
          }),
        DomainError,
        "cannot create shares",
      );
      await sql`UPDATE users SET deleted_at=NULL WHERE id=${owner.id}`;
      const revoked = await repo.revokeConversationShare(owner.id, first.share.id, 1);
      assertEquals(revoked.version, 2);
      assertNotEquals(revoked.revokedAt, null);
      assertEquals(await repo.resolvePublicConversationShare(input.secretHash), undefined);
      const audit = await sql<{ action: string; metadata: unknown }[]>`SELECT action,metadata
        FROM audit_events WHERE target_id=${first.share.id} ORDER BY created_at`;
      assertEquals(audit.map((value) => value.action), [
        "conversation.share_created",
        "conversation.share_revoked",
      ]);
      assertEquals(JSON.stringify(audit).includes(input.secretHash), false);
    } finally {
      await withAuditTestMaintenance(
        sql,
        (tx) => tx`DELETE FROM audit_events WHERE actor_id IN (${owner.id},${other.id})`,
      );
      await sql`DELETE FROM conversation_share_snapshots WHERE owner_id IN (${owner.id},${other.id})`;
      await sql`DELETE FROM message_attachments WHERE attachment_id=${attachmentId}`;
      await sql`DELETE FROM attachments WHERE owner_id IN (${owner.id},${other.id})`;
      await sql`DELETE FROM conversations WHERE owner_id IN (${owner.id},${other.id})`;
      await sql`DELETE FROM users WHERE id IN (${owner.id},${other.id})`;
      await sql.end();
      await repo.close();
    }
  },
});
