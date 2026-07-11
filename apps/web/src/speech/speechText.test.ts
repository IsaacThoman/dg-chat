import { describe, expect, it } from "vitest";
import { speechTextForMarkdown } from "./speechText.ts";

describe("speechTextForMarkdown", () => {
  it("removes presentation syntax, destinations, code, and numeric citations by default", () => {
    expect(
      speechTextForMarkdown(
        "## Hello **world** [site](https://secret.test) [1]\n\n```ts\nalert(1)\n```",
      ),
    )
      .toBe("Hello world site");
  });
  it("can verbalize code and retain citations", () => {
    expect(speechTextForMarkdown("Answer [2]\n```ts\nconst x = 1\n```", {
      readCodeBlocks: true,
      readCitations: true,
    })).toBe("Answer [2]\n\nCode block.\nconst x = 1\n\nEnd code block.");
  });
  it("preserves Unicode text and image alternatives", () => {
    expect(speechTextForMarkdown("- Café 世界 ![architecture diagram](x.png)")).toBe(
      "Café 世界 architecture diagram",
    );
  });
  it("preserves comparisons and strips complete nested-parenthesis link destinations", () => {
    expect(speechTextForMarkdown("Use x < y and y > z. See [spec](https://x.test/a_(b))."))
      .toBe("Use x < y and y > z. See spec.");
  });
});
