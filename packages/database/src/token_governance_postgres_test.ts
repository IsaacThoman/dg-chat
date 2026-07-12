import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres token governance serializes families and fails closed",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 4 });
    await sql`TRUNCATE access_group_tokens,access_group_models,access_group_users,access_groups,
      model_aliases,model_price_versions,provider_models,providers,ledger_entries,usage_runs,
      api_tokens,sessions,messages,conversations,users RESTART IDENTITY CASCADE`;
    const repo = await PostgresRepository.connect(databaseUrl!);
    try {
      const user = await repo.createUser({
        email: "governance-pg@example.com",
        name: "Governance",
      });
      const original = await repo.createApiToken(user.id, {
        name: "race",
        scopes: ["chat"],
        tokenHash: "pg-original",
        preview: "pg_o",
      });
      const rotations = await Promise.allSettled([
        repo.rotateApiToken(user.id, original.id, {
          expectedVersion: original.version,
          tokenHash: "pg-next-a",
          preview: "pg_a",
          overlapSeconds: 30,
        }),
        repo.rotateApiToken(user.id, original.id, {
          expectedVersion: original.version,
          tokenHash: "pg-next-b",
          preview: "pg_b",
          overlapSeconds: 30,
        }),
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
        }),
        repo.revokeApiTokenFamily(current.id, user.id, current.version),
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
      });
      const cutoffRotation = await repo.rotateApiToken(user.id, cutoff.id, {
        expectedVersion: cutoff.version,
        tokenHash: "pg-cutoff-new",
        preview: "pg_cn",
        overlapSeconds: 30,
      });
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
      });
      const overlapRotated = await repo.rotateApiToken(user.id, overlapPolicy.id, {
        expectedVersion: overlapPolicy.version,
        tokenHash: "pg-policy-new",
        preview: "pg_pn",
        overlapSeconds: 60,
      });
      await repo.updateApiToken(user.id, overlapRotated.replacement.id, {
        expectedVersion: overlapRotated.replacement.version,
        name: "narrowed",
        scopes: ["chat"],
        rpmLimit: 2,
        burstLimit: 1,
      });
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
      });
      const g1 = await repo.createAccessGroup({ name: "Group One" }),
        g2 = await repo.createAccessGroup({ name: "Group Two" });
      const p1 = await repo.replaceAccessGroupPolicy(g1.id, {
        expectedVersion: g1.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [restricted.id],
      });
      await repo.replaceAccessGroupPolicy(g2.id, {
        expectedVersion: g2.version,
        userIds: [user.id],
        modelIds: [m2],
        tokenIds: [],
      });
      const alias = await repo.createModelAlias({ alias: "friendly/one", targetModelId: m1 });
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
      });
      assertEquals(
        (await repo.listEntitledProviderModels({ userId: user.id, tokenId: inherit.id })).map(
          (model) => model.id,
        ).sort(),
        [m1, m2, publicModel].sort(),
      );
      const lookup = (await repo.searchApiTokens("restricted")).data[0];
      assertEquals(lookup.name, "restricted");
      assertEquals(lookup.ownerName, "Governance");
      assertEquals(lookup.accessMode, "restricted");
      assertEquals(lookup.version, restricted.version + 1);
      const foreignGroup = await repo.createAccessGroup({ name: "Other only" });
      await repo.replaceAccessGroupPolicy(foreignGroup.id, {
        expectedVersion: foreignGroup.version,
        userIds: [other.id],
        modelIds: [],
        tokenIds: [],
      });
      await assertRejects(
        () => repo.setTokenAccessGroups(user.id, restricted.id, [foreignGroup.id], lookup.version),
        DomainError,
        "held by the owner",
      );
      assertEquals((await repo.searchApiTokens("restricted")).data[0].groupIds, [g1.id]);
      await assertRejects(
        () =>
          repo.replaceAccessGroupPolicy(g1.id, {
            expectedVersion: g1.version,
            userIds: [],
            modelIds: [],
            tokenIds: [],
          }),
        DomainError,
        "modified",
      );
      const emptied = await repo.replaceAccessGroupPolicy(g1.id, {
        expectedVersion: p1.version,
        userIds: [],
        modelIds: [],
        tokenIds: [],
      });
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
      const after = (await repo.searchApiTokens("restricted")).data[0];
      assertEquals(after.accessMode, "restricted");
      assertEquals(after.groupIds, []);
      assertEquals(after.version, restricted.version + 2);

      const previewFamilyToken = await repo.createApiToken(user.id, {
        name: "preview-family",
        scopes: ["chat"],
        tokenHash: "pg-preview-family-old",
        preview: "pg_pf",
      });
      const previewGroup = await repo.createAccessGroup({ name: "Preview family" });
      const previewSaved = await repo.replaceAccessGroupPolicy(previewGroup.id, {
        expectedVersion: previewGroup.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [previewFamilyToken.id],
      });
      const previewCurrent = (await repo.listApiTokens(user.id)).find((candidate) =>
        candidate.id === previewFamilyToken.id
      )!;
      const previewRotation = await repo.rotateApiToken(user.id, previewFamilyToken.id, {
        expectedVersion: previewCurrent.version,
        tokenHash: "pg-preview-family-new",
        preview: "pg_pfn",
        overlapSeconds: 30,
      });
      assertEquals(
        (await repo.previewAccessGroupPolicyImpact(previewGroup.id, {
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
        })).tokenIds.sort(),
        [previewFamilyToken.id, previewRotation.replacement.id].sort(),
      );

      // Hold a rotation open after inserting its generation. The policy transaction must wait on
      // the family lock and then re-expand, otherwise the just-created generation escapes policy.
      const racedToken = await repo.createApiToken(user.id, {
        name: "policy-race",
        scopes: ["chat"],
        tokenHash: "pg-policy-race-old",
        preview: "pg_pro",
      });
      const racedGroup = await repo.createAccessGroup({ name: "Policy race" });
      const racedSaved = await repo.replaceAccessGroupPolicy(racedGroup.id, {
        expectedVersion: racedGroup.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [racedToken.id],
      });
      const racedReplacementId = crypto.randomUUID();
      let signalStaged!: () => void;
      let releaseRotation!: () => void;
      const staged = new Promise<void>((resolve) => signalStaged = resolve);
      const release = new Promise<void>((resolve) => releaseRotation = resolve);
      const rawRotation = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${racedToken.rotationFamilyId}))`;
        await tx`INSERT INTO api_tokens(id,user_id,name,token_hash,preview,scopes,version,
          rpm_limit,burst_limit,access_mode,rotation_family_id,rotation_generation,
          rotated_from_token_id,expires_at)
          SELECT ${racedReplacementId},user_id,name,'pg-policy-race-new','pg_prn',scopes,1,
          rpm_limit,burst_limit,access_mode,rotation_family_id,rotation_generation+1,id,expires_at
          FROM api_tokens WHERE id=${racedToken.id}`;
        await tx`INSERT INTO access_group_tokens(group_id,token_id,user_id)
          SELECT group_id,${racedReplacementId},user_id FROM access_group_tokens
          WHERE token_id=${racedToken.id}`;
        await tx`UPDATE api_tokens SET replaced_by_token_id=${racedReplacementId},
          overlap_ends_at=now()+interval '30 seconds',version=version+1 WHERE id=${racedToken.id}`;
        signalStaged();
        await release;
      });
      await staged;
      const racedPolicy = repo.replaceAccessGroupPolicy(racedGroup.id, {
        expectedVersion: racedSaved.version,
        userIds: [user.id],
        modelIds: [m1],
        tokenIds: [racedToken.id],
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseRotation();
      await rawRotation;
      assertEquals(
        (await racedPolicy).tokenIds.sort(),
        [racedToken.id, racedReplacementId].sort(),
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
          repo.createModelAlias({ alias: canonical.publicModelId, targetModelId: canonical.id }),
        DomainError,
        "collides",
      );
      await repo.createModelAlias({ alias: "alias/id", targetModelId: canonical.id });
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
      await repo.createAccessGroup({ name: "Case Name" });
      await assertRejects(() => repo.createAccessGroup({ name: "case name" }));
    } finally {
      await repo.close();
      await sql.end();
    }
  },
});
