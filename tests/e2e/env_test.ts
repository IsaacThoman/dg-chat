import { assertEquals } from "jsr:@std/assert@1.0.14";
import { missingDurableCapabilities, strictDurableCapabilities } from "./env.ts";

Deno.test("durable readiness requires live PostgreSQL and object storage capabilities", () => {
  const required = ["postgres", "objects"] as const;
  assertEquals(missingDurableCapabilities(null, required), ["postgres", "objects"]);
  assertEquals(
    missingDurableCapabilities({
      storage: { ready: true, storage: "memory" },
      objects: { configured: false, ready: false },
    }, required),
    ["PostgreSQL", "object storage"],
  );
  assertEquals(
    missingDurableCapabilities({
      storage: { ready: true, storage: "postgres" },
      objects: { configured: true, ready: false },
    }, required),
    ["object storage"],
  );
  assertEquals(
    missingDurableCapabilities({
      storage: { ready: true, storage: "postgres" },
      objects: { configured: true, ready: true },
    }, required),
    [],
  );
});

Deno.test("declared full-stack and CI runs fail closed while ordinary local runs may skip", () => {
  const values = (source: Record<string, string>) => (name: string) => source[name];
  assertEquals(strictDurableCapabilities(values({})), false);
  assertEquals(strictDurableCapabilities(values({ E2E_FULL_STACK: "true" })), true);
  assertEquals(strictDurableCapabilities(values({ CI: "true" })), true);
});
