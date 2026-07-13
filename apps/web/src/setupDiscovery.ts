export interface SetupStatus {
  bootstrapRequired: boolean;
  setupEnabled: boolean;
  oidcEnabled: boolean;
  emailEnabled: boolean;
  requireEmailVerification: boolean;
}

export function setupDestination(
  currentPath: "/" | "/login" | "/setup",
  status: SetupStatus | undefined,
  authenticationFailed = false,
): "/setup" | "/login" | null {
  if (!status) return null;
  if (status.bootstrapRequired) return currentPath === "/setup" ? null : "/setup";
  if (currentPath === "/setup") return "/login";
  if (currentPath === "/" && authenticationFailed) return "/login";
  return null;
}
