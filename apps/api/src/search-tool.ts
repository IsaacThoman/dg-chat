import { domainMatches } from "./network-policy.ts";
import { type ToolAdapter, ToolAdapterError } from "./tool-execution.ts";
import type { WebSearchAdapter } from "./web-search.ts";

export class WebSearchToolAdapter implements ToolAdapter {
  // This policy check is defense-in-depth for trusted in-process adapters. `networkTarget` is
  // declarative metadata, not a sandbox; SearxngSearchAdapter's DNS-pinned transport is the SSRF
  // enforcement boundary for the built-in implementation.
  readonly #target: Readonly<{ hostname: string; privateNetwork: boolean }> | null;
  readonly definition = {
    id: "web_search",
    name: "Web search",
    description: "Search the web through the administrator-configured search service.",
    recoverySafety: "read_only",
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

  constructor(readonly search: WebSearchAdapter) {
    try {
      const target = search.networkTarget;
      const descriptors = target && Object.getOwnPropertyDescriptors(target);
      const hostname = descriptors?.hostname;
      const privateNetwork = descriptors?.privateNetwork;
      this.#target = hostname && "value" in hostname &&
          typeof hostname.value === "string" && /^[a-z0-9.-]+$/i.test(hostname.value) &&
          privateNetwork && "value" in privateNetwork &&
          typeof privateNetwork.value === "boolean"
        ? Object.freeze({
          hostname: hostname.value.toLowerCase().replace(/^\.+|\.+$/g, ""),
          privateNetwork: privateNetwork.value,
        })
        : null;
    } catch {
      this.#target = null;
    }
  }

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
    const target = this.#target;
    if (
      !target || typeof target.hostname !== "string" || !target.hostname ||
      typeof target.privateNetwork !== "boolean" ||
      !context.policy.allowedDomains.some((domain) => domainMatches(target.hostname, domain))
    ) throw new ToolAdapterError("policy_denied");
    if (target.privateNetwork !== false && !context.policy.allowPrivateNetwork) {
      throw new ToolAdapterError("policy_denied");
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
