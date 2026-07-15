import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AdminSessionPage, AdminUser } from "../../../../../packages/contracts/src/types.ts";
import { AdminUserDetail } from "./AdminUserDetail.tsx";
import { adminUserKeys } from "./adminUserKeys.ts";

const user: AdminUser = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "Security Operator",
  email: "operator@example.com",
  role: "admin",
  approvalStatus: "approved",
  state: "active",
  balanceMicros: 6_750_001,
  emailVerifiedAt: "2026-07-01T00:00:00.000Z",
  deletedAt: null,
  version: 4,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  effectiveAdmin: true,
};

function render(
  tab: "account" | "sessions" | "tokens" | "billing",
  seed?: (client: QueryClient) => void,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(adminUserKeys.detail(user.id), user);
  seed?.(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AdminUserDetail
        userId={user.id}
        tab={tab}
        onTabChange={() => undefined}
        onBack={() => undefined}
        onReauthenticate={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("AdminUserDetail", () => {
  it("renders an exact balance and a URL-oriented accessible tab surface", () => {
    const html = render("account");
    expect(html).toContain("$6.750001");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="User administration"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("API tokens");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("effective admin");
  });

  it("visibly protects the current administrator session", () => {
    const page: AdminSessionPage = {
      data: [{
        id: "better_auth:current-session",
        userId: user.id,
        source: "better_auth",
        current: true,
        limited: false,
        status: "active",
        ipAddress: "192.0.2.1",
        userAgent: "Test Browser",
        createdAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
        invalidatedAt: null,
      }],
      nextCursor: null,
    };
    const html = render("sessions", (client) => {
      client.setQueryData(
        adminUserKeys.sessions(user.id, { status: undefined, limit: 25, cursor: undefined }),
        page,
      );
    });
    expect(html).toContain("Current administrator session");
    expect(html).toContain("Your current administrator session is protected.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Revoke<\/button>/u);
  });
});
