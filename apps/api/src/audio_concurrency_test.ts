import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.14";
import {
  MemoryAudioConcurrencyLimiter,
  RedisAudioConcurrencyLimiter,
} from "./audio-concurrency.ts";

Deno.test("memory audio admission atomically enforces global and per-user limits", async () => {
  const limiter = new MemoryAudioConcurrencyLimiter();
  const first = await limiter.acquire("user-a", { global: 2, perUser: 1 });
  assert(first);
  assertEquals(await limiter.acquire("user-a", { global: 2, perUser: 1 }), null);
  const second = await limiter.acquire("user-b", { global: 2, perUser: 1 });
  assert(second);
  assertNotEquals(first.id, second.id);
  assertEquals(await limiter.acquire("user-c", { global: 2, perUser: 1 }), null);

  await first.release();
  const replacement = await limiter.acquire("user-a", { global: 2, perUser: 1 });
  assert(replacement);
  await first.release();
  assertEquals(await limiter.acquire("user-a", { global: 2, perUser: 1 }), null);
  await Promise.all([second.release(), replacement.release()]);
  await limiter.close();
});

Deno.test("memory audio admission expires abandoned leases", async () => {
  let now = 1_000;
  const limiter = new MemoryAudioConcurrencyLimiter({
    leaseMs: 1_000,
    now: () => now,
    autoRenew: false,
  });
  const abandoned = await limiter.acquire("user-a", { global: 1, perUser: 1 });
  assert(abandoned);
  assertEquals(await limiter.acquire("user-b", { global: 1, perUser: 1 }), null);
  now += 1_001;
  const recovered = await limiter.acquire("user-b", { global: 1, perUser: 1 });
  assert(recovered);
  assertEquals(abandoned.signal.aborted, true);
  await recovered.release();
  await limiter.close();
});

class RenewalClient {
  status = "ready";
  calls = 0;

  constructor(readonly outcome: "missing" | "error") {}

  connect() {
    return Promise.resolve();
  }

  eval() {
    this.calls++;
    if (this.calls === 1) return Promise.resolve(1);
    return this.outcome === "missing" ? Promise.resolve(0) : Promise.reject(new Error("offline"));
  }

  quit() {
    this.status = "end";
    return Promise.resolve("OK");
  }

  disconnect() {
    this.status = "end";
  }

  on() {
    return this;
  }
}

for (const outcome of ["missing", "error"] as const) {
  Deno.test(`Redis audio admission fences a holder after renewal ${outcome}`, async () => {
    const client = new RenewalClient(outcome);
    const limiter = new RedisAudioConcurrencyLimiter("redis://unused", {
      leaseMs: 1_000,
      client: client as never,
    });
    const lease = await limiter.acquire("user-a", { global: 1, perUser: 1 });
    assert(lease);
    await new Promise<void>((resolve) => {
      if (lease.signal.aborted) resolve();
      else lease.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    assertEquals(lease.signal.aborted, true);
    assert(client.calls >= 2);
    await lease.release().catch(() => undefined);
    await limiter.close();
  });
}
