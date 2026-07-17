import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteDialog, GroupDialog } from "./AdminModelAccess.tsx";
import { api, ApiError } from "./api.ts";
import type { AccessGroupPolicyImpact, AdminModel, ModelAccessGroup } from "./types.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
const browserGlobals = Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
for (const [key, value] of browserGlobals) {
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
}
const { act, cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const impact = (modelIds: string[] = []): AccessGroupPolicyImpact => ({
  modelIdsBecomingPublic: modelIds,
  tokenIdsLosingGroupAccess: [],
  tokenIdsRevertingToOwnerInheritance: [],
});

const group: ModelAccessGroup = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Restricted",
  description: "Private models",
  version: 2,
  userIds: [],
  tokenIds: [],
  tokenOwners: [],
  modelIds: ["00000000-0000-4000-8000-000000000101"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const model = (id: string, name: string): AdminModel =>
  ({
    id,
    providerId: "00000000-0000-4000-8000-000000000201",
    publicModelId: `test/${name.toLowerCase()}`,
    upstreamModelId: name.toLowerCase(),
    displayName: name,
    capabilities: ["chat"],
    contextWindow: 4096,
    enabled: true,
    version: 1,
    customParams: {},
    prices: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as AdminModel;

const models = [
  model("00000000-0000-4000-8000-000000000101", "Original"),
  model("00000000-0000-4000-8000-000000000102", "Refreshed"),
];

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function renderGroup(
  saved = vi.fn(() => Promise.resolve()),
  close = vi.fn(),
) {
  const client = queryClient();
  const rendered = render(
    <QueryClientProvider client={client}>
      <GroupDialog
        group={group}
        models={models}
        users={[]}
        close={close}
        saved={saved}
      />
    </QueryClientProvider>,
  );
  return { client, saved, close, ...rendered };
}

function renderDelete(
  loadImpact: () => Promise<AccessGroupPolicyImpact>,
  remove: (acknowledgement: string[]) => Promise<void>,
  options: {
    close?: () => void;
    removed?: () => Promise<void>;
    operation?: "delete-access-group" | "delete-model-alias";
    targetId?: string;
    targetVersion?: number;
    title?: string;
  } = {},
) {
  const client = queryClient();
  const rendered = render(
    <QueryClientProvider client={client}>
      <DeleteDialog
        operation={options.operation ?? "delete-access-group"}
        targetId={options.targetId ?? group.id}
        targetVersion={options.targetVersion ?? group.version}
        title={options.title ?? "Delete Restricted?"}
        detail="Delete this access group."
        models={models}
        impact={loadImpact}
        close={options.close ?? (() => undefined)}
        remove={remove}
        removed={options.removed ?? (() => Promise.resolve())}
      />
    </QueryClientProvider>,
  );
  return { client, ...rendered };
}

describe("rendered model-access widening confirmation", () => {
  beforeEach(() => {
    vi.spyOn(api, "adminModelAccessTokens").mockResolvedValue({
      data: [],
      nextCursor: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("disables stale confirmation until re-preview and requires a second exact confirmation", async () => {
    const refreshed = deferred<AccessGroupPolicyImpact>();
    vi.spyOn(api, "previewAdminModelAccessGroupPolicy")
      .mockResolvedValueOnce(impact([models[0].id]))
      .mockImplementationOnce(() => refreshed.promise);
    const replace = vi.spyOn(api, "replaceAdminModelAccessGroupPolicy")
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "model_access_widening_acknowledgement_required",
          "Impact changed",
        ),
      )
      .mockResolvedValueOnce({ ...group, version: 3, modelIds: [] });
    const saved = vi.fn(() => Promise.resolve());
    renderGroup(saved);

    fireEvent.click(await screen.findByRole("button", { name: "Save group" }));
    const firstConfirm = await screen.findByRole("button", {
      name: "Confirm widening and save",
    });
    fireEvent.click(firstConfirm);

    expect((await screen.findByRole("status")).textContent).toContain("Refreshing access impact");
    expect(screen.queryByRole("button", { name: "Confirm widening and save" })).toBeNull();
    expect((screen.getByRole("button", { name: "Checking policy…" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(document.querySelector("form")?.getAttribute("aria-busy")).toBe("true");

    await act(() => refreshed.resolve(impact([models[1].id])));
    const secondConfirm = await screen.findByRole("button", {
      name: "Confirm widening and save",
    });
    expect(screen.getAllByText("Refreshed").length).toBeGreaterThan(0);
    fireEvent.click(secondConfirm);

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0][1].acknowledgePublicModelIds).toEqual([models[0].id]);
    expect(replace.mock.calls[1][1].acknowledgePublicModelIds).toEqual([models[1].id]);
  });

  it("removes empty refreshed impact and prioritizes a newer preview failure", async () => {
    const refreshed = deferred<AccessGroupPolicyImpact>();
    const preview = vi.spyOn(api, "previewAdminModelAccessGroupPolicy")
      .mockResolvedValueOnce(impact([models[0].id]))
      .mockImplementationOnce(() => refreshed.promise)
      .mockRejectedValueOnce(new Error("Preview service offline"));
    vi.spyOn(api, "replaceAdminModelAccessGroupPolicy").mockRejectedValueOnce(
      new ApiError(
        409,
        "model_access_widening_acknowledgement_required",
        "Impact changed",
      ),
    );
    renderGroup();

    fireEvent.click(await screen.findByRole("button", { name: "Save group" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm widening and save" }));
    await act(() => refreshed.resolve(impact()));

    await screen.findByText(/Access impact changed while you were confirming/);
    expect(screen.queryByRole("button", { name: "Confirm widening and save" })).toBeNull();
    const save = screen.getByRole("button", { name: "Save group" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    expect((await screen.findByRole("alert")).textContent).toContain("Preview service offline");
    expect(screen.queryByText(/Review the refreshed impact/)).toBeNull();
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it("locks metadata and assignments throughout preview and save", async () => {
    const pendingPreview = deferred<AccessGroupPolicyImpact>();
    const pendingSave = deferred<ModelAccessGroup>();
    const preview = vi.spyOn(api, "previewAdminModelAccessGroupPolicy")
      .mockImplementationOnce(() => pendingPreview.promise);
    const replace = vi.spyOn(api, "replaceAdminModelAccessGroupPolicy")
      .mockImplementationOnce(() => pendingSave.promise);
    const saved = vi.fn(() => Promise.resolve());
    renderGroup(saved);

    fireEvent.click(await screen.findByRole("button", { name: "Save group" }));

    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("textbox").every((input) => (input as HTMLInputElement).disabled))
      .toBe(true);
    expect(screen.getAllByRole("checkbox").every((input) => (input as HTMLInputElement).disabled))
      .toBe(true);

    await act(() => pendingPreview.resolve(impact()));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("textbox").every((input) => (input as HTMLInputElement).disabled))
      .toBe(true);
    expect(screen.getAllByRole("checkbox").every((input) => (input as HTMLInputElement).disabled))
      .toBe(true);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(() => pendingSave.resolve({ ...group, version: group.version + 1 }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("textbox").every((input) => !(input as HTMLInputElement).disabled))
      .toBe(true);
    expect(screen.getAllByRole("checkbox").every((input) => !(input as HTMLInputElement).disabled))
      .toBe(true);
  });

  it("stops a pending preview in place without discarding the draft", async () => {
    const pendingPreview = deferred<AccessGroupPolicyImpact>();
    const preview = vi.spyOn(api, "previewAdminModelAccessGroupPolicy")
      .mockImplementationOnce(() => pendingPreview.promise);
    const replace = vi.spyOn(api, "replaceAdminModelAccessGroupPolicy");
    const close = vi.fn();
    renderGroup(undefined, close);

    const description = await screen.findByLabelText("Description") as HTMLInputElement;
    fireEvent.change(description, { target: { value: "Preserve this careful draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save group" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());

    const cancel = screen.getByRole("button", { name: "Stop checking" }) as HTMLButtonElement;
    const closeButton = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(closeButton.disabled).toBe(true);
    fireEvent.mouseDown(document.querySelector(".modal-overlay")!);
    expect(close).not.toHaveBeenCalled();
    const signal = preview.mock.calls[0][2] as AbortSignal;
    fireEvent.click(cancel);
    expect(signal.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(description.value).toBe("Preserve this careful draft");
    expect(description.disabled).toBe(false);
    await act(() => pendingPreview.resolve(impact([models[0].id])));
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("reloads a conflicting group version while preserving the draft", async () => {
    const latest = { ...group, version: group.version + 1, description: "Concurrent edit" };
    const latestGroups = deferred<ModelAccessGroup[]>();
    vi.spyOn(api, "adminModelAccessGroups").mockImplementationOnce(() => latestGroups.promise);
    const preview = vi.spyOn(api, "previewAdminModelAccessGroupPolicy").mockResolvedValue(impact());
    const replace = vi.spyOn(api, "replaceAdminModelAccessGroupPolicy")
      .mockRejectedValueOnce(new ApiError(409, "version_conflict", "Version changed"))
      .mockResolvedValueOnce({ ...latest, version: latest.version + 1 });
    const saved = vi.fn(() => Promise.resolve());
    renderGroup(saved);

    const description = await screen.findByLabelText("Description") as HTMLInputElement;
    fireEvent.change(description, { target: { value: "My unsaved draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save group" }));

    const refreshing = await screen.findByRole("button", {
      name: "Refreshing latest version…",
    }) as HTMLButtonElement;
    expect(refreshing.disabled).toBe(true);
    expect(document.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(refreshing);
    expect(preview).toHaveBeenCalledTimes(1);
    await act(() => latestGroups.resolve([latest]));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "latest version is loaded and your draft is preserved",
    );
    expect(description.value).toBe("My unsaved draft");
    fireEvent.click(screen.getByRole("button", { name: "Save group" }));

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0][0].version).toBe(group.version);
    expect(replace.mock.calls[1][0].version).toBe(latest.version);
    expect(replace.mock.calls[1][1].description).toBe("My unsaved draft");
  });

  it("does not continue a pending group save after external unmount", async () => {
    const pendingPreview = deferred<AccessGroupPolicyImpact>();
    const preview = vi.spyOn(api, "previewAdminModelAccessGroupPolicy")
      .mockImplementationOnce(() => pendingPreview.promise);
    const replace = vi.spyOn(api, "replaceAdminModelAccessGroupPolicy");
    const saved = vi.fn(() => Promise.resolve());
    const rendered = renderGroup(saved);

    fireEvent.click(await screen.findByRole("button", { name: "Save group" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    rendered.unmount();
    await act(() => pendingPreview.resolve(impact()));

    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("announces delete refetch, suppresses stale impact, and fails closed on refresh error", async () => {
    const refreshed = deferred<AccessGroupPolicyImpact>();
    const loadImpact = vi.fn()
      .mockResolvedValueOnce(impact([models[0].id]))
      .mockImplementationOnce(() => refreshed.promise);
    const remove = vi.fn().mockRejectedValueOnce(
      new ApiError(
        409,
        "model_access_widening_acknowledgement_required",
        "Impact changed",
      ),
    );
    renderDelete(loadImpact, remove);

    const deleteButton = await screen.findByRole("button", { name: "Delete and widen access" });
    fireEvent.click(deleteButton);

    expect((await screen.findByRole("status")).textContent).toContain("Refreshing access impact");
    expect(screen.queryByLabelText("Models becoming public")).toBeNull();
    const disabledDelete = screen.getByRole("button", { name: "Delete" });
    expect((disabledDelete as HTMLButtonElement).disabled).toBe(true);
    expect(disabledDelete.closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");

    await act(() => refreshed.reject(new Error("Impact service offline")));
    const refreshError = await screen.findByRole("alert");
    expect(refreshError.textContent).toContain(
      "Could not refresh the access impact",
    );
    await waitFor(() => expect(document.activeElement).toBe(refreshError));
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByLabelText("Models becoming public")).toBeNull();
  });

  it("uses refreshed exact IDs and shows only a second-attempt delete failure", async () => {
    const loadImpact = vi.fn()
      .mockResolvedValueOnce(impact([models[0].id]))
      .mockResolvedValueOnce(impact([models[1].id]));
    const remove = vi.fn()
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "model_access_widening_acknowledgement_required",
          "Impact changed",
        ),
      )
      .mockRejectedValueOnce(new ApiError(409, "version_conflict", "Version changed"));
    renderDelete(loadImpact, remove);

    fireEvent.click(await screen.findByRole("button", { name: "Delete and widen access" }));
    await screen.findByText("Refreshed");
    fireEvent.click(await screen.findByRole("button", { name: "Delete and widen access" }));

    await screen.findByText(/This item changed in another session/);
    expect(screen.queryByText(/Access changed while you were confirming/)).toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[0][0]).toEqual([models[0].id]);
    expect(remove.mock.calls[1][0]).toEqual([models[1].id]);
  });

  it("deletes once with refreshed exact IDs after stale acknowledgement", async () => {
    const loadImpact = vi.fn()
      .mockResolvedValueOnce(impact([models[0].id]))
      .mockResolvedValueOnce(impact([models[1].id]));
    const remove = vi.fn()
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "model_access_widening_acknowledgement_required",
          "Impact changed",
        ),
      )
      .mockResolvedValueOnce(undefined);
    const removed = vi.fn(() => Promise.resolve());
    renderDelete(loadImpact, remove, { removed });

    fireEvent.click(await screen.findByRole("button", { name: "Delete and widen access" }));
    await screen.findByText("Refreshed");
    fireEvent.click(await screen.findByRole("button", { name: "Delete and widen access" }));

    await waitFor(() => expect(removed).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[0][0]).toEqual([models[0].id]);
    expect(remove.mock.calls[1][0]).toEqual([models[1].id]);
  });

  it("allows pending delete-impact dismissal and fences its late response", async () => {
    const pendingImpact = deferred<AccessGroupPolicyImpact>();
    const loadImpact = vi.fn(() => pendingImpact.promise);
    const remove = vi.fn(() => Promise.resolve());
    const removed = vi.fn(() => Promise.resolve());
    const close = vi.fn();
    const rendered = renderDelete(loadImpact, remove, {
      close,
      removed,
      targetId: "00000000-0000-4000-8000-000000000777",
      targetVersion: 9,
    });

    await waitFor(() => expect(loadImpact).toHaveBeenCalledOnce());
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(close).toHaveBeenCalledOnce();
    expect(
      rendered.client.getQueryCache().find({
        queryKey: [
          "model-access-delete-impact",
          "delete-access-group",
          "00000000-0000-4000-8000-000000000777",
          9,
        ],
      }),
    ).toBeTruthy();

    rendered.unmount();
    await act(() => pendingImpact.resolve(impact([models[0].id])));
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it("lets users abort a pending delete mutation without allowing late completion", async () => {
    const pendingRemove = deferred<void>();
    const remove = vi.fn((_acknowledgement: string[], _signal?: AbortSignal) =>
      pendingRemove.promise
    );
    const removed = vi.fn(() => Promise.resolve());
    const close = vi.fn();
    renderDelete(() => Promise.resolve(impact()), remove, { close, removed });

    const deleteButton = await screen.findByRole("button", { name: "Delete" });
    await waitFor(() => expect((deleteButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(deleteButton);
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    const signal = remove.mock.calls[0][1] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));

    expect(signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    await act(() => pendingRemove.resolve());
    await Promise.resolve();
    expect(removed).not.toHaveBeenCalled();
  });

  it("does not render an empty delete-impact alert", async () => {
    renderDelete(() => Promise.resolve(impact()), () => Promise.resolve());

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
        false,
      )
    );
    expect(screen.queryByLabelText("Models becoming public")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refetches a security impact on mount even when the production cache is fresh", async () => {
    const key = ["model-access-delete-impact", "delete-access-group", group.id, group.version];
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(key, impact([models[0].id]));
    const loadImpact = vi.fn(() => Promise.resolve(impact([models[1].id])));
    render(
      <QueryClientProvider client={client}>
        <DeleteDialog
          operation="delete-access-group"
          targetId={group.id}
          targetVersion={group.version}
          title="Delete Restricted?"
          detail="Delete this access group."
          models={models}
          impact={loadImpact}
          close={() => undefined}
          remove={() => Promise.resolve()}
          removed={() => Promise.resolve()}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(loadImpact).toHaveBeenCalledOnce());
    await screen.findByText("Refreshed");
    expect(screen.queryByText("Original")).toBeNull();
  });

  it("completes the group save flow under React StrictMode", async () => {
    vi.spyOn(api, "previewAdminModelAccessGroupPolicy").mockResolvedValue(impact());
    vi.spyOn(api, "replaceAdminModelAccessGroupPolicy").mockResolvedValue({
      ...group,
      version: group.version + 1,
    });
    const saved = vi.fn(() => Promise.resolve());
    const client = queryClient();
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <GroupDialog
            group={group}
            models={models}
            users={[]}
            close={() => undefined}
            saved={saved}
          />
        </QueryClientProvider>
      </StrictMode>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Save group" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });
});
