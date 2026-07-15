export const adminUserTabs = ["account", "sessions", "tokens", "billing"] as const;
export type AdminUserTab = (typeof adminUserTabs)[number];
export const ADMIN_USER_RETURN_STORAGE_KEY = "dg-chat.admin-user-return-path";
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const adminUserTabLabels: Readonly<Record<AdminUserTab, string>> = {
  account: "Account",
  sessions: "Sessions",
  tokens: "API tokens",
  billing: "Billing",
};

export function isAdminUserTab(value: unknown): value is AdminUserTab {
  return typeof value === "string" && (adminUserTabs as readonly string[]).includes(value);
}

export function parseAdminUserTab(
  value: unknown,
  fallback: AdminUserTab = "account",
): AdminUserTab {
  return isAdminUserTab(value) ? value : fallback;
}

export function isAdminUserRouteId(value: unknown): value is string {
  return typeof value === "string" && canonicalUuid.test(value);
}

export function adminUserDetailPath(userId: string, tab: AdminUserTab = "account"): string {
  if (!isAdminUserRouteId(userId) || !isAdminUserTab(tab)) {
    throw new TypeError("Invalid administrator user detail route.");
  }
  return `/admin/users/${encodeURIComponent(userId)}/${tab}`;
}

export function storeAdminUserReturnPath(path: string): void {
  try {
    const url = new URL(path, "http://dg-chat.local");
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.origin !== "http://dg-chat.local" || parts.length !== 4 || parts[0] !== "admin" ||
      parts[1] !== "users" || !isAdminUserRouteId(decodeURIComponent(parts[2])) ||
      !isAdminUserTab(parts[3])
    ) throw new TypeError("Invalid administrator return path.");
    sessionStorage.setItem(ADMIN_USER_RETURN_STORAGE_KEY, `${url.pathname}${url.search}`);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Invalid administrator return path.");
  }
}

export function consumeAdminUserReturnPath(): string | null {
  try {
    const path = sessionStorage.getItem(ADMIN_USER_RETURN_STORAGE_KEY);
    sessionStorage.removeItem(ADMIN_USER_RETURN_STORAGE_KEY);
    if (!path) return null;
    const url = new URL(path, "http://dg-chat.local");
    const parts = url.pathname.split("/").filter(Boolean);
    return url.origin === "http://dg-chat.local" && parts.length === 4 &&
        parts[0] === "admin" && parts[1] === "users" &&
        isAdminUserRouteId(decodeURIComponent(parts[2])) && isAdminUserTab(parts[3])
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}

/** Uses a validated one-time admin route only after authentication reaches a full workspace. */
export function authenticatedAdminDestination(destination: "/" | "/pending"): string {
  return destination === "/" ? consumeAdminUserReturnPath() ?? destination : destination;
}

export function parseAdminUserDetailParams(
  params: Readonly<{ userId?: unknown; tab?: unknown }>,
): { userId: string; tab: AdminUserTab } | null {
  if (!isAdminUserRouteId(params.userId) || !isAdminUserTab(params.tab)) return null;
  return { userId: params.userId, tab: params.tab };
}

export function adminUserTabId(userId: string, tab: AdminUserTab): string {
  return `admin-user-${encodeURIComponent(userId)}-${tab}-tab`;
}

export function adminUserTabPanelId(userId: string, tab: AdminUserTab): string {
  return `admin-user-${encodeURIComponent(userId)}-${tab}-panel`;
}

export type AdminUserTabNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** Returns null for unhandled keys so callers do not suppress normal browser behavior. */
export function adminUserTabForKey(
  current: AdminUserTab,
  key: string,
  direction: "ltr" | "rtl" = "ltr",
): AdminUserTab | null {
  if (key === "Home") return adminUserTabs[0];
  if (key === "End") return adminUserTabs.at(-1)!;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;

  const currentIndex = adminUserTabs.indexOf(current);
  const forward = direction === "ltr" ? key === "ArrowRight" : key === "ArrowLeft";
  const offset = forward ? 1 : -1;
  return adminUserTabs[(currentIndex + offset + adminUserTabs.length) % adminUserTabs.length];
}

/** Resolves from the focused tab, not a potentially lagging URL selection during rapid presses. */
export function adminUserTabForTargetKey(
  target: unknown,
  selected: AdminUserTab,
  key: string,
  direction: "ltr" | "rtl" = "ltr",
): AdminUserTab | null {
  return adminUserTabForKey(isAdminUserTab(target) ? target : selected, key, direction);
}
