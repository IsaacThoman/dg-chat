import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminResilience,
  defaultPolicyInput,
  degradedTargetReasons,
  expandedRouteModelIds,
  isVersionConflict,
  modelAvailabilityReasons,
  policyInput,
  reorderTargets,
  resilienceAdminClient,
  ResilienceAdminError,
  type ResilienceModel,
  routeCandidateReasons,
  RouteTargetControls,
  validatePolicyDraft,
} from "./AdminResilience.tsx";

afterEach(() => vi.unstubAllGlobals());

const source: ResilienceModel = {
  id: "source",
  publicModelId: "one/source",
  displayName: "Source",
  providerId: "provider-one",
  providerName: "One",
  enabled: true,
  providerEnabled: true,
  configured: true,
  protocol: "chat_completions",
  priced: true,
  capabilities: ["chat", "tools"],
  contextWindow: 128_000,
};
const fallback: ResilienceModel = {
  ...source,
  id: "fallback",
  publicModelId: "two/fallback",
  displayName: "Fallback",
  providerId: "provider-two",
  providerName: "Two",
};

describe("admin resilience policy forms", () => {
  it("builds bounded create and detached edit values", () => {
    const create = defaultPolicyInput();
    expect(validatePolicyDraft(create)).toBe("Name must contain 1–120 characters.");
    create.name = "Reliable";
    expect(validatePolicyDraft(create)).toBeUndefined();
    expect(validatePolicyDraft({ ...create, maxAttempts: 1, maxRetries: 1 })).toContain("less");
    expect(validatePolicyDraft({ ...create, totalTimeoutMs: 1_000 })).toContain("cover");
    expect(validatePolicyDraft({ ...create, maxAttempts: 2.5 })).toContain("whole numbers");

    const edit = policyInput({
      ...create,
      id: "policy",
      version: 4,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    edit.retryableStatuses.pop();
    expect(create.retryableStatuses).toHaveLength(7);
  });

  it("uses exact create and optimistic edit endpoints", async () => {
    const input = { ...defaultPolicyInput(), name: "Reliable" };
    const policy = { ...input, id: "policy", version: 3, createdAt: "", updatedAt: "" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(policy, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ ...policy, version: 4 }));
    vi.stubGlobal("fetch", fetchMock);
    await resilienceAdminClient.createPolicy(input);
    await resilienceAdminClient.updatePolicy("policy", 3, input);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/resilience/policies");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/admin/resilience/policies/policy");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      expectedVersion: 3,
      name: "Reliable",
    });
  });

  it("runs playground scenarios through the isolated admin endpoint", async () => {
    const result = { ok: true as const, completion: { text: "ready" } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetchMock);
    const scenario = { id: "preview", name: "Preview", seed: 1, steps: [] };
    expect(await resilienceAdminClient.runPlayground(scenario)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/resilience/playground",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify(scenario),
      }),
    );
  });
});

