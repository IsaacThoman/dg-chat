import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

function settledKinds<T>(values: PromiseSettledResult<T>[]) {
  return values.map((value) => value.status).sort();
}

Deno.test({
  name: "Postgres workspace mutations enforce ownership and optimistic concurrency",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql`TRUNCATE conversation_tag_bindings,conversation_tag_sets,conversation_tags,
      conversation_folder_memberships,conversation_folders,user_preferences,messages,
      conversations,users RESTART IDENTITY CASCADE`;
    await sql.end();
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const owner = await repo.bootstrapAdmin({
        email: "workspace-owner@database.test",
        name: "Workspace owner",
        passwordHash: "hash",
      }, 1_000_000);
      const other = await repo.createUser({
        email: "workspace-other@database.test",
        name: "Other owner",
        passwordHash: "hash",
      });

      const initial = await repo.getUserPreferences(owner.id);
      const preferences = await Promise.allSettled([
        repo.updateUserPreferences(owner.id, { expectedVersion: initial.version, theme: "dark" }),
        repo.updateUserPreferences(owner.id, {
          expectedVersion: initial.version,
          compactConversations: true,
        }),
      ]);
      assertEquals(settledKinds(preferences), ["fulfilled", "rejected"]);
      const rejectedPreference = preferences.find((value) => value.status === "rejected");
      assertEquals(
        (rejectedPreference as PromiseRejectedResult).reason instanceof DomainError,
        true,
      );
      assertEquals(
        ((rejectedPreference as PromiseRejectedResult).reason as DomainError).code,
        "version_conflict",
      );
      assertEquals((await repo.getUserPreferences(owner.id)).version, initial.version + 1);

      const source = await repo.createConversationFolder(owner.id, "Source");
      const target = await repo.createConversationFolder(owner.id, "Target");
      const alternative = await repo.createConversationFolder(owner.id, "Alternative");
      const first = await repo.createConversation(owner.id, "First");
      const second = await repo.createConversation(owner.id, "Second");
      let workspace = await repo.replaceFolderMemberships(
        owner.id,
        source.id,
        [first.id],
        { [source.id]: source.membershipVersion },
      );
      workspace = await repo.replaceFolderMemberships(
        owner.id,
        target.id,
        [second.id],
        {
          [target.id]: target.membershipVersion,
        },
      );
      const beforeMove = new Map(workspace.folders.map((folder) => [folder.id, folder]));

      const moves = await Promise.allSettled([
        repo.replaceFolderMemberships(owner.id, target.id, [second.id, first.id], {
          [source.id]: beforeMove.get(source.id)!.membershipVersion,
          [target.id]: beforeMove.get(target.id)!.membershipVersion,
        }),
        repo.replaceFolderMemberships(owner.id, alternative.id, [first.id], {
          [source.id]: beforeMove.get(source.id)!.membershipVersion,
          [alternative.id]: beforeMove.get(alternative.id)!.membershipVersion,
        }),
      ]);
      assertEquals(settledKinds(moves), ["fulfilled", "rejected"]);
      const rejectedMove = moves.find((value) => value.status === "rejected");
      assertEquals((rejectedMove as PromiseRejectedResult).reason instanceof DomainError, true);
      assertEquals(
        ((rejectedMove as PromiseRejectedResult).reason as DomainError).code,
        "version_conflict",
      );

      const finalWorkspace = await repo.listConversationFolders(owner.id);
      const firstMemberships = finalWorkspace.memberships.filter((item) =>
        item.conversationId === first.id
      );
      assertEquals(firstMemberships.length, 1);
      assertEquals(
        [target.id, alternative.id].includes(firstMemberships[0].folderId),
        true,
      );
      const finalFolders = new Map(finalWorkspace.folders.map((folder) => [folder.id, folder]));
      assertEquals(
        finalFolders.get(source.id)!.membershipVersion,
        beforeMove.get(source.id)!.membershipVersion + 1,
      );
      const winningTarget = firstMemberships[0].folderId;
      assertEquals(
        finalFolders.get(winningTarget)!.membershipVersion,
        beforeMove.get(winningTarget)!.membershipVersion + 1,
      );
      const losingTarget = winningTarget === target.id ? alternative.id : target.id;
      assertEquals(
        finalFolders.get(losingTarget)!.membershipVersion,
        beforeMove.get(losingTarget)!.membershipVersion,
      );

      await assertRejects(
        () =>
          repo.replaceFolderMemberships(other.id, target.id, [first.id], {
            [target.id]: finalFolders.get(target.id)!.membershipVersion,
          }),
        DomainError,
        "Folder not found",
      );

      const review = await repo.createConversationTag(owner.id, "Review", "#123ABC");
      const tagUpdates = await Promise.allSettled([
        repo.replaceConversationTags(owner.id, first.id, [review.id], 0),
        repo.replaceConversationTags(owner.id, first.id, [], 0),
      ]);
      assertEquals(settledKinds(tagUpdates), ["fulfilled", "rejected"]);
      assertEquals((await repo.listConversationTags(owner.id)).tagSets[0].version, 1);
      await assertRejects(
        () => repo.replaceConversationTags(other.id, first.id, [review.id], 0),
        DomainError,
        "Conversation not found",
      );
    } finally {
      await repo.close();
    }
  },
});
