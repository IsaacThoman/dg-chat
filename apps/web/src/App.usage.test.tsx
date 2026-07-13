import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageSettings } from "./App.tsx";

describe("UsageSettings", () => {
  it("labels its completed-only call count precisely", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["usage"], {
      balanceMicros: 4_000_000,
      calls: 7,
      inputTokens: 100,
      outputTokens: 50,
      spentMicros: 1_000_000,
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <UsageSettings />
      </QueryClientProvider>,
    );

    expect(markup).toContain("7 completed requests");
    expect(markup).toContain("150 tokens");
  });
});
