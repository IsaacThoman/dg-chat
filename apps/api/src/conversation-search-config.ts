import { CONVERSATION_SEARCH_STATEMENT_TIMEOUT_MS } from "@dg-chat/database";

export const DEFAULT_CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS = 15;
export const MAX_CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS = 60;

/**
 * Parse the distributed search-admission lease.
 *
 * A lease must outlive the database statement deadline so a healthy search cannot lose its
 * capacity fence before PostgreSQL has had a chance to cancel the query. The upper bound limits
 * how long a crashed replica can strand capacity even if Redis renewal never runs again.
 */
export function conversationSearchConcurrencyLeaseMs(raw?: string): number {
  const value = raw ?? String(DEFAULT_CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS);
  if (!/^\d+$/.test(value)) {
    throw new Error(
      "CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS must be an integer number of seconds",
    );
  }
  const seconds = Number(value);
  const minimumExclusiveSeconds = CONVERSATION_SEARCH_STATEMENT_TIMEOUT_MS / 1_000;
  if (
    !Number.isSafeInteger(seconds) || seconds <= minimumExclusiveSeconds ||
    seconds > MAX_CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS
  ) {
    throw new Error(
      `CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS must be greater than ${minimumExclusiveSeconds} and at most ${MAX_CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS}`,
    );
  }
  return seconds * 1_000;
}
