import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");
const accessGroupAudit = (actorId: string) => ({
  actorId,
  action: "test.model_access_group.created",
  targetType: "model_access_group",
  requireEmailVerification: false,
  expectedAuthorityEpoch: 1,
});

Deno.test({
  name: "Postgres token governance serializes families and fails closed",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 4 });
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups,
        model_aliases,model_price_versions,provider_models,providers,ledger_entries,usage_runs,
        api_tokens,sessions,messages,conversations,users RESTART IDENTITY CASCADE`,
    );
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const user = await repo.createUser({
        email: "governance-pg@example.com",
        name: "Governance",
        role: "admin",
        approvalStatus: "approved",
      });
      const original = await repo.createApiToken(user.id, {
        name: "race",
        scopes: ["chat"],
        tokenHash: "pg-original",
        preview: "pg_o",
      }, user.authorityEpoch);
      const rotations = await Promise.allSettled([
        repo.rotateApiToken(user.id, original.id, {
          expectedVersion: original.version,
          tokenHash: "pg-next-a",
          preview: "pg_a",
          overlapSeconds: 30,
        }, user.authorityEpoch),
        repo.rotateApiToken(user.id, original.id, {
          expectedVersion: original.version,
          tokenHash: "pg-next-b",
          preview: "pg_b",
          overlapSeconds: 30,
        }, user.authorityEpoch),
      ]);
      assertEquals(rotations.filter((result) => result.status === "fulfilled").length, 1);
      assertEquals(rotations.filter((result) => result.status === "rejected").length, 1);
      const winner = rotations.find((result) => result.status === "fulfilled")!;
      const current = winner.value.replacement;

      const familyRace = await Promise.allSettled([
        repo.rotateApiToken(user.id, current.id, {
          expectedVersion: current.version,
          tokenHash: "pg-third",
          preview: "pg_3",
          overlapSeconds: 0,
        }, user.authorityEpoch),
        repo.revokeApiTokenFamily(current.id, user.id, current.version, user.authorityEpoch),
      ]);
      assertEquals(familyRace.filter((result) => result.status === "fulfilled").length, 1);
      const revokeWon = familyRace[1].status === "fulfilled";
      if (revokeWon) {
        assertEquals(await repo.authenticateApiToken("pg-next-a"), undefined);
        assertEquals(await repo.authenticateApiToken("pg-next-b"), undefined);
        assertEquals(await repo.authenticateApiToken("pg-third"), undefined);
      }

      const cutoff = await repo.createApiToken(user.id, {
        name: "cutoff",
        scopes: ["chat"],
        tokenHash: "pg-cutoff-old",
        preview: "pg_co",
      }, user.authorityEpoch);
      const cutoffRotation = await repo.rotateApiToken(user.id, cutoff.id, {
        expectedVersion: cutoff.version,
        tokenHash: "pg-cutoff-new",
        preview: "pg_cn",
        overlapSeconds: 30,
      }, user.authorityEpoch);
      assertEquals((await repo.authenticateApiToken("pg-cutoff-old"))?.id, cutoff.id);
      await sql`UPDATE api_tokens SET overlap_ends_at=now() WHERE id=${cutoff.id}`;
      assertEquals(await repo.authenticateApiToken("pg-cutoff-old"), undefined);
      assertEquals(
        (await repo.authenticateApiToken("pg-cutoff-new"))?.id,
        cutoffRotation.replacement.id,
      );
      const overlapPolicy = await repo.createApiToken(user.id, {
        name: "policy-old",
        scopes: ["chat", "files"],
        tokenHash: "pg-policy-old",
        preview: "pg_po",
        rpmLimit: 100,
        burstLimit: 20,
      }, user.authorityEpoch);
      const overlapRotated = await repo.rotateApiToken(user.id, overlapPolicy.id, {
        expectedVersion: overlapPolicy.version,
        tokenHash: "pg-policy-new",
        preview: "pg_pn",
        overlapSeconds: 60,
      }, user.authorityEpoch);
      await repo.updateApiToken(user.id, overlapRotated.replacement.id, {
        expectedVersion: overlapRotated.replacement.version,
        name: "narrowed",
        scopes: ["chat"],
        rpmLimit: 2,
        burstLimit: 1,
      }, user.authorityEpoch);
      const predecessorPolicy = await repo.authenticateApiToken("pg-policy-old");
      assertEquals(predecessorPolicy?.id, overlapPolicy.id);
      assertEquals(predecessorPolicy?.name, "narrowed");
      assertEquals(predecessorPolicy?.scopes, ["chat"]);
      assertEquals(predecessorPolicy?.rpmLimit, 2);

      const providerId = crypto.randomUUID(),
        m1 = crypto.randomUUID(),
        m2 = crypto.randomUUID(),
        publicModel = crypto.randomUUID(),
        disabledModel = crypto.randomUUID();
      await sql`INSERT INTO providers(id,slug,display_name,base_url,protocol) VALUES(${providerId},'governance','Governance','https://example.com/v1','responses')`;
      await sql`INSERT INTO provider_models(id,provider_id,public_model_id,upstream_model_id,display_name,capabilities,context_window,enabled) VALUES(${m1},${providerId},'group/one','one','One','["chat"]',1000,true),(${m2},${providerId},'group/two','two','Two','["chat"]',1000,true),(${publicModel},${providerId},'public/model','public','Public','["chat"]',1000,true),(${disabledModel},${providerId},'disabled/model','disabled','Disabled','["chat"]',1000,false)`;
      const other = await repo.createUser({
        email: "other-governance-pg@example.com",
        name: "Other",
      });
      const restricted = await repo.createApiToken(user.id, {
        name: "restricted",
        scopes: ["chat"],
        tokenHash: "pg-restricted",
        preview: "pg_r",
      }, user.authorityEpoch);
      const g1 = await repo.createAccessGroup(
          { name: "Group One" },
          accessGroupAudit(user.id),
        ),
        g2 = await repo.createAccessGroup(
          { name: "Group Two" },
          accessGroupAudit(user.id),
        );
      const p1 = await repo.replaceAccessGroupPolicy(g1.id, {
        expectedVersion: g1.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [restricted.id],
        acknowledgePublicModelIds: [],
      }, accessGroupAudit(user.id));
      await repo.replaceAccessGroupPolicy(g2.id, {
        expectedVersion: g2.version,
        userIds: [user.id],
        modelIds: [m2],
        tokenIds: [],
        acknowledgePublicModelIds: [],
      }, accessGroupAudit(user.id));
      const alias = await repo.createModelAlias(
        { alias: "friendly/one", targetModelId: m1 },
        {
          actorId: user.id,
          action: "test.model_alias.created",
          targetType: "model_alias",
          requireEmailVerification: false,
          expectedAuthorityEpoch: user.authorityEpoch,
        },
      );
      const userCatalog = await repo.listEntitledProviderModels({ userId: user.id });
      assertEquals(userCatalog.map((model) => model.id).sort(), [m1, m2, publicModel].sort());
      assertEquals(
        await repo.resolveEntitledProviderModel({ userId: user.id }, "disabled/model"),
        undefined,
      );
      assertEquals(
        (await repo.resolveEntitledProviderModel({ userId: user.id }, alias.alias))?.model.id,
        m1,
      );
      const restrictedCatalog = await repo.listEntitledProviderModels({
        userId: user.id,
        tokenId: restricted.id,
      });
      assertEquals(restrictedCatalog.map((model) => model.id).sort(), [m1, publicModel].sort());
      assertEquals(
        (await repo.resolveEntitledProviderModel(
          { userId: user.id, tokenId: restricted.id },
          "friendly/one",
        ))?.model.id,
        m1,
      );
      assertEquals(
        await repo.resolveEntitledProviderModel(
          { userId: user.id, tokenId: restricted.id },
          "group/two",
        ),
        undefined,
      );
      assertEquals(
        await repo.listEntitledProviderModels({ userId: other.id, tokenId: restricted.id }),
        [],
      );
      const inherit = await repo.createApiToken(user.id, {
        name: "inherit",
        scopes: ["chat"],
        tokenHash: "pg-inherit",
        preview: "pg_i",
      }, user.authorityEpoch);
      assertEquals(
        (await repo.listEntitledProviderModels({ userId: user.id, tokenId: inherit.id })).map(
          (model) => model.id,
        ).sort(),
        [m1, m2, publicModel].sort(),
      );
      const lookup = (await repo.searchApiTokens(accessGroupAudit(user.id), "restricted")).data[0];
      assertEquals(lookup.name, "restricted");
      assertEquals(lookup.ownerName, "Governance");
      assertEquals(lookup.accessMode, "restricted");
      assertEquals(lookup.version, restricted.version + 1);
      const foreignGroup = await repo.createAccessGroup(
        { name: "Other only" },
        accessGroupAudit(user.id),
      );
      await repo.replaceAccessGroupPolicy(foreignGroup.id, {
        expectedVersion: foreignGroup.version,
        userIds: [other.id],
        modelIds: [],
        tokenIds: [],
        acknowledgePublicModelIds: [],
      }, accessGroupAudit(user.id));
      await assertRejects(
        () =>
          repo.setTokenAccessGroups(
            user.id,
            restricted.id,
            [foreignGroup.id],
            lookup.version,
            {
              actorId: user.id,
              action: "api_token.access_groups_set",
              targetType: "api_token",
              targetId: restricted.id,
              requireEmailVerification: false,
              expectedAuthorityEpoch: user.authorityEpoch,
            },
          ),
        DomainError,
        "held by the owner",
      );
      assertEquals(
        (await repo.searchApiTokens(accessGroupAudit(user.id), "restricted")).data[0].groupIds,
        [g1.id],
      );
      await assertRejects(
        () =>
          repo.replaceAccessGroupPolicy(g1.id, {
            expectedVersion: g1.version,
            userIds: [],
            modelIds: [],
            tokenIds: [],
            acknowledgePublicModelIds: [],
          }, accessGroupAudit(user.id)),
        DomainError,
        "modified",
      );
      const emptied = await repo.replaceAccessGroupPolicy(g1.id, {
        expectedVersion: p1.version,
        userIds: [],
        modelIds: [],
        tokenIds: [],
        acknowledgePublicModelIds: [m1],
      }, accessGroupAudit(user.id));
      assertEquals(emptied.tokenIds, []);
      assertEquals(
        await repo.resolveEntitledProviderModel(
          { userId: user.id, tokenId: restricted.id },
          "group/two",
        ),
        undefined,
      );
      assertEquals(
        (await repo.listEntitledProviderModels({ userId: user.id, tokenId: restricted.id })).map(
          (model) => model.id,
        ).sort(),
        [m1, publicModel].sort(),
      );
      const after = (await repo.searchApiTokens(accessGroupAudit(user.id), "restricted")).data[0];
      assertEquals(after.accessMode, "restricted");
      assertEquals(after.groupIds, []);
      assertEquals(after.version, restricted.version + 2);

      const previewFamilyToken = await repo.createApiToken(user.id, {
        name: "preview-family",
        scopes: ["chat"],
        tokenHash: "pg-preview-family-old",
        preview: "pg_pf",
      }, user.authorityEpoch);
      const previewGroup = await repo.createAccessGroup(
        { name: "Preview family" },
        accessGroupAudit(user.id),
      );
      const previewSaved = await repo.replaceAccessGroupPolicy(previewGroup.id, {
        expectedVersion: previewGroup.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [previewFamilyToken.id],
        acknowledgePublicModelIds: [],
      }, accessGroupAudit(user.id));
      const previewCurrent = (await repo.listApiTokens(user.id)).find((candidate) =>
        candidate.id === previewFamilyToken.id
      )!;
      const previewRotation = await repo.rotateApiToken(user.id, previewFamilyToken.id, {
        expectedVersion: previewCurrent.version,
        tokenHash: "pg-preview-family-new",
        preview: "pg_pfn",
        overlapSeconds: 30,
      }, user.authorityEpoch);
      assertEquals(
        (await repo.previewAccessGroupPolicyImpact(accessGroupAudit(user.id), previewGroup.id, {
          userIds: [user.id],
          modelIds: [m1],
          tokenIds: [previewRotation.replacement.id],
        })).tokenIdsLosingGroupAccess,
        [],
      );
      assertEquals(
        (await repo.replaceAccessGroupPolicy(previewGroup.id, {
          expectedVersion: previewSaved.version,
          userIds: [user.id],
          modelIds: [m1],
          tokenIds: [previewRotation.replacement.id],
          acknowledgePublicModelIds: [],
        }, accessGroupAudit(user.id))).tokenIds.sort(),
        [previewFamilyToken.id, previewRotation.replacement.id].sort(),
      );

      // Hold policy replacement after it has locked the group row but before it can take the token
      // family lock. A real rotation must still copy its group membership through the FK while the
      // policy holds NO KEY UPDATE; FOR UPDATE here creates a group-row <-> family-lock deadlock.
      const racedToken = await repo.createApiToken(user.id, {
        name: "policy-race",
        scopes: ["chat"],
        tokenHash: "pg-policy-race-old",
        preview: "pg_pro",
      }, user.authorityEpoch);
      const policyActor = await repo.createUser({
        email: "policy-race-admin@example.test",
        name: "Policy race administrator",
        role: "admin",
        approvalStatus: "approved",
      });
      const racedGroup = await repo.createAccessGroup(
        { name: "Policy race" },
        accessGroupAudit(user.id),
      );
      const racedSaved = await repo.replaceAccessGroupPolicy(racedGroup.id, {
        expectedVersion: racedGroup.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [racedToken.id],
        acknowledgePublicModelIds: [],
      }, {
        actorId: policyActor.id,
        action: "test.model_access_group.policy_replaced",
        targetType: "model_access_group",
        targetId: racedGroup.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: policyActor.authorityEpoch,
      });
      let signalModelLocked!: () => void;
      let releaseModelLock!: () => void;
      const modelLocked = new Promise<void>((resolve) => signalModelLocked = resolve);
      const releaseModel = new Promise<void>((resolve) => releaseModelLock = resolve);
      const modelLock = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(
          hashtextextended(${`dg-chat:model-access:${m1}`}, 0)
        )`;
        signalModelLocked();
        await releaseModel;
      });
      await modelLocked;
      const racedPolicy = repo.replaceAccessGroupPolicy(racedGroup.id, {
        expectedVersion: racedSaved.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [racedToken.id],
        acknowledgePublicModelIds: [],
      }, {
        actorId: policyActor.id,
        action: "test.model_access_group.policy_replaced",
        targetType: "model_access_group",
        targetId: racedGroup.id,
        requireEmailVerification: false,
        expectedAuthorityEpoch: policyActor.authorityEpoch,
      });
      let policyOwnsGroupRow = false;
      for (let attempt = 0; attempt < 100 && !policyOwnsGroupRow; attempt++) {
        try {
          await sql.begin(async (tx) => {
            await tx`SELECT id FROM access_groups WHERE id=${racedGroup.id} FOR UPDATE NOWAIT`;
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch (error) {
          if ((error as { code?: string }).code !== "55P03") throw error;
          policyOwnsGroupRow = true;
        }
      }
      if (!policyOwnsGroupRow) {
        releaseModelLock();
        await modelLock;
        await Promise.allSettled([racedPolicy]);
        throw new Error("policy did not acquire its group-row lock before the regression deadline");
      }
      const racedCurrent = (await repo.listApiTokens(user.id)).find((candidate) =>
        candidate.id === racedToken.id
      )!;
      const realRotation = repo.rotateApiToken(user.id, racedToken.id, {
        expectedVersion: racedCurrent.version,
        tokenHash: "pg-policy-race-new",
        preview: "pg_prn",
        overlapSeconds: 30,
      }, user.authorityEpoch);
      // Policy now locks every affected owner before its group row. Rotation therefore queues on
      // the owner instead of running through the in-flight policy transaction. Releasing the model
      // lock lets policy commit first; rotation then copies the committed group membership to its
      // replacement generation.
      releaseModelLock();
      await modelLock;
      const [rotation, savedPolicy] = await Promise.all([realRotation, racedPolicy]);
      assertEquals(
        new Set(
          (await repo.listAccessGroups(accessGroupAudit(user.id))).find((group) =>
            group.id === savedPolicy.id
          )!.tokenIds,
        ),
        new Set([racedToken.id, rotation.replacement.id]),
      );
      assertEquals(
        savedPolicy.tokenIds.sort(),
        [racedToken.id],
      );
      assertEquals(
        (await repo.listAccessGroups(accessGroupAudit(user.id))).find((group) =>
          group.id === savedPolicy.id
        )!.tokenIds
          .sort(),
        [racedToken.id, rotation.replacement.id].sort(),
      );

      const canonical = await repo.createProviderModel({
        providerId,
        publicModelId: "canonical/id",
        upstreamModelId: "c",
        displayName: "Canonical",
        capabilities: ["chat"],
        contextWindow: 1000,
      }, { actorId: user.id, action: "test" });
      await assertRejects(
        () =>
          repo.createModelAlias(
            { alias: canonical.publicModelId, targetModelId: canonical.id },
            {
              actorId: user.id,
              action: "test.model_alias.created",
              targetType: "model_alias",
              requireEmailVerification: false,
              expectedAuthorityEpoch: user.authorityEpoch,
            },
          ),
        DomainError,
        "collides",
      );
      await repo.createModelAlias(
        { alias: "alias/id", targetModelId: canonical.id },
        {
          actorId: user.id,
          action: "test.model_alias.created",
          targetType: "model_alias",
          requireEmailVerification: false,
          expectedAuthorityEpoch: user.authorityEpoch,
        },
      );
      await assertRejects(
        () =>
          repo.createProviderModel({
            providerId,
            publicModelId: "alias/id",
            upstreamModelId: "a",
            displayName: "Alias collision",
            capabilities: ["chat"],
            contextWindow: 1000,
          }, { actorId: user.id, action: "test" }),
        DomainError,
        "alias",
      );
      await repo.createAccessGroup({ name: "Case Name" }, accessGroupAudit(user.id));
      await assertRejects(() =>
        repo.createAccessGroup({ name: "case name" }, accessGroupAudit(user.id))
      );
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres access-group widening acknowledgement is exact and serialized per model",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 4 });
    await runAuditTestMaintenanceSql(
      sql,
      `TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups,
        model_aliases,model_price_versions,provider_models,providers,ledger_entries,usage_runs,
        api_tokens,sessions,messages,conversations,users RESTART IDENTITY CASCADE`,
    );
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const actor = await repo.createUser({
        email: "widening-ack-admin@example.test",
        name: "Widening acknowledgement admin",
        role: "admin",
        approvalStatus: "approved",
      });
      const providerId = crypto.randomUUID();
      const restrictedModelId = crypto.randomUUID();
      const unrelatedModelId = crypto.randomUUID();
      await sql`INSERT INTO providers(id,slug,display_name,base_url,protocol)
        VALUES(${providerId},'widening-ack','Widening acknowledgement',
          'https://example.com/v1','responses')`;
      await sql`INSERT INTO provider_models(
          id,provider_id,public_model_id,upstream_model_id,display_name,
          capabilities,context_window,enabled
        ) VALUES
        (${restrictedModelId},${providerId},'ack/restricted','restricted','Restricted',
          '["chat"]',1000,true),
        (${unrelatedModelId},${providerId},'ack/unrelated','unrelated','Unrelated',
          '["chat"]',1000,true)`;
      const sourceGroup = await repo.createAccessGroup(
        { name: "Acknowledgement source" },
        accessGroupAudit(actor.id),
      );
      const destinationGroup = await repo.createAccessGroup(
        { name: "Acknowledgement destination" },
        accessGroupAudit(actor.id),
      );
      let source = await repo.replaceAccessGroupModels(
        sourceGroup.id,
        [restrictedModelId],
        sourceGroup.version,
        [],
        accessGroupAudit(actor.id),
      );

      for (const acknowledgement of [[], [restrictedModelId, unrelatedModelId]]) {
        const error = await assertRejects(
          () =>
            repo.replaceAccessGroupModels(
              source.id,
              [],
              source.version,
              acknowledgement,
              accessGroupAudit(actor.id),
            ),
          DomainError,
        );
        assertEquals(error.code, "model_access_widening_acknowledgement_required");
        assertEquals(
          (await repo.listAccessGroups(accessGroupAudit(actor.id))).find((group) =>
            group.id === source.id
          ),
          source,
        );
      }
      const policyError = await assertRejects(
        () =>
          repo.replaceAccessGroupPolicy(source.id, {
            expectedVersion: source.version,
            name: "Must not persist",
            userIds: [],
            modelIds: [],
            tokenIds: [],
            acknowledgePublicModelIds: [],
          }, accessGroupAudit(actor.id)),
        DomainError,
      );
      assertEquals(policyError.code, "model_access_widening_acknowledgement_required");
      assertEquals(
        (await repo.listAccessGroups(accessGroupAudit(actor.id))).find((group) =>
          group.id === source.id
        ),
        source,
      );

      const whileExactModelLockIsHeld = async <T>(mutation: () => Promise<T>): Promise<T> => {
        let signalLocked!: () => void;
        let releaseLock!: () => void;
        const locked = new Promise<void>((resolve) => signalLocked = resolve);
        const release = new Promise<void>((resolve) => releaseLock = resolve);
        const lockTransaction = sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(
            hashtextextended(${`dg-chat:model-access:${restrictedModelId}`}, 0)
          )`;
          signalLocked();
          await release;
        });
        await locked;
        const result = mutation();
        let settled = false;
        void result.finally(() => settled = true).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assertEquals(settled, false);
        releaseLock();
        await lockTransaction;
        return await result;
      };

      // Publish the same restriction in another group while the repository mutation is waiting
      // for the model lock. Once the competing transaction commits, the originally supplied
      // acknowledgement is extra and must be rejected from the newly locked state.
      let signalStaged!: () => void;
      let releaseAddition!: () => void;
      const staged = new Promise<void>((resolve) => signalStaged = resolve);
      const release = new Promise<void>((resolve) => releaseAddition = resolve);
      const rawAddition = sql.begin(async (tx) => {
        await tx`SELECT version FROM access_groups WHERE id=${destinationGroup.id} FOR UPDATE`;
        await tx`SELECT pg_advisory_xact_lock(
          hashtextextended(${`dg-chat:model-access:${restrictedModelId}`}, 0)
        )`;
        await tx`INSERT INTO access_group_models(group_id,provider_model_id)
          VALUES(${destinationGroup.id},${restrictedModelId})`;
        signalStaged();
        await release;
      });
      await staged;
      const racedRemoval = repo.replaceAccessGroupModels(
        source.id,
        [],
        source.version,
        [restrictedModelId],
        accessGroupAudit(actor.id),
      );
      let racedRemovalSettled = false;
      void racedRemoval.finally(() => racedRemovalSettled = true).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assertEquals(racedRemovalSettled, false);
      releaseAddition();
      await rawAddition;
      const raceError = await assertRejects(() => racedRemoval, DomainError);
      assertEquals(raceError.code, "model_access_widening_acknowledgement_required");
      assertEquals(
        (await repo.listAccessGroups(accessGroupAudit(actor.id))).find((group) =>
          group.id === source.id
        ),
        source,
      );

      source = await repo.replaceAccessGroupModels(
        source.id,
        [],
        source.version,
        [],
        accessGroupAudit(actor.id),
      );
      assertEquals(source.modelIds, []);
      source = await repo.replaceAccessGroupModels(
        source.id,
        [restrictedModelId],
        source.version,
        [],
        accessGroupAudit(actor.id),
      );
      source = await whileExactModelLockIsHeld(() =>
        repo.replaceAccessGroupPolicy(source.id, {
          expectedVersion: source.version,
          userIds: [],
          modelIds: [],
          tokenIds: [],
          acknowledgePublicModelIds: [],
        }, accessGroupAudit(actor.id))
      );
      source = await repo.replaceAccessGroupModels(
        source.id,
        [restrictedModelId],
        source.version,
        [],
        accessGroupAudit(actor.id),
      );
      await whileExactModelLockIsHeld(() =>
        repo.deleteAccessGroup(source.id, source.version, [], accessGroupAudit(actor.id))
      );
      assertEquals(
        (await repo.listAccessGroups(accessGroupAudit(actor.id))).some((group) =>
          group.id === source.id
        ),
        false,
      );
      const destination = (await repo.listAccessGroups(accessGroupAudit(actor.id))).find((group) =>
        group.id === destinationGroup.id
      )!;
      const deleteError = await assertRejects(
        () =>
          repo.deleteAccessGroup(
            destination.id,
            destination.version,
            [],
            accessGroupAudit(actor.id),
          ),
        DomainError,
      );
      assertEquals(deleteError.code, "model_access_widening_acknowledgement_required");
      await repo.deleteAccessGroup(
        destination.id,
        destination.version,
        [restrictedModelId],
        accessGroupAudit(actor.id),
      );
      assertEquals(
        (await repo.listAccessGroups(accessGroupAudit(actor.id))).some((group) =>
          group.id === destination.id
        ),
        false,
      );
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});
