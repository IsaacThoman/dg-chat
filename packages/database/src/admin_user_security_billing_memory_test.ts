import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import type { AuditEventInput } from "./repository.ts";
import { DomainError, MemoryRepository } from "./memory.ts";

class FaultRepository extends MemoryRepository {
  failAudit = false;
  override recordAudit(input: AuditEventInput) {
    if (this.failAudit) throw new Error("injected audit failure");
    return super.recordAudit(input);
  }
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function fixture() {
  const repository = new FaultRepository();
  const actor = repository.bootstrapAdmin({
    email: "security-admin@example.com",
    name: "Security Admin",
    passwordHash: "test-only",
  }, 0);
  const target = repository.createUser({
    email: "security-target@example.com",
    name: "Security Target",
    approvalStatus: "approved",
    emailVerified: true,
  });
  return { repository, actor, target };
}

function code(operation: () => unknown, expected: string) {
  const error = assertThrows(operation, DomainError);
  assertEquals(error.code, expected);
}
function forgedCursor(resource: string, targetUserId: string, createdAt: string, id: string) {
  return btoa(JSON.stringify([1, resource, targetUserId, createdAt, id, '{"status":null}']));
}

Deno.test("memory admin security pages are target-bound, filtered, cursor-bound, and secret-free", () => {
  const { repository, actor, target } = fixture();
  const firstSession = repository.createSession(target.id, "secret-session-one", false);
  repository.createSession(target.id, "secret-session-two", true);
  const firstToken = repository.createApiToken(target.id, {
    name: "First",
    scopes: ["chat:write"],
    tokenHash: "secret-token-one",
    preview: "dg_one",
  });
  repository.createApiToken(target.id, {
    name: "Second",
    scopes: ["models:read"],
    tokenHash: "secret-token-two",
    preview: "dg_two",
  });

  const sessions = repository.listAdminUserSessions(
    actor.id,
    target.id,
    { source: "legacy", status: "active", limit: 1 },
    { source: "legacy", id: firstSession.id },
  );
  assertEquals(sessions.data.length, 1);
  assertEquals(sessions.data[0].id.startsWith("legacy:"), true);
  assertEquals("tokenHash" in sessions.data[0], false);
  assertEquals(sessions.nextCursor !== null, true);
  code(
    () =>
      repository.listAdminUserSessions(actor.id, target.id, {
        status: "expired",
        cursor: sessions.nextCursor!,
      }),
    "validation_error",
  );

  const tokens = repository.listAdminUserTokens(actor.id, target.id, {
    status: "active",
    limit: 1,
  });
  assertEquals(tokens.data.length, 1);
  assertEquals("tokenHash" in tokens.data[0], false);
  assertEquals(tokens.data[0].ownerId, target.id);
  code(
    () => repository.listAdminUserTokens(actor.id, actor.id, { cursor: tokens.nextCursor! }),
    "validation_error",
  );
  code(() =>
    repository.listAdminUserTokens(actor.id, target.id, {
      cursor: forgedCursor("tokens", target.id, "0", firstToken.id),
    }), "validation_error");
  code(() =>
    repository.listAdminUserTokens(actor.id, target.id, {
      cursor: forgedCursor("tokens", target.id, "2020-02-30T00:00:00Z", firstToken.id),
    }), "validation_error");
  code(() =>
    repository.listAdminUserTokens(actor.id, target.id, {
      cursor: forgedCursor("tokens", target.id, new Date().toISOString(), "not-a-uuid"),
    }), "validation_error");
  assertEquals(firstToken.tokenHash, "secret-token-one");
});

Deno.test("memory admin session and token revocation are target-bound, versioned, audited, and atomic", () => {
  const { repository, actor, target } = fixture();
  const current = repository.createSession(actor.id, "actor-current", false);
  const targetSession = repository.createSession(target.id, "target-session", false);
  const token = repository.createApiToken(target.id, {
    name: "Family",
    scopes: ["chat:write"],
    tokenHash: "family-secret",
    preview: "family",
  });

  code(() =>
    repository.revokeAdminUserSession({
      actorId: actor.id,
      targetUserId: actor.id,
      source: "legacy",
      sessionId: current.id,
      currentSession: { source: "legacy", id: current.id },
      reason: "Protect this session",
    }), "current_session_protected");
  code(() =>
    repository.revokeAdminUserSession({
      actorId: actor.id,
      targetUserId: actor.id,
      source: "legacy",
      sessionId: targetSession.id,
      currentSession: { source: "legacy", id: current.id },
      reason: "Cross-owner attempt",
    }), "not_found");

  repository.revokeAdminUserSession({
    actorId: actor.id,
    targetUserId: target.id,
    source: "legacy",
    sessionId: targetSession.id,
    currentSession: { source: "legacy", id: current.id },
    reason: "Compromised browser",
  });
  assertEquals(repository.getSession("target-session"), undefined);
  assertEquals(repository.listSessions(target.id)[0].invalidatedAt !== null, true);

  code(() =>
    repository.revokeAdminUserTokenFamily({
      actorId: actor.id,
      targetUserId: target.id,
      tokenId: token.id,
      expectedVersion: 2,
      reason: "Stale command",
    }), "version_conflict");
  repository.revokeAdminUserTokenFamily({
    actorId: actor.id,
    targetUserId: target.id,
    tokenId: token.id,
    expectedVersion: 1,
    reason: "Token exposed",
  });
  assertEquals(token.revokedAt !== null, true);
  assertEquals(repository.auditEvents.map((event) => event.action), [
    "user.session.revoked",
    "user.api_token_family.revoked",
  ]);

  const rollbackTarget = repository.createSession(target.id, "rollback-session", false);
  repository.failAudit = true;
  assertThrows(
    () =>
      repository.revokeAdminUserSession({
        actorId: actor.id,
        targetUserId: target.id,
        source: "legacy",
        sessionId: rollbackTarget.id,
        currentSession: { source: "legacy", id: current.id },
        reason: "Exercise rollback",
      }),
    Error,
    "injected audit failure",
  );
  assertEquals(repository.getSession("rollback-session")?.id, rollbackTarget.id);
});

Deno.test("memory balance adjustment provides exact replay, payload conflict, CAS, and rollback", () => {
  const { repository, actor, target } = fixture();
  const command = {
    actorId: actor.id,
    targetUserId: target.id,
    amountMicros: 750,
    expectedBalanceMicros: 0,
    idempotencyKeyHash: HASH_A,
    requestHash: HASH_B,
    reason: "Customer support grant",
  };
  const created = repository.adjustAdminUserBalance(command);
  assertEquals(created.replayed, false);
  assertEquals(created.balanceAfterMicros, 750);
  const replay = repository.adjustAdminUserBalance(command);
  assertEquals(replay.replayed, true);
  assertEquals(replay.id, created.id);
  assertEquals(repository.ledger.filter((entry) => entry.kind === "adjustment").length, 1);

  code(
    () => repository.adjustAdminUserBalance({ ...command, requestHash: HASH_C }),
    "idempotency_conflict",
  );
  code(() =>
    repository.adjustAdminUserBalance({
      ...command,
      idempotencyKeyHash: HASH_C,
      requestHash: HASH_A,
      expectedBalanceMicros: 0,
    }), "balance_conflict");
  assertEquals(repository.getAdminUser(target.id).balanceMicros, 750);

  repository.failAudit = true;
  assertThrows(
    () =>
      repository.adjustAdminUserBalance({
        ...command,
        amountMicros: -250,
        expectedBalanceMicros: 750,
        idempotencyKeyHash: "d".repeat(64),
        requestHash: "e".repeat(64),
        reason: "Exercise rollback",
      }),
    Error,
    "injected audit failure",
  );
  assertEquals(repository.getAdminUser(target.id).balanceMicros, 750);
  assertEquals(repository.ledger.filter((entry) => entry.kind === "adjustment").length, 1);
});

Deno.test("memory rotation invalidates stale administrative versions across the token family", () => {
  const { repository, actor, target } = fixture();
  const first = repository.createApiToken(target.id, {
    name: "Rotating family",
    scopes: ["chat:write"],
    tokenHash: "rotation-one",
    preview: "one",
  });
  const second = repository.rotateApiToken(target.id, first.id, {
    expectedVersion: 1,
    tokenHash: "rotation-two",
    preview: "two",
    overlapSeconds: 3600,
  });
  const staleFirstVersion = second.previous.version;
  const third = repository.rotateApiToken(target.id, second.replacement.id, {
    expectedVersion: 1,
    tokenHash: "rotation-three",
    preview: "three",
    overlapSeconds: 3600,
  });
  code(() =>
    repository.revokeAdminUserTokenFamily({
      actorId: actor.id,
      targetUserId: target.id,
      tokenId: first.id,
      expectedVersion: staleFirstVersion,
      reason: "Stale overlap view",
    }), "version_conflict");
  assertEquals(repository.tokens.get(third.replacement.id)?.revokedAt, null);
});

Deno.test("memory privileged commands revalidate effective administrator authority", () => {
  const { repository, actor, target } = fixture();
  actor.role = "user";
  code(() => repository.listAdminUserLedger(actor.id, target.id), "admin_authority_required");
  code(() =>
    repository.adjustAdminUserBalance({
      actorId: actor.id,
      targetUserId: target.id,
      amountMicros: 1,
      expectedBalanceMicros: 0,
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      reason: "No authority",
    }), "admin_authority_required");
});
