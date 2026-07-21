import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  blocksRemoteImageSource,
  containsMath,
  imageSourceHasConsent,
  MAX_RENDERED_MERMAID_DIAGRAMS,
  RichMarkdown,
} from "./RichMarkdown.tsx";

describe("RichMarkdown", () => {
  it("recognizes deliberate math syntax without treating ordinary prices as formulas", () => {
    expect(containsMath("The approval grant is $5.00 by default.")).toBe(false);
    expect(containsMath("Euler says $e^{i\\pi} + 1 = 0$. ")).toBe(true);
    expect(containsMath("$$\\int_0^1 x^2 dx$$")).toBe(true);
    expect(containsMath("Literal delimiters \\(x^2\\) and \\[y^2\\]")).toBe(false);
  });

  it("requires consent for every model-controlled image source", () => {
    expect(blocksRemoteImageSource("https://tracker.invalid/pixel")).toBe(true);
    expect(blocksRemoteImageSource("https:tracker.invalid/pixel")).toBe(true);
    expect(blocksRemoteImageSource("//tracker.invalid/pixel")).toBe(true);
    expect(blocksRemoteImageSource("\\\\tracker.invalid\\pixel")).toBe(true);
    expect(blocksRemoteImageSource("/api/private/action")).toBe(true);
    expect(blocksRemoteImageSource("images/local-image.png")).toBe(true);
    expect(blocksRemoteImageSource("data:image/png;base64,AA==")).toBe(true);
    expect(blocksRemoteImageSource("  ")).toBe(false);
  });

  it("binds consent to the exact source instead of the image's render position", () => {
    const approved = "https://images.invalid/first.png";
    expect(imageSourceHasConsent(approved, approved)).toBe(true);
    expect(imageSourceHasConsent(approved, "https://images.invalid/second.png")).toBe(false);
    expect(imageSourceHasConsent(undefined, approved)).toBe(false);
  });

  it("drops raw HTML and unsafe URL protocols", () => {
    const malicious =
      '<script>globalThis.pwned=true</script>\n<a href="javascript:alert(1)">raw</a>\n[bad](javascript:alert(2))';
    const html = renderToStaticMarkup(
      <RichMarkdown source={malicious} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
  });

  it("blocks images by default while preserving useful alt text and explicit consent", () => {
    const html = renderToStaticMarkup(
      <RichMarkdown source="![tracking pixel](https://tracker.invalid/pixel.png)" />,
    );
    expect(html).toContain("Remote image blocked: tracking pixel");
    expect(html).toContain("Load image");
    expect(html).not.toContain("tracker.invalid");
    expect(html).not.toContain("<img");
  });

  it("turns explicit repeated-file fences into keyboard-reachable artifacts", () => {
    const html = renderToStaticMarkup(
      <RichMarkdown
        source={[
          "```ts filename=answer.ts version=1",
          "export const answer = 41;",
          "```",
          "```ts filename=answer.ts version=2",
          "export const answer = 42;",
          "```",
        ].join("\n")}
      />,
    );
    expect(html.match(/class="rich-artifact"/g)).toHaveLength(2);
    expect(html).toContain("Preview");
    expect(html).toContain("Source");
    expect(html).toContain("Export");
    expect(html).toContain("Versions of answer.ts");
    expect(html).toContain("1 of 2");
    expect(html).toContain("2 of 2");
  });

  it("keeps Mermaid source visible while its lazy preview initializes", () => {
    const diagram = "```mermaid\ngraph TD\n  A --> B\n```";
    const html = renderToStaticMarkup(
      <RichMarkdown source={diagram} />,
    );
    expect(html).toContain('data-mermaid-state="loading"');
    expect(html).toContain("Rendering diagram");
    expect(html).toContain("Diagram source");
    expect(html).toContain("graph TD");
  });

  it("caps automatic Mermaid work while preserving every excess source", () => {
    const diagrams = Array.from(
      { length: MAX_RENDERED_MERMAID_DIAGRAMS + 2 },
      (_, index) => `\`\`\`mermaid\ngraph TD\n  A${index} --> B${index}\n\`\`\``,
    ).join("\n\n");
    const html = renderToStaticMarkup(<RichMarkdown source={diagrams} />);

    expect(html.match(/data-mermaid-state="loading"/g)).toHaveLength(
      MAX_RENDERED_MERMAID_DIAGRAMS,
    );
    expect(html.match(/data-mermaid-state="limited"/g)).toHaveLength(2);
    expect(html).toContain(
      `A${MAX_RENDERED_MERMAID_DIAGRAMS + 1} --&gt; B${MAX_RENDERED_MERMAID_DIAGRAMS + 1}`,
    );
  });
});
