import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  AdminApiTokenPage,
  AdminApiTokenSummary,
  AdminSessionPage,
  AdminUser,
} from "../../../../../packages/contracts/src/types.ts";
import { ApiError } from "../../api.ts";
import { AdminUserDetail, adminUserDetailTitle } from "./AdminUserDetail.tsx";
import { canRevokeAdminSession, canRevokeAdminToken } from "./AdminUserSecurityTabs.tsx";
import { adminUserKeys } from "./adminUserKeys.ts";
import { isStaleAdminResource } from "./AdminUserPrimitives.tsx";

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
  it("provides deterministic titles throughout loading, success, and failure states", () => {
    expect(adminUserDetailTitle(undefined, true, null)).toBe(
      "Loading user · Users · DG Chat Admin",
    );
    expect(adminUserDetailTitle(user, false, null)).toBe(
      "Security Operator · Users · DG Chat Admin",
    );
    expect(adminUserDetailTitle(undefined, false, new ApiError(404, "missing", "missing")))
      .toBe("User not found · Users · DG Chat Admin");
    expect(adminUserDetailTitle(undefined, false, new Error("offline"))).toBe(
      "User details unavailable · Users · DG Chat Admin",
    );
  });

  it("classifies stale security resources that must not retry a captured selection", () => {
    expect(isStaleAdminResource(new ApiError(409, "version_conflict", "changed"))).toBe(true);
    expect(isStaleAdminResource(new ApiError(409, "no_state_change", "already revoked"))).toBe(
      true,
    );
    expect(isStaleAdminResource(new ApiError(404, "not_found", "removed"))).toBe(true);
    expect(
      isStaleAdminResource(
        new ApiError(403, "recent_authentication_required", "sign in again"),
      ),
    ).toBe(false);
  });

  it("keeps revoke actions disabled until a stale resource list refreshes successfully", () => {
    const session: AdminSessionPage["data"][number] = {
      id: "legacy:target-session",
      userId: user.id,
      source: "legacy",
      current: false,
      limited: false,
      status: "active",
      ipAddress: null,
      userAgent: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      invalidatedAt: null,
    };
    const token: AdminApiTokenSummary = {
      id: "token-1",
      ownerId: user.id,
      name: "Automation",
      preview: "dg_…test",
      scopes: ["chat:write"],
      version: 2,
      rpmLimit: null,
      burstLimit: null,
      accessMode: "inherit",
      groupIds: [],
      rotationFamilyId: "family-1",
      rotationGeneration: 1,
      rotatedFromTokenId: null,
      replacedByTokenId: null,
      overlapEndsAt: null,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      status: "active",
    };
    expect(canRevokeAdminSession(session, false)).toBe(true);
    expect(canRevokeAdminToken(token, false)).toBe(true);
    expect(canRevokeAdminSession(session, true)).toBe(false);
    expect(canRevokeAdminToken(token, true)).toBe(false);
  });

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

  it("disables destructive controls when an automatic refresh leaves cached security data", () => {
    const sessions: AdminSessionPage = {
      data: [{
        id: "better_auth:other-session",
        userId: user.id,
        source: "better_auth",
        current: false,
        limited: false,
        status: "active",
        ipAddress: null,
        userAgent: "Other Browser",
        createdAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
        invalidatedAt: null,
      }],
      nextCursor: null,
    };
    const tokens: AdminApiTokenPage = {
      data: [{
        id: "token-stale",
        ownerId: user.id,
        name: "Stale automation",
        preview: "dg_…stale",
        scopes: ["chat:write"],
        version: 1,
        rpmLimit: null,
        burstLimit: null,
        accessMode: "inherit",
        groupIds: [],
        rotationFamilyId: "family-stale",
        rotationGeneration: 1,
        rotatedFromTokenId: null,
        replacedByTokenId: null,
        overlapEndsAt: null,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        status: "active",
      }],
      nextCursor: null,
    };
    const markCachedQueryFailed = <T,>(
      client: QueryClient,
      queryKey: readonly unknown[],
      data: T,
    ) => {
      client.setQueryData(queryKey, data);
      client.getQueryCache().find({ queryKey, exact: true })!.setState({
        error: new Error("background refresh failed"),
        errorUpdatedAt: Date.now(),
        fetchFailureCount: 1,
        fetchFailureReason: new Error("background refresh failed"),
        fetchStatus: "idle",
        status: "error",
      });
    };

    const sessionsHtml = render("sessions", (client) => {
      markCachedQueryFailed(
        client,
        adminUserKeys.sessions(user.id, { status: undefined, limit: 25, cursor: undefined }),
        sessions,
      );
    });
    expect(sessionsHtml).toContain("revoke actions disabled until a refresh succeeds");
    expect(sessionsHtml).toMatch(/<button[^>]*disabled=""[^>]*>Revoke<\/button>/u);

    const tokensHtml = render("tokens", (client) => {
      markCachedQueryFailed(
        client,
        adminUserKeys.tokens(user.id, { status: undefined, limit: 25, cursor: undefined }),
        tokens,
      );
    });
    expect(tokensHtml).toContain("revoke actions disabled until a refresh succeeds");
    expect(tokensHtml).toMatch(
      /<button[^>]*disabled=""[^>]*>Revoke token family<\/button>/u,
    );
  });
});
