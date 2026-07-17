import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import postgres from "npm:postgres@3.4.7";
import { DomainError } from "./memory.ts";
import { PostgresRepository } from "./normalized-postgres.ts";
import { runAuditTestMaintenanceSql } from "./postgres-test-maintenance.ts";

const databaseUrl = Deno.env.get("TEST_DATABASE_URL");

Deno.test({
  name: "Postgres community profile CAS and audit commit atomically",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE community_profiles,audit_events,users RESTART IDENTITY CASCADE`,
      );
      await sql.unsafe(`
        CREATE TABLE dg_test_failed_community_audits(enabled boolean PRIMARY KEY);
        CREATE FUNCTION dg_test_fail_community_audit()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF NEW.action='community.profile_updated' AND EXISTS(
            SELECT 1 FROM public.dg_test_failed_community_audits WHERE enabled
          ) THEN
            RAISE EXCEPTION 'injected community-profile audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER dg_test_fail_community_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION dg_test_fail_community_audit();
      `);
      const owner = await repository.createUser({
        email: "community-postgres@example.test",
        name: "Community PostgreSQL",
        approvalStatus: "approved",
      });
      const initial = await repository.getCommunityProfile(owner.id);
      assertEquals(initial.optedIn, false);
      assertEquals(initial.identityMode, "anonymous");
      assertEquals(initial.shareBalance, false);

      await sql`INSERT INTO dg_test_failed_community_audits(enabled) VALUES(true)`;
      await assertRejects(
        () =>
          repository.updateCommunityProfile(
            owner.id,
            {
              expectedVersion: 1,
              optedIn: true,
              identityMode: "nickname",
              nickname: "Postgres-user",
              shareBalance: true,
            },
            { actorId: owner.id },
          ),
        Error,
        "injected community-profile audit failure",
      );
      assertEquals(await repository.getCommunityProfile(owner.id), initial);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE action='community.profile_updated'`)[0].count,
        ),
        0,
      );

      await sql`DELETE FROM dg_test_failed_community_audits`;
      const updated = await repository.updateCommunityProfile(
        owner.id,
        {
          expectedVersion: 1,
          optedIn: true,
          identityMode: "nickname",
          nickname: "Postgres-user",
          color: "emerald",
          shareBalance: true,
        },
        { actorId: owner.id },
      );
      assertEquals(updated.version, 2);
      const [audit] = await sql`
        SELECT actor_id,target_type,target_id,metadata FROM audit_events
        WHERE action='community.profile_updated'
      `;
      assertEquals(String(audit.actor_id), owner.id);
      assertEquals(audit.target_type, "community_profile");
      assertEquals(audit.target_id, owner.id);
      assertEquals((audit.metadata as Record<string, unknown>).nicknameChanged, true);
      assertEquals("nickname" in (audit.metadata as Record<string, unknown>), false);

      const concurrent = await Promise.allSettled([
        repository.updateCommunityProfile(
          owner.id,
          { expectedVersion: 2, color: "blue" },
          { actorId: owner.id },
        ),
        repository.updateCommunityProfile(
          owner.id,
          { expectedVersion: 2, color: "rose" },
          { actorId: owner.id },
        ),
      ]);
      assertEquals(concurrent.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = concurrent.find((result) => result.status === "rejected");
      assertEquals(rejected?.status, "rejected");
      if (rejected?.status === "rejected") {
        assertEquals(rejected.reason instanceof DomainError, true);
        assertEquals((rejected.reason as DomainError).code, "version_conflict");
      }
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE action='community.profile_updated'`)[0].count,
        ),
        2,
      );
      const afterConcurrent = await repository.getCommunityProfile(owner.id);
      assertEquals(afterConcurrent.version, 3);
      const optedOut = await repository.updateCommunityProfile(
        owner.id,
        { expectedVersion: 3, optedIn: false },
        { actorId: owner.id },
      );
      await assertRejects(
        () =>
          repository.updateCommunityProfile(
            owner.id,
            { expectedVersion: 4, shareBalance: true },
            { actorId: owner.id },
          ),
        TypeError,
        "Balance sharing requires leaderboard participation",
      );
      assertEquals(await repository.getCommunityProfile(owner.id), optedOut);
      assertEquals(
        Number(
          (await sql`SELECT count(*) count FROM audit_events
            WHERE action='community.profile_updated'`)[0].count,
        ),
        3,
      );
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS dg_test_fail_community_audit ON audit_events;
        DROP FUNCTION IF EXISTS dg_test_fail_community_audit();
        DROP TABLE IF EXISTS dg_test_failed_community_audits;
      `).catch(() => undefined);
      await repository.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "Postgres community ranking applies billed settlement, eligibility, consent, and keysets",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { max: 3 });
    const repository = await PostgresRepository.connect(databaseUrl!);
    try {
      await runAuditTestMaintenanceSql(
        sql,
        `TRUNCATE community_profiles,audit_events,usage_runs,users RESTART IDENTITY CASCADE`,
      );
      const users = await Promise.all([
        repository.createUser({
          id: "30000000-0000-4000-8000-000000000001",
          email: "rank-a@example.test",
          name: "Private A",
          approvalStatus: "approved",
        }),
        repository.createUser({
          id: "30000000-0000-4000-8000-000000000002",
          email: "rank-b@example.test",
          name: "Private B",
          approvalStatus: "approved",
        }),
        repository.createUser({
          id: "30000000-0000-4000-8000-000000000003",
          email: "rank-c@example.test",
          name: "Private C",
          approvalStatus: "approved",
        }),
      ]);
      for (const [index, user] of users.entries()) {
        await repository.updateCommunityProfile(
          user.id,
          {
            expectedVersion: 1,
            optedIn: true,
            identityMode: index === 0 ? "nickname" : "anonymous",
            ...(index === 0 ? { nickname: "Rank-A" } : {}),
            shareBalance: index !== 1,
          },
          { actorId: user.id },
        );
      }
      await sql`UPDATE users SET balance_micros=CASE id
        WHEN ${users[0].id}::uuid THEN 3000000
        WHEN ${users[1].id}::uuid THEN 9000000
        ELSE 1000000 END`;
      await sql`INSERT INTO usage_runs(
        id,user_id,model,provider,recovery_owner,status,input_tokens,output_tokens,cost_micros,
        created_at,completed_at
      ) VALUES
        ('community-rank-a',${users[0].id},'test/model','test','provider','completed',4,6,100,
          '2026-07-01T00:00:00Z','2026-07-16T00:00:00Z'),
        ('community-rank-b',${users[1].id},'test/model','test','provider','failed',8,2,200,
          '2026-07-01T00:00:00Z','2026-07-16T00:00:00Z'),
        ('community-rank-old',${users[0].id},'test/model','test','provider','completed',25,25,300,
          '2026-04-01T00:00:00Z','2026-05-01T00:00:00Z'),
        ('community-rank-unbilled',${users[2].id},'test/model','test','provider','failed',999,1,0,
          '2026-07-01T00:00:00Z','2026-07-16T00:00:00Z')`;
      const query = {
        metric: "tokens" as const,
        window: "7d" as const,
        from: "2026-07-10T12:00:00.000Z",
        asOf: "2026-07-17T12:00:00.000Z",
        limit: 1,
      };
      const first = await repository.listCommunityLeaderboard(query);
      assertEquals(first.data.map((row) => [row.userId, row.value]), [[users[0].id, 10]]);
      assertEquals(first.nextBoundary?.position, 1);
      const tiedPage = await repository.listCommunityLeaderboard({
        ...query,
        after: first.nextBoundary!,
      });
      assertEquals(tiedPage.data.map((row) => [row.userId, row.value, row.position]), [
        [users[1].id, 10, 1],
      ]);
      const lowerPage = await repository.listCommunityLeaderboard({
        ...query,
        after: tiedPage.nextBoundary!,
      });
      assertEquals(lowerPage.data.map((row) => [row.userId, row.value, row.position]), [
        [users[2].id, 0, 2],
      ]);
      assertEquals(
        (await repository.listCommunityLeaderboard({
          metric: "tokens",
          window: "90d",
          from: "2026-04-18T12:00:00.000Z",
          asOf: query.asOf,
          limit: 10,
        })).data.map((row) => [row.userId, row.value, row.position]),
        [
          [users[0].id, 60, 1],
          [users[1].id, 10, 2],
          [users[2].id, 0, 3],
        ],
      );

      // A late settlement cannot enter an already-issued time window. Revoking consent remains
      // live and wins immediately, including between keyset pages.
      await sql`INSERT INTO usage_runs(
        id,user_id,model,provider,recovery_owner,status,input_tokens,output_tokens,cost_micros,
        created_at,completed_at
      ) VALUES(
        'community-rank-late',${users[2].id},'test/model','test','provider','completed',500,500,10,
        '2026-07-01T00:00:00Z','2026-07-18T00:00:00Z'
      )`;
      await repository.updateCommunityProfile(
        users[1].id,
        { expectedVersion: 2, optedIn: false },
        { actorId: users[1].id },
      );
      const second = await repository.listCommunityLeaderboard({
        ...query,
        after: first.nextBoundary!,
      });
      assertEquals(second.data.map((row) => [row.userId, row.value]), [[users[2].id, 0]]);

      const balance = await repository.listCommunityLeaderboard({
        metric: "balance",
        window: "current",
        from: null,
        asOf: query.asOf,
        limit: 10,
      });
      assertEquals(balance.data.map((row) => [row.userId, row.value]), [
        [users[0].id, 3_000_000],
        [users[2].id, 1_000_000],
      ]);
    } finally {
      await repository.close();
      await sql.end();
    }
  },
});
