import { assertEquals, assertExists } from "jsr:@std/assert@1.0.14";
import { MemoryRepository } from "@dg-chat/database";
import type {
  AccessGroupPolicyImpact,
  AccessGroupPolicyProposal,
  AdminTokenLookupPage,
  PrivilegedReadContext,
} from "@dg-chat/database";
import { createApp } from "./app.ts";

type DelayedRead = "groups" | "impact" | "tokens";

class AuthorityLossAfterMiddlewareRepository extends MemoryRepository {
  loseAuthorityBefore: DelayedRead | null = null;

  #revokeAdmittedAuthority(context: PrivilegedReadContext, read: DelayedRead): void {
    if (this.loseAuthorityBefore !== read) return;
    this.loseAuthorityBefore = null;
    this.users.get(context.actorId)!.authorityEpoch++;
  }

  override listAccessGroups(context: PrivilegedReadContext) {
    this.#revokeAdmittedAuthority(context, "groups");
    return super.listAccessGroups(context);
  }

  override previewAccessGroupPolicyImpact(
    context: PrivilegedReadContext,
    id: string,
    proposal?: AccessGroupPolicyProposal | null,
  ): AccessGroupPolicyImpact {
    this.#revokeAdmittedAuthority(context, "impact");
    return super.previewAccessGroupPolicyImpact(context, id, proposal);
  }

  override searchApiTokens(
    context: PrivilegedReadContext,
    query?: string,
    limit?: number,
    cursor?: string,
  ): AdminTokenLookupPage {
    this.#revokeAdmittedAuthority(context, "tokens");
    return super.searchApiTokens(context, query, limit, cursor);
  }
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assertExists(value);
  return value;
}

for (
  const regression of [
    {
      read: "groups" as const,
      path: "/api/admin/model-access/groups",
      method: "GET",
    },
    {
      read: "impact" as const,
      path: (groupId: string) => `/api/admin/model-access/groups/${groupId}/impact`,
      method: "POST",
      body: JSON.stringify({ proposal: null }),
    },
    {
      read: "tokens" as const,
      path: "/api/admin/model-access/tokens",
      method: "GET",
    },
  ]
) {
  Deno.test(`model-access ${regression.read} read rejects authority lost after middleware`, async () => {
    const repository = new AuthorityLossAfterMiddlewareRepository();
    const { app } = createApp({
      repository,
      setupToken: `privileged-read-${regression.read}`,
      requestErrorLogSink: () => undefined,
    });
    const email = `privileged-read-${regression.read}@example.test`;
    await app.request("/api/setup/bootstrap", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-setup-token": `privileged-read-${regression.read}`,
      },
      body: JSON.stringify({
        email,
        password: "correct horse battery staple",
        name: "Privileged read administrator",
      }),
    });
    const login = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery staple" }),
    });
    const headers = {
      cookie: sessionCookie(login),
      origin: "http://localhost:5173",
      "content-type": "application/json",
    };
    const created = await app.request("/api/admin/model-access/groups", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Sensitive group" }),
    });
    assertEquals(created.status, 201);
    const group = await created.json() as { id: string };

    repository.loseAuthorityBefore = regression.read;
    const response = await app.request(
      typeof regression.path === "function" ? regression.path(group.id) : regression.path,
      {
        method: regression.method,
        headers,
        body: regression.body,
      },
    );
    assertEquals(response.status, 403, await response.clone().text());
    assertEquals((await response.json()).error.code, "admin_authority_required");
  });
}
