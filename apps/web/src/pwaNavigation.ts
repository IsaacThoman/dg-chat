// Navigations to these server-owned endpoints must never receive the cached SPA shell. This is
// especially important for browser redirects such as the OIDC callback after the service worker
// has activated in an installed PWA.
export const pwaNavigationDenylist = [
  // Workbox matches navigation route expressions against `pathname + search`. A query on the
  // bare endpoint therefore needs its own boundary: `$` alone would not match `/api?probe=1`.
  /^\/(?:api|v1)(?:\/|\?|$)/u,
  /^\/(?:health|ready|metrics)(?:\/|\?|$)/u,
  // Browsers retain percent escapes in URL.pathname while nginx canonicalizes them before
  // selecting a location. Conservatively keep every encoded pathname on the network so an
  // encoded server route such as /%61pi can never receive the cached product shell. The query
  // portion is excluded so an ordinary encoded search parameter does not disable offline chat.
  /^\/[^?]*%[0-9a-f]{2}/iu,
];
