import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceNavigation } from "./WorkspaceNavigation.tsx";

describe("WorkspaceNavigation recovery", () => {
  it("renders a visible retry action when workspace queries fail", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WorkspaceNavigation
          selectedFolder={null}
          selectedTags={[]}
          onSelectFolder={vi.fn()}
          onToggleTag={vi.fn()}
          foldersError
          tagsError
          retryFolders={vi.fn()}
          retryTags={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Projects and tags couldn’t be loaded.");
    expect(html).toContain("Retry");
  });
});
