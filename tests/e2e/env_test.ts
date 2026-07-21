import { assertEquals } from "jsr:@std/assert@1.0.14";
import { missingDurableCapabilities, strictDurableCapabilities } from "./env.ts";

Deno.test("durable readiness requires exact live PostgreSQL, Redis, and S3 capabilities", () => {
  const required = ["postgres", "redis", "objects"] as const;
  assertEquals(missingDurableCapabilities(null, required), ["postgres", "redis", "objects"]);
  assertEquals(
    missingDurableCapabilities({
      storage: { configured: false, ready: true, implementation: "memory" },
      redis: { configured: false, ready: true, implementation: "memory" },
      objects: { configured: false, ready: false, implementation: "none" },
    }, required),
    ["PostgreSQL", "Redis", "object storage"],
  );
  assertEquals(
    missingDurableCapabilities({
      storage: { configured: true, ready: true, implementation: "postgres" },
      redis: { configured: true, ready: true, implementation: "redis" },
      objects: { configured: true, ready: false, implementation: "s3" },
    }, required),
    ["object storage"],
  );
  assertEquals(
    missingDurableCapabilities({
      storage: { configured: true, ready: true, implementation: "postgres" },
      redis: { configured: true, ready: true, implementation: "redis" },
      objects: { configured: true, ready: true, implementation: "s3" },
    }, required),
    [],
  );
  assertEquals(
    missingDurableCapabilities({
      storage: { configured: true, ready: true, implementation: "postgres" },
      redis: { configured: true, ready: true, implementation: "custom" },
      objects: { configured: true, ready: true, implementation: "memory" },
    }, required),
    ["Redis", "object storage"],
  );
});

Deno.test("declared full-stack and CI runs fail closed while ordinary local runs may skip", () => {
  const values = (source: Record<string, string>) => (name: string) => source[name];
  assertEquals(strictDurableCapabilities(values({})), false);
  assertEquals(strictDurableCapabilities(values({ E2E_FULL_STACK: "true" })), true);
  assertEquals(strictDurableCapabilities(values({ CI: "true" })), true);
});
