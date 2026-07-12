import { expect, test } from "@playwright/test";
import type { Token } from "../../apps/web/src/types.ts";
import { bootstrap, login } from "./helpers.ts";

const token: Token = {
  id: "00000000-0000-4000-8000-000000000301",
  name: "CI client",
  preview: "dg_test…0301",
  scopes: ["chat:write", "models:read"],
  version: 1,
  rpmLimit: null,
  burstLimit: null,
  accessMode: "inherit",
  rotationFamilyId: "00000000-0000-4000-8000-000000000302",
  rotationGeneration: 0,
  rotatedFromTokenId: null,
  replacedByTokenId: null,
  overlapEndsAt: null,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: "2026-07-12T00:00:00.000Z",
};

test("personal token governance and admin entitlements are explicit and responsive", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  let tokens: Token[] = [token];
  let patchAttempts = 0;
  let rotateAttempts = 0;
  let revokeAttempts = 0;
  await page.route("**/api/tokens**", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/tokens" && method === "GET") {
      return route.fulfill({ json: { data: tokens } });
    }
    if (url.pathname === "/api/tokens" && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ name: "Local SDK", rpmLimit: null, burstLimit: null });
      const created = {
        ...token,
        id: "00000000-0000-4000-8000-000000000303",
        name: "Local SDK",
        preview: "dg_new…0303",
      };
      tokens = [...tokens, created];
      return route.fulfill({ status: 201, json: { ...created, token: "dg_one_time_secret" } });
    }
    if (url.pathname === `/api/tokens/${token.id}` && method === "PATCH") {
      patchAttempts++;
      if (patchAttempts === 1) {
        return route.fulfill({
          status: 409,
          json: { error: { code: "version_conflict", message: "Token changed" } },
        });
      }
      const body = route.request().postDataJSON();
      tokens = tokens.map((item) => item.id === token.id ? { ...item, ...body, version: 2 } : item);
      return route.fulfill({ json: tokens.find((item) => item.id === token.id) });
    }
    if (url.pathname.endsWith("/rotate")) {
      rotateAttempts++;
      if (rotateAttempts === 1) {
        return route.fulfill({
          status: 409,
          json: { error: { code: "version_conflict", message: "Token changed" } },
        });
      }
      expect(route.request().postDataJSON()).toEqual({ expectedVersion: 2, overlapSeconds: 300 });
      const replacement = {
        ...token,
        id: "00000000-0000-4000-8000-000000000304",
        version: 1,
        rotationGeneration: 1,
        rotatedFromTokenId: token.id,
        preview: "dg_rot…0304",
      };
      const previous = { ...token, version: 2, replacedByTokenId: replacement.id };
      tokens = [previous, replacement, ...tokens.filter((item) => item.id !== token.id)];
      return route.fulfill({
        status: 201,
        json: {
          token: "dg_rotated_secret",
          previous,
          replacement,
        },
      });
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/tokens/")) {
      revokeAttempts++;
      if (revokeAttempts === 1) {
        return route.fulfill({
          status: 409,
          json: { error: { code: "version_conflict", message: "Token changed" } },
        });
      }
      tokens = tokens.map((item) => ({ ...item, revokedAt: "2026-07-12T01:00:00.000Z" }));
      return route.fulfill({ status: 204, body: "" });
    }
    throw new Error(`Unexpected token request: ${method} ${url.pathname}${url.search}`);
  });

  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "API tokens", exact: true }).click();
  await expect(page.getByText("Installation default", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create token" }).focus();
  await page.keyboard.press("Enter");
  const create = page.getByRole("dialog", { name: "Create API token" });
  await create.getByLabel("Name").pressSequentially("Local SDK");
  await create.getByRole("button", { name: "Create token" }).focus();
  await page.keyboard.press("Enter");
  const secret = page.getByRole("dialog", { name: "Copy your API token" });
  await expect(secret.getByLabel("API token secret")).toHaveValue("dg_one_time_secret");
  await page.keyboard.press("Escape");
  await expect(secret).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  await secret.getByRole("button", { name: "Copy token" }).focus();
  await page.keyboard.press("Enter");
  await expect(secret.getByText(/Clipboard access failed/)).toBeVisible();
  await expect(secret.getByLabel("API token secret")).toHaveValue("dg_one_time_secret");
  await expect(secret.getByLabel("API token secret")).toBeFocused();
  expect(
    await secret.getByLabel("API token secret").evaluate((element) => {
      const input = element as unknown as {
        selectionStart: number | null;
        selectionEnd: number | null;
      };
      return [input.selectionStart, input.selectionEnd];
    }),
  ).toEqual([0, "dg_one_time_secret".length]);
  await secret.getByRole("button", { name: "I’ve stored this token" }).focus();
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  )
    .toBeTruthy();
  await page.getByRole("button", { name: "Edit", exact: true }).first().focus();
  await page.keyboard.press("Enter");
  const edit = page.getByRole("dialog", { name: "Edit CI client" });
  await expect(edit).toBeVisible();
  expect(
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  )
    .toBeTruthy();
  await edit.getByLabel("Name").focus();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
  await page.keyboard.type("CI client updated");
  await edit.getByRole("button", { name: "Save changes" }).focus();
  await page.keyboard.press("Enter");
  await expect(edit.getByText(/changed in another session/)).toBeVisible();
  await edit.getByRole("button", { name: "Save changes" }).focus();
  await page.keyboard.press("Enter");
  await expect(edit).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Rotate" }).first().focus();
  await page.keyboard.press("Enter");
  const rotate = page.getByRole("dialog", { name: "Rotate CI client updated" });
  await expect(rotate.getByText(/entire rotation family/)).toBeVisible();
  await rotate.getByRole("button", { name: "Rotate token" }).focus();
  await page.keyboard.press("Enter");
  await expect(rotate.getByText(/changed in another session/)).toBeVisible();
  await rotate.getByRole("button", { name: "Rotate token" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("API token secret")).toHaveValue("dg_rotated_secret");
  await page.getByRole("button", { name: "I’ve stored this token" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Revoke", exact: true }).last().focus();
  await page.keyboard.press("Enter");
  const revoke = page.getByRole("dialog", { name: /Revoke .*\?/ });
  await revoke.getByRole("button", { name: "Revoke token" }).focus();
  await page.keyboard.press("Enter");
  await expect(revoke.getByText(/changed in another session/)).toBeVisible();
  await revoke.getByRole("button", { name: "Revoke token" }).focus();
  await page.keyboard.press("Enter");
  await expect(revoke).toBeHidden();

  const owner = {
    id: "00000000-0000-4000-8000-000000000311",
    name: "Alice Admin",
    email: "alice@example.com",
    role: "admin",
    approvalStatus: "approved",
    state: "active",
    balanceMicros: 5_000_000,
  };
  const model = {
    id: "00000000-0000-4000-8000-000000000312",
    displayName: "Model One",
    publicModelId: "provider/model-one",
    upstreamModelId: "model-one",
    providerId: "00000000-0000-4000-8000-000000000313",
    capabilities: ["chat"],
    contextWindow: 8192,
    enabled: true,
    version: 1,
    customParams: {},
    prices: [],
    createdAt: token.createdAt,
    updatedAt: token.createdAt,
  };
  let accessGroup = {
    id: "00000000-0000-4000-8000-000000000314",
    name: "Private models",
    description: "Production allowlist",
    version: 1,
    userIds: [owner.id],
    tokenIds: [token.id, "00000000-0000-4000-8000-000000000315"],
    tokenOwners: [
      { tokenId: token.id, ownerId: owner.id },
      { tokenId: "00000000-0000-4000-8000-000000000315", ownerId: owner.id },
    ],
    modelIds: [model.id],
    createdAt: token.createdAt,
    updatedAt: token.createdAt,
  };
  let accessToken = {
    id: token.id,
    name: token.name,
    preview: token.preview,
    ownerId: owner.id,
    ownerName: owner.name,
    ownerEmail: owner.email,
    version: token.version,
    groupIds: [accessGroup.id],
    accessMode: "restricted",
    revokedAt: null,
  };
  const backupToken = {
    ...accessToken,
    id: "00000000-0000-4000-8000-000000000315",
    name: "Backup client",
    preview: "dg_backup…0315",
    groupIds: [accessGroup.id],
    accessMode: "inherit",
  };
  let aliases: Array<Record<string, unknown>> = [];
  let policyAttempts = 0;
  const tokenQueries: string[] = [];
  await page.route("**/api/admin/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/api/admin/providers") return route.fulfill({ json: { data: [] } });
    if (path === "/api/admin/models") return route.fulfill({ json: { data: [model] } });
    if (path === "/api/admin/model-access/groups" && method === "GET") {
      return route.fulfill({ json: { data: [accessGroup] } });
    }
    if (path === "/api/admin/model-access/aliases" && method === "GET") {
      return route.fulfill({ json: { data: aliases } });
    }
    if (path === "/api/admin/model-access/aliases" && method === "POST") {
      const body = route.request().postDataJSON();
      const created = {
        id: "00000000-0000-4000-8000-000000000316",
        ...body,
        version: 1,
        createdAt: token.createdAt,
        updatedAt: token.createdAt,
      };
      aliases = [created];
      return route.fulfill({ status: 201, json: created });
    }
    if (path === `/api/admin/model-access/aliases/${aliases[0]?.id}` && method === "PATCH") {
      const body = route.request().postDataJSON();
      aliases = [{ ...aliases[0], ...body, version: 2 }];
      return route.fulfill({ json: aliases[0] });
    }
    if (path === `/api/admin/model-access/aliases/${aliases[0]?.id}` && method === "DELETE") {
      aliases = [];
      return route.fulfill({ status: 204, body: "" });
    }
    if (path === "/api/admin/model-access/tokens") {
      tokenQueries.push(url.searchParams.get("query") ?? "");
      if ((url.searchParams.get("query") ?? "").toLowerCase().includes("backup")) {
        return route.fulfill({ json: { data: [backupToken], nextCursor: null } });
      }
      return url.searchParams.get("cursor") === "next-page"
        ? route.fulfill({ json: { data: [backupToken], nextCursor: null } })
        : route.fulfill({ json: { data: [accessToken], nextCursor: "next-page" } });
    }
    if (path === `/api/admin/model-access/groups/${accessGroup.id}/impact`) {
      const body = route.request().postDataJSON();
      expect(body.proposal.modelIds).toEqual([]);
      return route.fulfill({
        json: {
          modelIdsBecomingPublic: [model.id],
          tokenIdsLosingGroupAccess: [],
          tokenIdsRevertingToOwnerInheritance: [],
        },
      });
    }
    if (path === `/api/admin/model-access/groups/${accessGroup.id}/policy` && method === "PUT") {
      policyAttempts++;
      if (policyAttempts === 1) {
        return route.fulfill({
          status: 409,
          json: { error: { code: "version_conflict", message: "Group changed" } },
        });
      }
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({
        expectedVersion: 1,
        userIds: [owner.id],
        tokenIds: [token.id],
        modelIds: [],
      });
      accessGroup = { ...accessGroup, ...body, version: 2 };
      return route.fulfill({ json: accessGroup });
    }
    if (path === `/api/admin/model-access/tokens/${token.id}/access-mode` && method === "PUT") {
      expect(route.request().postDataJSON()).toMatchObject({
        ownerId: owner.id,
        expectedVersion: 1,
        accessMode: "inherit",
      });
      accessToken = { ...accessToken, accessMode: "inherit", version: 2 };
      return route.fulfill({ json: accessToken });
    }
    if (path === "/api/admin/users") return route.fulfill({ json: { data: [owner] } });
    throw new Error(`Unexpected admin request: ${method} ${path}${url.search}`);
  });
  await page.goto("/admin/models");
  await expect(page.getByRole("heading", { name: "Access groups & aliases" })).toBeVisible();
  await expect(page.getByText("Token access can only become narrower.")).toBeVisible();
  await page.getByRole("button", { name: "Edit group Private models" }).focus();
  await page.keyboard.press("Enter");
  const groupDialog = page.getByRole("dialog", { name: /Edit access group/ });
  const users = groupDialog.getByRole("group", { name: "Users" });
  const assignedTokens = groupDialog.getByRole("group", { name: "API tokens" });
  const assignedModels = groupDialog.getByRole("group", { name: "Models" });
  await users.getByRole("checkbox", { name: /Alice Admin/ }).focus();
  await page.keyboard.press("Space");
  await expect(assignedTokens.getByRole("checkbox", { name: /CI client/ })).not.toBeChecked();
  await assignedTokens.getByRole("checkbox", { name: /CI client/ }).focus();
  await page.keyboard.press("Space");
  await expect(users.getByRole("checkbox", { name: /Alice Admin/ })).toBeChecked();
  await groupDialog.getByRole("button", { name: "Load more tokens" }).focus();
  await page.keyboard.press("Enter");
  await expect(assignedTokens.getByRole("checkbox", { name: /Backup client/ })).not.toBeChecked();
  tokenQueries.length = 0;
  await groupDialog.getByLabel("Filter members and models").fill("backup");
  await expect.poll(() => tokenQueries).toEqual(["backup"]);
  await expect(assignedTokens.getByRole("checkbox", { name: /Backup client/ })).toBeVisible();
  expect(tokenQueries.some((query) => query !== "backup")).toBe(false);
  await groupDialog.getByLabel("Filter members and models").fill("");
  await expect(assignedTokens.getByRole("checkbox", { name: /CI client/ })).toBeVisible();
  await assignedModels.getByRole("checkbox", { name: /Model One/ }).focus();
  await page.keyboard.press("Space");
  await groupDialog.getByRole("button", { name: "Save group" }).focus();
  await page.keyboard.press("Enter");
  await expect(groupDialog.getByText("Confirm access widening")).toBeVisible();
  await expect(groupDialog.getByText(/model\(s\).*become public/)).toBeVisible();
  await groupDialog.getByRole("button", { name: "Confirm widening and save" }).focus();
  await page.keyboard.press("Enter");
  await expect(groupDialog.getByText(/changed in another session/)).toBeVisible();
  await groupDialog.getByRole("button", { name: "Confirm widening and save" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Access group updated.")).toBeAttached();
  tokenQueries.length = 0;
  await page.getByLabel("Find a token").fill("CI client");
  await expect.poll(() => tokenQueries).toEqual(["CI client"]);
  expect(tokenQueries.some((query) => query !== "CI client")).toBe(false);
  await page.getByRole("button", { name: "Use owner access" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Allow CI client to inherit/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm owner inheritance" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("CI client now inherits its owner’s access.")).toBeAttached();
  await page.getByRole("button", { name: "Alias", exact: true }).focus();
  await page.keyboard.press("Enter");
  const createAlias = page.getByRole("dialog", { name: "Create model alias" });
  await createAlias.getByLabel("Alias").pressSequentially("friendly-model");
  await createAlias.getByLabel("Description").pressSequentially("Stable client-facing name");
  await createAlias.getByRole("button", { name: "Save alias" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("friendly-model", { exact: true })).toBeVisible();
  const editAliasButton = page.getByRole("button", { name: "Edit alias friendly-model" });
  await editAliasButton.scrollIntoViewIfNeeded();
  await editAliasButton.focus();
  await page.keyboard.press("Enter");
  const editAlias = page.getByRole("dialog", { name: /Edit alias/ });
  await editAlias.getByLabel("Description").focus();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
  await page.keyboard.type("Updated alias");
  await editAlias.getByRole("button", { name: "Save alias" }).focus();
  await page.keyboard.press("Enter");
  const deleteAliasButton = page.getByRole("button", { name: "Delete alias friendly-model" });
  await deleteAliasButton.scrollIntoViewIfNeeded();
  await deleteAliasButton.focus();
  await page.keyboard.press("Enter");
  const deleteAlias = page.getByRole("dialog", { name: /Delete alias friendly-model/ });
  await deleteAlias.getByRole("button", { name: "Delete" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("No aliases. Clients must use canonical public model IDs."))
    .toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole("button", { name: "Access group" })).toBeVisible();
  expect(
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  )
    .toBeTruthy();
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => {
    const browser = globalThis as unknown as {
      document: { documentElement: { style: { fontSize: string }; scrollWidth: number } };
      innerWidth: number;
    };
    browser.document.documentElement.style.fontSize = "200%";
  });
  expect(
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  )
    .toBeTruthy();
  await expect(page.getByRole("button", { name: "Access group" })).toBeVisible();
});

test("token settings expose loading, fetch failure, retry, and empty states", async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  let reads = 0;
  await page.route("**/api/tokens**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/tokens" || route.request().method() !== "GET") {
      throw new Error(
        `Unexpected token state request: ${route.request().method()} ${url.pathname}`,
      );
    }
    reads++;
    if (reads <= 2) {
      if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 250));
      return route.fulfill({
        status: 503,
        json: { error: { code: "temporarily_unavailable", message: "Token service unavailable" } },
      });
    }
    return route.fulfill({ json: { data: [] } });
  });
  if ((page.viewportSize()?.width ?? 1280) <= 800) {
    await page.getByRole("button", { name: "Open menu", exact: true }).focus();
    await page.keyboard.press("Enter");
  }
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "API tokens", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Loading API tokens" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Token service unavailable" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Retry" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("No API tokens yet")).toBeVisible();
});
