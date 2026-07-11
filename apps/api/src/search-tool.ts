import { domainMatches } from "./network-policy.ts";
import type { ToolAdapter } from "./tool-execution.ts";
import { SearxngSearchAdapter, type WebSearchAdapter } from "./web-search.ts";

export class WebSearchToolAdapter implements ToolAdapter {
  readonly definition = {
    id: "web_search",
    name: "Web search",
    description: "Search the web through the administrator-configured search service.",
    enabled: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1_000 },
        count: { type: "integer", minimum: 1, maximum: 20 },
        language: { type: "string", maxLength: 32 },
        safeSearch: { type: "integer", enum: [0, 1, 2] },
      },
    },
  } as const;

  constructor(readonly search: WebSearchAdapter) {}

  async execute(input: unknown, context: Parameters<ToolAdapter["execute"]>[1]) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Web search input must be an object");
    }
    const value = input as Record<string, unknown>;
    const keys = Object.keys(value);
    if (
      keys.some((key) => !["query", "count", "language", "safeSearch"].includes(key)) ||
      typeof value.query !== "string"
    ) {
      throw new Error("Web search input is invalid");
    }
    if (this.search instanceof SearxngSearchAdapter) {
      const targetHostname = this.search.targetHostname;
      if (
        !context.policy.allowedDomains.some((domain) => domainMatches(targetHostname, domain))
      ) throw new Error("Search endpoint is outside the tool domain allowlist");
      if (this.search.usesPrivateEndpoint && !context.policy.allowPrivateNetwork) {
        throw new Error("Private-network search is disabled by tool policy");
      }
    }
    return await this.search.search({
      query: value.query,
      count: value.count as number | undefined,
      language: value.language as string | undefined,
      safeSearch: value.safeSearch as 0 | 1 | 2 | undefined,
      signal: context.signal,
    });
  }
}
