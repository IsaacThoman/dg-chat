import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationMessagesQueryState } from "./App.tsx";

describe("ConversationMessagesQueryState", () => {
  it("announces an accessible busy state without implying an empty conversation", () => {
    const html = renderToStaticMarkup(<ConversationMessagesQueryState kind="loading" />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading conversation messages"');
    expect(html).toContain("Loading conversation messages…");
    expect(html).not.toContain("Conversation messages unavailable");
  });

  it("reports a blocking load failure and offers an explicit retry", () => {
    const retry = vi.fn();
    const html = renderToStaticMarkup(
      <ConversationMessagesQueryState kind="error" retry={retry} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Conversation messages unavailable");
    expect(html).toContain("No messages were removed.");
    expect(html).toMatch(/<button[^>]*>.*Retry<\/button>/u);
    expect(html).not.toContain('aria-busy="true"');
  });
});
