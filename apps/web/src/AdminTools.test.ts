import { describe, expect, it } from "vitest";
import { parseAllowedDomains } from "./AdminTools.tsx";

describe("tool policy editor", () => {
  it("normalizes comma/newline allowlists without silently broadening domains", () => {
    expect(parseAllowedDomains(" Search.Example.com,api.example.com\nsearch.example.com ")).toEqual(
      [
        "search.example.com",
        "api.example.com",
      ],
    );
    expect(parseAllowedDomains("\n,  ")).toEqual([]);
  });
});
