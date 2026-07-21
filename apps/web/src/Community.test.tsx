import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  communityDraft,
  communityDraftError,
  CommunityView,
  formatCommunityValue,
} from "./Community.tsx";
import { api, ApiError } from "./api.ts";
import type { CommunityLeaderboardPage, CommunityProfile } from "./types.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/community",
});
const browserGlobals = Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
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
const { cleanup, fireEvent, render, screen, waitFor, within } = await import(
  "@testing-library/react"
);

const profile = (patch: Partial<CommunityProfile> = {}): CommunityProfile => ({
  userId: "7fc018b5-1357-4c49-96f1-34ca3145652c",
  optedIn: false,
  identityMode: "anonymous",
  nickname: null,
  color: "slate",
  shareBalance: false,
  version: 1,
  createdAt: "2026-07-17T12:00:00.000Z",
  updatedAt: "2026-07-17T12:00:00.000Z",
  ...patch,
});

const leaderboard = (patch: Partial<CommunityLeaderboardPage> = {}): CommunityLeaderboardPage => ({
  metric: "calls",
  window: "30d",
  from: "2026-06-17T12:00:00.000Z",
  asOf: "2026-07-17T12:00:00.000Z",
  data: [],
  nextCursor: null,
  ...patch,
});

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function renderCommunity() {
  const queryClient = client();
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <CommunityView onMenu={() => undefined} />
      </QueryClientProvider>,
    ),
  };
}

describe("community profile helpers", () => {
  it("normalizes private profile defaults into an empty, anonymous draft", () => {
    expect(communityDraft(profile())).toEqual({
      optedIn: false,
      identityMode: "anonymous",
      nickname: "",
      color: "slate",
      shareBalance: false,
    });
  });

  it("validates the trimmed nickname while retaining the draft text for submission", () => {
    const namedDraft = {
      ...communityDraft(profile()),
      identityMode: "nickname" as const,
    };

    expect(communityDraftError({ ...namedDraft, nickname: "  Maple Pilot  " })).toBe("");
    expect(communityDraftError({ ...namedDraft, nickname: " a " })).not.toBe("");
    expect(communityDraftError({ ...namedDraft, nickname: "-Maple" })).not.toBe("");
    expect(communityDraftError({ ...namedDraft, nickname: "Maple🙂" })).not.toBe("");
    expect(
      communityDraftError({
        ...namedDraft,
        nickname: "a".repeat(33),
      }),
    ).not.toBe("");
    expect(
      communityDraftError({
        ...namedDraft,
        identityMode: "anonymous",
        nickname: "-ignored while anonymous",
      }),
    ).toBe("");
  });

  it("formats count and USD-micro values according to their metric", () => {
    expect(formatCommunityValue("calls", 12_345)).toBe(new Intl.NumberFormat().format(12_345));
    expect(formatCommunityValue("tokens", 98_765)).toBe(new Intl.NumberFormat().format(98_765));
    expect(formatCommunityValue("cost", 1_250_000)).toMatch(/\$1\.25/);
    expect(formatCommunityValue("balance", 5_000_001)).toMatch(/\$5\.000001/);
  });
});