describe("admin resilience routes", () => {
  it("renders unavailable sources and disabled retry semantics in the integrated view", () => {
    const queryClient = new QueryClient();
    const disabledPolicy = {
      ...defaultPolicyInput(),
      id: "disabled-policy",
      name: "Paused retries",
      enabled: false,
      version: 2,
      createdAt: "",
      updatedAt: "",
    };
    queryClient.setQueryData(["admin-resilience-policies"], [disabledPolicy]);
    queryClient.setQueryData(["admin-resilience-routes"], [{
      model: { ...source, enabled: false },
      route: {
        id: "route",
        sourceModelId: source.id,
        retryPolicyId: disabledPolicy.id,
        fallbackModelIds: [],
        version: 3,
        createdAt: "",
        updatedAt: "",
      },
    }]);
    const never = () => Promise.reject(new Error("Unexpected request"));
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AdminResilience
          client={{
            listPolicies: never,
            createPolicy: never,
            updatePolicy: never,
            listRoutes: never,
            setRoute: never,
            runPlayground: never,
          }}
        />
      </QueryClientProvider>,
    );
    expect(markup).toContain("unavailable");
    expect(markup).toContain("Paused retries (disabled — no retries)");
    expect(markup).toContain("Model disabled");
    expect(markup).toContain("Retry policy disabled or unavailable");
  });

  it("reorders without mutation and exposes keyboard-friendly controls", () => {
    const original = ["a", "b", "c"];
    expect(reorderTargets(original, 1, -1)).toEqual(["b", "a", "c"]);
    expect(reorderTargets(original, 2, 1)).toEqual(original);
    expect(original).toEqual(["a", "b", "c"]);
    const markup = renderToStaticMarkup(
      <RouteTargetControls
        source={source}
        targets={[fallback.id]}
        models={[source, fallback]}
        setTargets={() => undefined}
      />,
    );
    expect(markup).toContain("<ol");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain("Move Fallback up");
    expect(markup).toContain("Move Fallback down");
    expect(markup).toContain("Remove Fallback");
    expect(markup).not.toContain("draggable");
  });

  it("explains degraded targets precisely", () => {
    expect(
      degradedTargetReasons(source, {
        ...fallback,
        enabled: false,
        providerEnabled: false,
        configured: false,
        capabilities: ["chat"],
        contextWindow: 32_000,
      }),
    ).toEqual([
      "Model disabled",
      "Provider disabled",
      "Credential missing",
      "Missing capabilities: tools",
      "Smaller context window",
    ]);
    expect(degradedTargetReasons(source, undefined)).toEqual(["Model no longer exists"]);
  });

  it("reports source availability, protocol, and effective pricing separately", () => {
    expect(modelAvailabilityReasons({
      ...source,
      enabled: false,
      providerEnabled: false,
      configured: false,
      priced: false,
    })).toEqual([
      "Model disabled",
      "Provider disabled",
      "Credential missing",
      "Effective price missing",
    ]);
    expect(degradedTargetReasons(source, {
      ...fallback,
      protocol: "responses",
      priced: false,
    })).toEqual(["Effective price missing", "Protocol mismatch"]);
  });

  it("expands nested routes and rejects cycle or oversized candidates before save", () => {
    const nested = { ...fallback, id: "nested", displayName: "Nested" };
    const entries = [
      { model: source, route: null },
      {
        model: fallback,
        route: {
          id: "fallback-route",
          sourceModelId: fallback.id,
          retryPolicyId: null,
          fallbackModelIds: [nested.id],
          version: 1,
          createdAt: "",
          updatedAt: "",
        },
      },
      {
        model: nested,
        route: {
          id: "nested-route",
          sourceModelId: nested.id,
          retryPolicyId: null,
          fallbackModelIds: [source.id],
          version: 1,
          createdAt: "",
          updatedAt: "",
        },
      },
    ];
    expect([...expandedRouteModelIds(source.id, [fallback.id], entries)]).toEqual([
      source.id,
      fallback.id,
      nested.id,
    ]);
    expect(routeCandidateReasons(source, fallback, [], entries)).toContain(
      "Would create a fallback cycle",
    );

    const manyEntries = Array.from({ length: 8 }, (_, index) => ({
      model: { ...fallback, id: `model-${index}` },
      route: index < 7
        ? {
          id: `route-${index}`,
          sourceModelId: `model-${index}`,
          retryPolicyId: null,
          fallbackModelIds: [`model-${index + 1}`],
          version: 1,
          createdAt: "",
          updatedAt: "",
        }
        : null,
    }));
    expect(routeCandidateReasons(source, manyEntries[0].model, [], [
      { model: source, route: null },
      ...manyEntries,
    ])).toContain("Expanded route would exceed eight models");
  });

  it("sends ordered route versions and surfaces cycle/server errors safely", async () => {
    const conflict = Response.json({
      error: { code: "fallback_cycle", message: "Fallback cycle detected" },
    }, { status: 409 });
    const fetchMock = vi.fn().mockResolvedValue(conflict);
    vi.stubGlobal("fetch", fetchMock);
    const error = await resilienceAdminClient.setRoute({
      sourceModelId: "source/id",
      expectedVersion: 2,
      retryPolicyId: "policy",
      fallbackModelIds: ["b", "a"],
    }).catch((reason) => reason);
    expect(error).toBeInstanceOf(ResilienceAdminError);
    expect(error).toMatchObject({
      status: 409,
      code: "fallback_cycle",
      message: "Fallback cycle detected",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/resilience/routes/source%2Fid");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      sourceModelId: "source/id",
      expectedVersion: 2,
      retryPolicyId: "policy",
      fallbackModelIds: ["b", "a"],
    });
  });

  it("recognizes optimistic conflicts for reload recovery and ignores generic errors", () => {
    expect(isVersionConflict(new ResilienceAdminError(409, "version_conflict", "changed"))).toBe(
      true,
    );
    expect(isVersionConflict(new ResilienceAdminError(409, "fallback_cycle", "cycle"))).toBe(false);
    expect(isVersionConflict(new Error("network"))).toBe(false);
  });

  it("does not reflect HTML server bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<script>secret</script>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const error = await resilienceAdminClient.listRoutes().catch((reason) => reason);
    expect(error).toMatchObject({ message: "Request failed (500)", code: "request_failed" });
    expect(String(error)).not.toContain("secret");
  });
});
