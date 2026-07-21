import { describe, expect, it } from "vitest";
import { parseCommunitySearch } from "./communityRouting.ts";

describe("community routing", () => {
  it("defaults to calls over 30 days", () => {
    expect(parseCommunitySearch({})).toEqual({ metric: "calls", window: "30d" });
  });

  it("accepts every usage window and strips unrelated values", () => {
    expect(parseCommunitySearch({ metric: "tokens", window: "90d", extra: "private" })).toEqual({
      metric: "tokens",
      window: "90d",
    });
    expect(parseCommunitySearch({ metric: "cost", window: "7d" })).toEqual({
      metric: "cost",
      window: "7d",
    });
  });

  it("canonicalizes balance without a time window", () => {
    expect(parseCommunitySearch({ metric: "balance", window: "7d" })).toEqual({
      metric: "balance",
    });
  });

  it("rejects retired and malformed filters", () => {
    expect(parseCommunitySearch({ metric: ["calls"], window: "all" })).toEqual({
      metric: "calls",
      window: "30d",
    });
  });
});
