import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FailingCommunityAuditRepository extends MemoryRepository {
  failAudit = false;

  override recordAudit(input: AuditEventInput) {
    if (this.failAudit && input.action === "community.profile_updated") {
      throw new Error("injected community-profile audit failure");
    }
    return super.recordAudit(input);
  }
}

Deno.test("memory community profiles default private and update with atomic consent audit", () => {
  const repository = new FailingCommunityAuditRepository();
  const owner = repository.createUser({
    email: "community-memory@example.test",
    name: "Community memory",
    approvalStatus: "approved",
  });
  const initial = repository.getCommunityProfile(owner.id);
  assertEquals(initial, {
    userId: owner.id,
    optedIn: false,
    identityMode: "anonymous",
    nickname: null,
    color: "slate",
    shareBalance: false,
    version: 1,
    createdAt: initial.createdAt,
    updatedAt: initial.updatedAt,
  });

  repository.failAudit = true;
  assertThrows(
    () =>
      repository.updateCommunityProfile(
        owner.id,
        {
          expectedVersion: 1,
          optedIn: true,
          identityMode: "nickname",
          nickname: "  Friendly-user  ",
          color: "violet",
          shareBalance: true,
        },
        { actorId: owner.id },
      ),
    Error,
    "injected community-profile audit failure",
  );
  assertEquals(repository.getCommunityProfile(owner.id), initial);
  assertEquals(repository.auditEvents.length, 0);

  repository.failAudit = false;
  const optedIn = repository.updateCommunityProfile(
    owner.id,
    {
      expectedVersion: 1,
      optedIn: true,
      identityMode: "nickname",
      nickname: "  Friendly-user  ",
      color: "violet",
      shareBalance: true,
    },
    { actorId: owner.id },
  );
  assertEquals(optedIn.version, 2);
  assertEquals(optedIn.optedIn, true);
  assertEquals(optedIn.shareBalance, true);
  assertEquals(optedIn.nickname, "Friendly-user");
  assertEquals(repository.auditEvents[0], {
    id: repository.auditEvents[0].id,
    actorId: owner.id,
    action: "community.profile_updated",
    targetType: "community_profile",
    targetId: owner.id,
    metadata: {
      changedFields: ["optedIn", "identityMode", "nickname", "color", "shareBalance"],
      optedIn: true,
      identityMode: "nickname",
      color: "violet",
      shareBalance: true,
      nicknameChanged: true,
      version: 2,
    },
    createdAt: repository.auditEvents[0].createdAt,
  });

  const optedOut = repository.updateCommunityProfile(
    owner.id,
    { expectedVersion: 2, optedIn: false },
    { actorId: owner.id },
  );
  assertEquals(optedOut.optedIn, false);
  assertEquals(optedOut.shareBalance, false);
  assertEquals(optedOut.nickname, "Friendly-user");
  assertThrows(
    () =>
      repository.updateCommunityProfile(
        owner.id,
        { expectedVersion: 3, shareBalance: true },
        { actorId: owner.id },
      ),
    TypeError,
    "Balance sharing requires leaderboard participation",
  );
  assertEquals(repository.getCommunityProfile(owner.id), optedOut);
  assertEquals(repository.auditEvents.length, 2);

  const stale = assertThrows(
    () =>
      repository.updateCommunityProfile(
        owner.id,
        { expectedVersion: 2, color: "blue" },
        { actorId: owner.id },
      ),
    DomainError,
  );
  assertEquals(stale.code, "version_conflict");
  const forbidden = assertThrows(
    () =>
      repository.updateCommunityProfile(
        owner.id,
        { expectedVersion: 3, color: "blue" },
        { actorId: crypto.randomUUID() },
      ),
    DomainError,
  );
  assertEquals(forbidden.code, "forbidden");
  assertThrows(
    () =>
      repository.updateCommunityProfile(
        owner.id,
        { expectedVersion: 3, optedIn: false, shareBalance: true },
        { actorId: owner.id },
      ),
    TypeError,
  );
});

