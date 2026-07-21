import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "./memory.ts";

Deno.test("memory admin summary is bounded and never materializes the ledger", () => {
  const repository = new MemoryRepository();
  const first = repository.createUser({
    email: "admin-summary-first@example.test",
    name: "First",
    passwordHash: "test",
  });
  const second = repository.createUser({
    email: "admin-summary-second@example.test",
    name: "Second",
    passwordHash: "test",
  });
  repository.credit(first.id, "admin-summary-first-grant", "grant", 100);
  repository.credit(second.id, "admin-summary-second-grant", "grant", 200);
  repository.reserve(first.id, "admin-summary-run", "test/model", 50);
  assertEquals(repository.ledger.length, 3);

  Object.defineProperty(repository, "ledger", {
    configurable: true,
    get() {
      throw new Error("admin summary must not read the ledger");
    },
  });
  assertEquals(repository.adminSummary(), {
    calls: 1,
    users: 2,
    balanceMicros: 250,
  });
});

Deno.test("memory admin summary rejects unsafe aggregate values", () => {
  const repository = new MemoryRepository();
  const first = repository.createUser({
    email: "admin-summary-overflow-first@example.test",
    name: "First",
    passwordHash: "test",
  });
  const second = repository.createUser({
    email: "admin-summary-overflow-second@example.test",
    name: "Second",
    passwordHash: "test",
  });
  repository.users.get(first.id)!.balanceMicros = Number.MAX_SAFE_INTEGER;
  repository.users.get(second.id)!.balanceMicros = 1;
  assertThrows(
    () => repository.adminSummary(),
    Error,
    "Administrative usage summary exceeds safe integer bounds",
  );
});
