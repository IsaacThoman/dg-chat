import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RealtimeVoiceControl } from "./RealtimeVoiceControl.tsx";

describe("RealtimeVoiceControl", () => {
  it("only renders when an entitled realtime model exists", () => {
    expect(renderToStaticMarkup(<RealtimeVoiceControl models={[]} />)).toBe("");
    const markup = renderToStaticMarkup(
      <RealtimeVoiceControl
        models={[{
          id: "vendor/realtime",
          name: "Realtime",
          provider: "vendor",
          capabilities: ["realtime"],
          context: "32k",
          healthy: true,
        }]}
      />,
    );
    expect(markup).toContain("Start realtime voice conversation");
    expect(markup).toContain("Live voice");
  });
});