describe("CommunityView", () => {
  beforeEach(() => {
    Object.defineProperty(dom.window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    vi.spyOn(api, "communityProfile").mockResolvedValue(profile());
    vi.spyOn(api, "communityLeaderboard").mockResolvedValue(leaderboard());
    vi.spyOn(api, "updateCommunityProfile").mockResolvedValue(profile({ version: 2 }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps participation anonymous and balance sharing independently disabled by default", async () => {
    renderCommunity();
    const join = await screen.findByRole("checkbox", { name: /Join the community leaderboard/ });
    const balance = screen.getByRole("checkbox", { name: /Share my current balance/ });
    expect((join as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: /^Anonymous/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((balance as HTMLInputElement).checked).toBe(false);
    expect((balance as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(join);
    expect((balance as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: /^Nickname/ }));
    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "-bad" } });
    expect(screen.getByLabelText("Nickname").getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "  Maple Pilot  " } });
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    fireEvent.click(balance);
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(api.updateCommunityProfile).toHaveBeenCalledOnce());
    expect(vi.mocked(api.updateCommunityProfile).mock.calls[0][0]).toEqual({
      expectedVersion: 1,
      optedIn: true,
      identityMode: "nickname",
      nickname: "Maple Pilot",
      color: "violet",
      shareBalance: true,
    });
  });

  it("clears separate balance consent whenever participation is disabled", async () => {
    vi.mocked(api.communityProfile).mockResolvedValue(
      profile({ optedIn: true, shareBalance: true }),
    );
    renderCommunity();
    const join = await screen.findByRole("checkbox", { name: /Join the community leaderboard/ });
    const balance = screen.getByRole("checkbox", { name: /Share my current balance/ });
    expect((join as HTMLInputElement).checked).toBe(true);
    expect((balance as HTMLInputElement).checked).toBe(true);

    fireEvent.click(join);

    expect((join as HTMLInputElement).checked).toBe(false);
    expect((balance as HTMLInputElement).checked).toBe(false);
    expect((balance as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.updateCommunityProfile).toHaveBeenCalledOnce());
    expect(vi.mocked(api.updateCommunityProfile).mock.calls[0][0]).toMatchObject({
      optedIn: false,
      shareBalance: false,
    });
  });

  it("renders privacy-safe rows, formats micros, and supports keyboard metric navigation", async () => {
    vi.mocked(api.communityLeaderboard).mockResolvedValue(
      leaderboard({
        data: [
          {
            position: 1,
            identityMode: "anonymous",
            nickname: null,
            color: null,
            value: 14,
          },
          {
            position: 1,
            identityMode: "anonymous",
            nickname: null,
            color: null,
            value: 14,
          },
        ],
      }),
    );
    renderCommunity();
    const rankingTable = await screen.findByRole("table");
    const rankings = within(rankingTable);
    expect(document.querySelectorAll(".community-ranking-row .community-identity strong"))
      .toHaveLength(2);
    expect(rankings.getAllByLabelText("Rank 1")).toHaveLength(2);
    expect(rankings.getAllByText("14")).toHaveLength(2);
    expect(rankings.getAllByText("Anonymous")).toHaveLength(2);
    expect(rankings.getAllByText("Private identity")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("7fc018b5-1357-4c49-96f1-34ca3145652c");
    expect(document.querySelectorAll(".community-avatar.neutral")).toHaveLength(2);
    expect(document.querySelectorAll(".community-avatar[data-community-color]")).toHaveLength(0);

    const calls = screen.getByRole("tab", { name: "Calls" });
    fireEvent.keyDown(calls, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Tokens" }).getAttribute("aria-selected")).toBe(
        "true",
      )
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Tokens" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Balance" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() =>
      expect(api.communityLeaderboard).toHaveBeenCalledWith("balance", "30d", undefined)
    );
  });

  it("rebases a nickname conflict without overwriting unrelated remote privacy fields", async () => {
    vi.mocked(api.communityProfile)
      .mockResolvedValueOnce(profile())
      .mockResolvedValueOnce(profile({ version: 4, color: "blue" }));
    vi.mocked(api.updateCommunityProfile)
      .mockRejectedValueOnce(new ApiError(409, "version_conflict", "Profile changed"))
      .mockResolvedValueOnce(
        profile({
          optedIn: true,
          identityMode: "nickname",
          nickname: "Draft Name",
          color: "blue",
          version: 5,
        }),
      );
    renderCommunity();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Join the community leaderboard/ }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Nickname/ }));
    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "Draft Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("without overwriting");
    expect((screen.getByLabelText("Nickname") as HTMLInputElement).value).toBe("Draft Name");
    expect((screen.getByRole("radio", { name: "Blue" }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(alert));

    fireEvent.click(screen.getByRole("button", { name: "Review and save again" }));
    await waitFor(() => expect(api.updateCommunityProfile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.updateCommunityProfile).mock.calls[1][0]).toEqual({
      expectedVersion: 4,
      optedIn: true,
      identityMode: "nickname",
      nickname: "Draft Name",
    });
  });

  it("does not silently reverse a concurrent participation or balance-sharing revocation", async () => {
    vi.mocked(api.communityProfile)
      .mockResolvedValueOnce(profile({ optedIn: true, shareBalance: false }))
      .mockResolvedValueOnce(profile({ version: 4, optedIn: false, shareBalance: false }));
    vi.mocked(api.updateCommunityProfile).mockRejectedValueOnce(
      new ApiError(409, "version_conflict", "Profile changed"),
    );
    renderCommunity();
    const balance = await screen.findByRole("checkbox", { name: /Share my current balance/ });
    fireEvent.click(balance);
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("newer privacy choice was applied");
    await waitFor(() => {
      expect(
        (screen.getByRole("checkbox", {
          name: /Join the community leaderboard/,
        }) as HTMLInputElement).checked,
      ).toBe(false);
      const currentBalance = screen.getByRole("checkbox", {
        name: /Share my current balance/,
      }) as HTMLInputElement;
      expect(currentBalance.checked).toBe(false);
      expect(currentBalance.disabled).toBe(true);
    });
    expect(screen.queryByRole("button", { name: "Review and save again" })).toBeNull();
    expect(api.updateCommunityProfile).toHaveBeenCalledTimes(1);
  });

  it("distinguishes empty, error, and explicit offline states", async () => {
    Object.defineProperty(dom.window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    vi.mocked(api.communityProfile).mockRejectedValue(new Error("offline"));
    vi.mocked(api.communityLeaderboard).mockRejectedValue(new Error("offline"));
    renderCommunity();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((item) => item.textContent).join(" ")).toContain(
      "Your profile couldn’t be loaded",
    );
    expect(alerts.map((item) => item.textContent).join(" ")).toContain(
      "Rankings couldn’t be loaded",
    );
    expect(screen.getByText(/You’re offline/).getAttribute("role")).toBe("status");
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThanOrEqual(2);
  });
});
