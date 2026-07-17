import type { CommunityLeaderboardMetric, CommunityLeaderboardWindow } from "./types.ts";

export interface CommunitySearch {
  metric: CommunityLeaderboardMetric;
  window?: CommunityLeaderboardWindow;
}

const metrics = new Set<CommunityLeaderboardMetric>(["calls", "tokens", "cost", "balance"]);
const windows = new Set<CommunityLeaderboardWindow>(["7d", "30d", "90d"]);

/** Canonical, bookmark-safe community filters. Balance is always a current snapshot. */
export function parseCommunitySearch(input: Record<string, unknown>): CommunitySearch {
  const metric = typeof input.metric === "string" &&
      metrics.has(input.metric as CommunityLeaderboardMetric)
    ? input.metric as CommunityLeaderboardMetric
    : "calls";
  if (metric === "balance") return { metric };
  const window = typeof input.window === "string" &&
      windows.has(input.window as CommunityLeaderboardWindow)
    ? input.window as CommunityLeaderboardWindow
    : "30d";
  return { metric, window };
}
