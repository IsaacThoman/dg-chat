export const adminSections = [
  "overview",
  "applicants",
  "users",
  "providers",
  "models",
  "resilience",
  "tools",
  "usage",
  "jobs",
  "audit",
  "retention",
  "storage",
] as const;

export type AdminSection = (typeof adminSections)[number];

export const isAdminSection = (value: string): value is AdminSection =>
  (adminSections as readonly string[]).includes(value);

export interface AdminSearch {
  from?: string;
  to?: string;
  bucket?: "hour" | "day";
  status?: string;
  userId?: string;
  model?: string;
  provider?: string;
  type?: string;
  cursor?: string;
  run?: string;
  userSearch?: string;
  userRole?: "user" | "admin";
  userState?: "active" | "suspended";
  userDeletion?: "present" | "deleted" | "all";
}

const bounded = (value: unknown, length: number) =>
  typeof value === "string" && value.length <= length && value ? value : undefined;

const dateOnly = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
};

export function parseAdminSearch(value: Record<string, unknown>): AdminSearch {
  const bucket = value.bucket === "hour" || value.bucket === "day" ? value.bucket : undefined;
  const userRole = value.userRole === "user" || value.userRole === "admin"
    ? value.userRole
    : undefined;
  const userState = value.userState === "active" || value.userState === "suspended"
    ? value.userState
    : undefined;
  const userDeletion = ["present", "deleted", "all"].includes(String(value.userDeletion))
    ? value.userDeletion as AdminSearch["userDeletion"]
    : undefined;
  return {
    from: dateOnly(value.from),
    to: dateOnly(value.to),
    bucket,
    status: bounded(value.status, 24),
    userId: bounded(value.userId, 36),
    model: bounded(value.model, 160),
    provider: bounded(value.provider, 160),
    type: bounded(value.type, 120),
    cursor: bounded(value.cursor, 2048),
    run: bounded(value.run, 100),
    userSearch: bounded(value.userSearch, 200),
    userRole,
    userState,
    userDeletion,
  };
}
