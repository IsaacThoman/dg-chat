// Navigations to these server-owned endpoints must never receive the cached SPA shell. This is
// especially important for browser redirects such as the OIDC callback after the service worker
// has activated in an installed PWA.
export const pwaNavigationDenylist = [
  /^\/(?:api|v1)\//u,
  /^\/(?:health|ready|metrics)$/u,
];
