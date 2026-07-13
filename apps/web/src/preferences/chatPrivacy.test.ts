import { describe, expect, it } from "vitest";
import { historyPreferenceWarning, temporaryChatUntilPreferencesResolve } from "./chatPrivacy.ts";

describe("chat history privacy", () => {
  it("fails closed while authoritative preferences load or fail", () => {
    expect(temporaryChatUntilPreferencesResolve(false)).toBe(true);
    expect(temporaryChatUntilPreferencesResolve(false, { saveHistory: false })).toBe(true);
    expect(temporaryChatUntilPreferencesResolve(false, { saveHistory: true })).toBe(false);
  });

  it("keeps demo behavior and clearly explains preference failure", () => {
    expect(temporaryChatUntilPreferencesResolve(true)).toBe(false);
    expect(historyPreferenceWarning(false, true)).toContain("temporary");
    expect(historyPreferenceWarning(true, true)).toBe("");
  });
});
