import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker.tsx";

describe("ModelPicker", () => {
  it("exposes an accessible listbox trigger and current model", () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        models={[{
          id: "provider/model",
          name: "Model",
          provider: "Provider",
          context: "128K",
          capabilities: ["chat"],
          healthy: true,
        }]}
        selected="provider/model"
        setSelected={vi.fn()}
      />,
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Model");
  });
});
