type QueryFilterValue = string | number | boolean | null | readonly (string | number | boolean)[];
export type AdminUserQueryFilters = Readonly<Record<string, QueryFilterValue | undefined>>;

function stableFilters<T extends object>(filters: T): Readonly<Record<string, QueryFilterValue>> {
  const entries = Object.entries(filters as Record<string, QueryFilterValue | undefined>)
    .filter((entry): entry is [string, QueryFilterValue] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) =>
      [key, Array.isArray(value) ? Object.freeze([...value]) : value] as const
    );
  return Object.freeze(Object.fromEntries(entries));
}

const root = ["admin-users"] as const;

/** Query-key factory for all administrator-owned user security and billing data. */
export const adminUserKeys = {
  all: root,
  directories: () => [...root, "directory"] as const,
  directory: <T extends object>(filters: T, cursor: string | null = null) =>
    [...root, "directory", stableFilters(filters), cursor] as const,
  details: () => [...root, "detail"] as const,
  detail: (userId: string) => [...root, "detail", userId] as const,
  sessions: <T extends object>(userId: string, filters: T) =>
    [...root, "detail", userId, "sessions", stableFilters(filters)] as const,
  tokens: <T extends object>(userId: string, filters: T, cursor: string | null = null) =>
    [...root, "detail", userId, "tokens", stableFilters(filters), cursor] as const,
  ledger: <T extends object>(userId: string, filters: T, cursor: string | null = null) =>
    [...root, "detail", userId, "ledger", stableFilters(filters), cursor] as const,
};
