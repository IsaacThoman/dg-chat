import { describe, expect, it } from "vitest";
import { resolvedTheme, themeColor } from "./theme.ts";

describe("resolvedTheme", () => {
  it("honors explicit themes and follows the system only for system mode", () => {
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
    expect(resolvedTheme("system", false)).toBe("light");
    expect(resolvedTheme("system", true)).toBe("dark");
  });

  it("matches browser chrome colors to the resolved application surface", () => {
    expect(themeColor("light")).toBe("#f7f7f5");
    expect(themeColor("dark")).toBe("#171715");
  });
});
