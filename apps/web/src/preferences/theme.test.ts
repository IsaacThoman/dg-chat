import { describe, expect, it } from "vitest";
import { resolvedTheme } from "./theme.ts";

describe("resolvedTheme", () => {
  it("honors explicit themes and follows the system only for system mode", () => {
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
    expect(resolvedTheme("system", false)).toBe("light");
    expect(resolvedTheme("system", true)).toBe("dark");
  });
});