Deno.test("memory community rankings fence identity, consent, eligibility, windows, and ties", () => {
  const repository = new MemoryRepository();
  const ids = [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000004",
    "10000000-0000-4000-8000-000000000005",
    "10000000-0000-4000-8000-000000000006",
  ];
  const users = ids.map((id, index) =>
    repository.createUser({
      id,
      email: `rank-${index}@example.test`,
      name: `Private account ${index}`,
      approvalStatus: "approved",
    })
  );
  for (const [index, user] of users.entries()) {
    repository.updateCommunityProfile(
      user.id,
      {
        expectedVersion: 1,
        optedIn: index !== 4,
        identityMode: index % 2 ? "anonymous" : "nickname",
        ...(index % 2 ? {} : { nickname: `Rank-${index}` }),
        color: index % 2 ? "blue" : "emerald",
        shareBalance: index < 2,
      },
      { actorId: user.id },
    );
    repository.findUser(user.id)!.balanceMicros = (5 - index) * 1_000_000;
  }
  repository.findUser(users[2].id)!.state = "suspended";
  repository.findUser(users[3].id)!.deletedAt = "2026-01-01T00:00:00.000Z";
  const asOf = "2026-07-17T12:00:00.000Z";
  const run = (
    id: string,
    userId: string,
    createdAt: string,
    status: "reserved" | "completed" | "failed",
    inputTokens: number,
    outputTokens: number,
    costMicros: number,
  ) =>
    repository.usageRuns.set(id, {
      id,
      userId,
      tokenId: null,
      model: "test/model",
      provider: "test",
      recoveryOwner: "provider",
      status,
      reservedMicros: costMicros,
      costMicros,
      inputTokens,
      outputTokens,
      latencyMs: 10,
      executionEpoch: 0,
      executionOwnerLeaseToken: null,
      runLeaseToken: null,
      runLeaseExpiresAt: null,
      actualProviderCostMicros: costMicros,
      actualProviderInputTokens: inputTokens,
      actualProviderCachedInputTokens: 0,
      actualProviderReasoningTokens: 0,
      actualProviderOutputTokens: outputTokens,
      pricingSnapshot: null,
      generationLeaseToken: null,
      generationLeaseExpiresAt: null,
      createdAt,
      completedAt: status === "reserved" ? null : createdAt,
    });
  run("rank-run-1", users[0].id, "2026-07-16T12:00:00.000Z", "completed", 3, 7, 100);
  run("rank-run-2", users[1].id, "2026-07-16T12:00:00.000Z", "completed", 5, 5, 200);
  run("rank-run-old", users[0].id, "2026-06-01T12:00:00.000Z", "completed", 900, 100, 9_000);
  run("rank-run-failed", users[0].id, "2026-07-16T13:00:00.000Z", "failed", 0, 0, 9_000);

  const first = repository.listCommunityLeaderboard({
    metric: "tokens",
    window: "7d",
    from: "2026-07-10T12:00:00.000Z",
    asOf,
    limit: 1,
  });
  assertEquals(first.data, [{
    userId: users[0].id,
    position: 1,
    identityMode: "nickname",
    nickname: "Rank-0",
    color: "emerald",
    value: 10,
  }]);
  assertEquals(first.nextBoundary, { score: 10, userId: users[0].id, position: 1 });
  const second = repository.listCommunityLeaderboard({
    metric: "tokens",
    window: "7d",
    from: "2026-07-10T12:00:00.000Z",
    asOf,
    limit: 1,
    after: first.nextBoundary!,
  });
  assertEquals(second.data, [{
    userId: users[1].id,
    position: 1,
    identityMode: "anonymous",
    nickname: null,
    color: "blue",
    value: 10,
  }]);
  assertEquals(second.nextBoundary, { score: 10, userId: users[1].id, position: 1 });
  const third = repository.listCommunityLeaderboard({
    metric: "tokens",
    window: "7d",
    from: "2026-07-10T12:00:00.000Z",
    asOf,
    limit: 1,
    after: second.nextBoundary!,
  });
  assertEquals(third.data, [{
    userId: users[5].id,
    position: 2,
    identityMode: "anonymous",
    nickname: null,
    color: "blue",
    value: 0,
  }]);
  assertEquals(third.nextBoundary, null);
  assertEquals(
    repository.listCommunityLeaderboard({
      metric: "tokens",
      window: "90d",
      from: "2026-04-18T12:00:00.000Z",
      asOf,
      limit: 100,
    }).data.map((entry) => [entry.userId, entry.value, entry.position]),
    [
      [users[0].id, 1_010, 1],
      [users[1].id, 10, 2],
      [users[5].id, 0, 3],
    ],
  );
  assertEquals(
    repository.listCommunityLeaderboard({
      metric: "balance",
      window: "current",
      from: null,
      asOf,
      limit: 100,
    }).data.map((entry) => [entry.userId, entry.value]),
    [
      [users[0].id, 5_000_000],
      [users[1].id, 4_000_000],
    ],
  );
});
