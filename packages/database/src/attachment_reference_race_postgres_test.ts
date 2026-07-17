import { assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import type { CreateConversationShareInput } from "./repository.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for attachment reference admission lock");
}

function applicationUrl(name: string): string {
  const url = new URL(databaseUrl!);
  url.searchParams.set("application_name", name);
  return url.toString();
}

Deno.test({
  name: "attachment tombstones deterministically fence concurrent knowledge and share references",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const suffix = crypto.randomUUID();
    const applicationName = `attachment-reference-${suffix}`;
    const repo = await PostgresRepository.connect(applicationUrl(applicationName));
    const control = postgres(databaseUrl!, { max: 2 });
    const blocker = postgres(databaseUrl!, { max: 1 });
    const owner = await repo.createUser({
      email: `attachment-reference-${suffix}@example.com`,
      name: "Attachment reference race",
      approvalStatus: "approved",
    });
    const knowledgeAttachmentId = crypto.randomUUID();
    const shareAttachmentId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const rootId = crypto.randomUUID();
    const leafId = crypto.randomUUID();
    const collection = await repo.createKnowledgeCollection(owner.id, {
      name: `Reference race ${suffix}`,
      description: "",
      idempotencyKey: `reference-race-${suffix}`,
    });
    try {
      await control`INSERT INTO attachments(
        id,owner_id,object_key,filename,mime_type,size_bytes,sha256,state,ingestion_status
      ) VALUES
        (${knowledgeAttachmentId},${owner.id},${`race/${owner.id}/knowledge-${suffix}`},
          'knowledge.txt','text/plain',4,${"a".repeat(64)},'ready','not_applicable'),
        (${shareAttachmentId},${owner.id},${`race/${owner.id}/share-${suffix}`},
          'share.txt','text/plain',4,${"b".repeat(64)},'ready','not_applicable')`;
      await control`INSERT INTO conversations(id,owner_id,title,version)
        VALUES(${conversationId},${owner.id},'Reference race',2)`;
      await control`INSERT INTO messages(
        id,conversation_id,parent_id,sibling_index,role,content,status,metadata,idempotency_key
      ) VALUES
        (${rootId},${conversationId},NULL,0,'user','Question','complete','{}','race-root'),
        (${leafId},${conversationId},${rootId},0,'assistant','Answer','complete','{}','race-leaf')`;
      await control`UPDATE conversations SET active_leaf_id=${leafId} WHERE id=${conversationId}`;
      await control`INSERT INTO message_attachments(message_id,attachment_id,position)
        VALUES(${rootId},${shareAttachmentId},0)`;

      let releaseKnowledge!: () => void;
      let knowledgeLocked!: () => void;
      const knowledgeGate = new Promise<void>((resolve) => releaseKnowledge = resolve);
      const knowledgeHasLock = new Promise<void>((resolve) => knowledgeLocked = resolve);
      const knowledgeCleanup = blocker.begin(async (tx) => {
        await tx`SELECT id FROM attachments WHERE id=${knowledgeAttachmentId} FOR UPDATE`;
        knowledgeLocked();
        await knowledgeGate;
        await tx`UPDATE attachments SET state='deleted',deleted_at=now(),updated_at=now()
          WHERE id=${knowledgeAttachmentId}`;
      });
      await knowledgeHasLock;
      const link = repo.linkKnowledgeAttachment(
        collection.id,
        knowledgeAttachmentId,
        owner.id,
        collection.version,
      );
      await eventually(async () =>
        Boolean(
          (await control<{ waiting: boolean }[]>`SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity WHERE application_name=${applicationName}
              AND wait_event_type='Lock'
          ) waiting`)[0]?.waiting,
        )
      );
      releaseKnowledge();
      await knowledgeCleanup;
      await assertRejects(() => link, DomainError, "Ready attachment not found");

      let releaseShare!: () => void;
      let shareLocked!: () => void;
      const shareGate = new Promise<void>((resolve) => releaseShare = resolve);
      const shareHasLock = new Promise<void>((resolve) => shareLocked = resolve);
      const shareCleanup = blocker.begin(async (tx) => {
        await tx`SELECT id FROM attachments WHERE id=${shareAttachmentId} FOR UPDATE`;
        shareLocked();
        await shareGate;
        await tx`UPDATE attachments SET state='deleted',deleted_at=now(),updated_at=now()
          WHERE id=${shareAttachmentId}`;
      });
      await shareHasLock;
      const shareInput: CreateConversationShareInput = {
        conversationId,
        leafId,
        expectedConversationVersion: 2,
        identityVisibility: "anonymous",
        attachmentPolicy: "include",
        selectedAttachmentIds: [],
        expiresAt: null,
        idempotencyKey: `attachment-reference-race-${suffix}`,
        secretHash: "c".repeat(64),
      };
      const share = repo.createConversationShare(owner.id, shareInput);
      await eventually(async () =>
        Boolean(
          (await control<{ waiting: boolean }[]>`SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity WHERE application_name=${applicationName}
              AND wait_event_type='Lock'
          ) waiting`)[0]?.waiting,
        )
      );
      releaseShare();
      await shareCleanup;
      await assertRejects(() => share, DomainError, "Shared attachment is unavailable");
    } finally {
      await blocker.end();
      await control.end();
      await repo.close();
    }
  },
});
