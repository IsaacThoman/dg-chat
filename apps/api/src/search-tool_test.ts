import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { WebSearchToolAdapter } from "./search-tool.ts";
import { type ToolAdapterContext, ToolAdapterError } from "./tool-execution.ts";
import type { WebSearchAdapter } from "./web-search.ts";

function context(overrides: Partial<ToolAdapterContext["policy"]> = {}): ToolAdapterContext {
  return {
    executionId: "execution-id",
    idempotencyKey: "execution-id",
    ownerId: "owner-id",
    signal: new AbortController().signal,
    policy: {
      toolId: "web_search",
      allowed: true,
      allowedDomains: ["search.example.com"],
      allowPrivateNetwork: false,
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "admin-id",
      ...overrides,
    },
  };
}

Deno.test("every web-search adapter is fenced by verifiable target metadata", async () => {
  let calls = 0;
  const external: WebSearchAdapter = {
    id: "external",
    networkTarget: Object.freeze({ hostname: "other.example.com", privateNetwork: false }),
    search: ({ query }) => {
      calls++;
      return Promise.resolve({ query, results: [] });
    },
  };
  const tool = new WebSearchToolAdapter(external);
  const domainError = await assertRejects(
    () => tool.execute({ query: "test" }, context()),
    ToolAdapterError,
  );
  assertEquals(domainError.code, "policy_denied");
  assertEquals(calls, 0);

  const privateAdapter: WebSearchAdapter = {
    ...external,
    networkTarget: Object.freeze({ hostname: "search.example.com", privateNetwork: true }),
  };
  const privateError = await assertRejects(
    () => new WebSearchToolAdapter(privateAdapter).execute({ query: "test" }, context()),
    ToolAdapterError,
  );
  assertEquals(privateError.code, "policy_denied");
  assertEquals(calls, 0);

  assertEquals(
    await new WebSearchToolAdapter(external).execute(
      { query: "test" },
      context({ allowedDomains: ["other.example.com"] }),
    ),
    { query: "test", results: [] },
  );
  assertEquals(calls, 1);
});

Deno.test("web-search adapters with missing or malformed target metadata fail closed", async () => {
  let calls = 0;
  const malformed = {
    id: "malformed",
    networkTarget: { hostname: "search.example.com" },
    search: () => {
      calls++;
      return Promise.resolve({ query: "test", results: [] });
    },
  } as unknown as WebSearchAdapter;
  const error = await assertRejects(
    () => new WebSearchToolAdapter(malformed).execute({ query: "test" }, context()),
    ToolAdapterError,
  );
  assertEquals(error.code, "policy_denied");
  assertEquals(calls, 0);
});
