const encoder = new TextEncoder();

export const MOCK_OIDC_PERSONAS = {
  new_verified: {
    sub: "mock-sub-new-verified",
    email: "oidc-new@e2e.invalid",
    email_verified: true,
    name: "OIDC New Applicant",
  },
  new_verified_desktop_0: {
    sub: "mock-sub-new-verified-desktop-0",
    email: "oidc-new-desktop-0@e2e.invalid",
    email_verified: true,
    name: "OIDC Desktop Applicant 0",
  },
  new_verified_desktop_1: {
    sub: "mock-sub-new-verified-desktop-1",
    email: "oidc-new-desktop-1@e2e.invalid",
    email_verified: true,
    name: "OIDC Desktop Applicant 1",
  },
  new_verified_desktop_2: {
    sub: "mock-sub-new-verified-desktop-2",
    email: "oidc-new-desktop-2@e2e.invalid",
    email_verified: true,
    name: "OIDC Desktop Applicant 2",
  },
  new_verified_mobile_0: {
    sub: "mock-sub-new-verified-mobile-0",
    email: "oidc-new-mobile-0@e2e.invalid",
    email_verified: true,
    name: "OIDC Mobile Applicant 0",
  },
  new_verified_mobile_1: {
    sub: "mock-sub-new-verified-mobile-1",
    email: "oidc-new-mobile-1@e2e.invalid",
    email_verified: true,
    name: "OIDC Mobile Applicant 1",
  },
  new_verified_mobile_2: {
    sub: "mock-sub-new-verified-mobile-2",
    email: "oidc-new-mobile-2@e2e.invalid",
    email_verified: true,
    name: "OIDC Mobile Applicant 2",
  },
  new_unverified: {
    sub: "mock-sub-new-unverified",
    email: "oidc-unverified@e2e.invalid",
    email_verified: false,
    name: "OIDC Unverified Applicant",
  },
  approved: {
    sub: "mock-sub-approved",
    email: "oidc-approved@e2e.invalid",
    email_verified: true,
    name: "OIDC Approved User",
  },
  existing_email: {
    sub: "mock-sub-existing-email",
    email: "admin@e2e.invalid",
    email_verified: true,
    name: "Existing Local Email",
  },
  colliding_subject: {
    sub: "mock-sub-collision-b",
    email: "oidc-approved@e2e.invalid",
    email_verified: true,
    name: "Different Subject Same Email",
  },
  missing_email: {
    sub: "mock-sub-missing-email",
    email_verified: true,
    name: "Missing Email",
  },
  missing_sub: {
    email: "missing-sub@e2e.invalid",
    email_verified: true,
    name: "Missing Subject",
  },
  missing_name: {
    sub: "mock-sub-missing-name",
    email: "missing-name@e2e.invalid",
    email_verified: true,
  },
} as const;

export type MockOidcPersona = keyof typeof MOCK_OIDC_PERSONAS;
export type MockOidcMode =
  | "normal"
  | "authorization_error"
  | "token_http_500"
  | "userinfo_http_500"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_nonce"
  | "expired_id_token"
  | "future_iat"
  | "invalid_signature"
  | "disallowed_algorithm"
  | "userinfo_subject_mismatch";

export interface MockOidcProviderOptions {
  publicIssuer: string;
  internalBaseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  controlToken: string;
  now?: () => number;
}

interface AuthorizationTransaction {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope: string;
  createdAt: number;
}

interface AuthorizationCode extends AuthorizationTransaction {
  persona: MockOidcPersona;
  mode: MockOidcMode;
  expiresAt: number;
}

interface AccessGrant {
  persona: MockOidcPersona;
  mode: MockOidcMode;
  expiresAt: number;
}

interface Counters {
  discovery: number;
  authorize: number;
  decisions: number;
  token: number;
  tokenSuccess: number;
  userinfo: number;
  jwks: number;
}

const modes = new Set<MockOidcMode>([
  "normal",
  "authorization_error",
  "token_http_500",
  "userinfo_http_500",
  "wrong_issuer",
  "wrong_audience",
  "wrong_nonce",
  "expired_id_token",
  "future_iat",
  "invalid_signature",
  "disallowed_algorithm",
  "userinfo_subject_mismatch",
]);

const personas = new Set<MockOidcPersona>(
  Object.keys(MOCK_OIDC_PERSONAS) as MockOidcPersona[],
);

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

function randomValue(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status, {
    "cache-control": "no-store",
    pragma: "no-cache",
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function controlAuthorized(request: Request, token: string): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

async function generateSigningKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...publicJwk, use: "sig", alg: "ES256", kid },
  };
}

async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = encodeJson({ alg: "ES256", typ: "JWT", kid });
  const body = encodeJson(payload);
  const signingInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function unsecuredJwt(payload: Record<string, unknown>): string {
  return `${encodeJson({ alg: "none", typ: "JWT" })}.${encodeJson(payload)}.`;
}

function requiredAuthorizationParams(url: URL, options: MockOidcProviderOptions): string | null {
  if (url.searchParams.get("client_id") !== options.clientId) return "Unknown client_id";
  if (url.searchParams.get("redirect_uri") !== options.redirectUri) return "Invalid redirect_uri";
  if (url.searchParams.get("response_type") !== "code") return "response_type must be code";
  if (!url.searchParams.get("state")) return "state is required";
  if (!url.searchParams.get("nonce")) return "nonce is required";
  if (url.searchParams.get("code_challenge_method") !== "S256") {
    return "code_challenge_method must be S256";
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(url.searchParams.get("code_challenge") ?? "")) {
    return "A valid code_challenge is required";
  }
  const scopes = new Set((url.searchParams.get("scope") ?? "").split(/\s+/u));
  for (const required of ["openid", "profile", "email"]) {
    if (!scopes.has(required)) return `scope ${required} is required`;
  }
  return null;
}

export async function createMockOidcProvider(options: MockOidcProviderOptions) {
  const now = options.now ?? Date.now;
  const primary = await generateSigningKey("mock-primary");
  const invalid = await generateSigningKey("mock-invalid");
  const pending = new Map<string, AuthorizationTransaction>();
  const codes = new Map<string, AuthorizationCode>();
  const grants = new Map<string, AccessGrant>();
  let mode: MockOidcMode = "normal";
  let counters: Counters = {
    discovery: 0,
    authorize: 0,
    decisions: 0,
    token: 0,
    tokenSuccess: 0,
    userinfo: 0,
    jwks: 0,
  };
  const recent: Array<Record<string, unknown>> = [];
  const observe = (event: Record<string, unknown>) => {
    recent.push({ at: new Date(now()).toISOString(), ...event });
    if (recent.length > 50) recent.shift();
  };

  const reset = () => {
    pending.clear();
    codes.clear();
    grants.clear();
    mode = "normal";
    counters = {
      discovery: 0,
      authorize: 0,
      decisions: 0,
      token: 0,
      tokenSuccess: 0,
      userinfo: 0,
      jwks: 0,
    };
    recent.length = 0;
  };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      counters.discovery++;
      return json(
        {
          issuer: options.publicIssuer,
          authorization_endpoint: `${options.publicIssuer}/authorize`,
          token_endpoint: `${options.internalBaseUrl}/token`,
          userinfo_endpoint: `${options.internalBaseUrl}/userinfo`,
          jwks_uri: `${options.internalBaseUrl}/jwks`,
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          grant_types_supported: ["authorization_code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          scopes_supported: ["openid", "profile", "email"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        },
        200,
        { "cache-control": "no-store" },
      );
    }
    if (request.method === "GET" && url.pathname === "/jwks") {
      counters.jwks++;
      return json({ keys: [primary.publicJwk] }, 200, { "cache-control": "no-store" });
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      counters.authorize++;
      const problem = requiredAuthorizationParams(url, options);
      if (problem) return oauthError("invalid_request", problem);
      const requestId = randomValue();
      pending.set(requestId, {
        clientId: url.searchParams.get("client_id")!,
        redirectUri: url.searchParams.get("redirect_uri")!,
        state: url.searchParams.get("state")!,
        nonce: url.searchParams.get("nonce")!,
        codeChallenge: url.searchParams.get("code_challenge")!,
        scope: url.searchParams.get("scope")!,
        createdAt: now(),
      });
      observe({ type: "authorize", noncePresent: true, pkce: "S256" });
      const buttons = Object.entries(MOCK_OIDC_PERSONAS).map(([id, persona]) =>
        `<button name="persona" value="${escapeHtml(id)}" type="submit">${
          escapeHtml("name" in persona ? persona.name : id.replaceAll("_", " "))
        }</button>`
      ).join("\n");
      return new Response(
        `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Mock organization sign in</title><style>
body{font:16px system-ui;max-width:38rem;margin:4rem auto;padding:1rem;background:#101114;color:#f5f5f5}
main{background:#1b1d22;border:1px solid #343741;border-radius:16px;padding:24px}button{display:block;width:100%;margin:10px 0;padding:12px;border:0;border-radius:9px;background:#fff;color:#111;font-weight:650;cursor:pointer}.deny{background:#382329;color:#ffd8df}</style></head>
<body><main><h1>Mock organization</h1><p>Select a deterministic test identity.</p>
<form method="post" action="/authorize/decision"><input type="hidden" name="request_id" value="${requestId}">${buttons}
<button class="deny" name="decision" value="deny" type="submit">Deny access</button></form></main></body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
            "x-frame-options": "DENY",
          },
        },
      );
    }
    if (request.method === "POST" && url.pathname === "/authorize/decision") {
      counters.decisions++;
      const form = await request.formData();
      const requestId = String(form.get("request_id") ?? "");
      const transaction = pending.get(requestId);
      pending.delete(requestId);
      if (!transaction || now() - transaction.createdAt > 5 * 60_000) {
        return oauthError("invalid_request", "Authorization transaction is invalid or expired");
      }
      const redirect = new URL(transaction.redirectUri);
      redirect.searchParams.set("state", transaction.state);
      redirect.searchParams.set("iss", options.publicIssuer);
      const selected = String(form.get("persona") ?? "");
      if (form.get("decision") === "deny" || mode === "authorization_error") {
        redirect.searchParams.set("error", "access_denied");
        redirect.searchParams.set("error_description", "The mock user denied access");
        observe({ type: "decision", result: "denied", mode });
        return Response.redirect(redirect, 302);
      }
      if (!personas.has(selected as MockOidcPersona)) {
        return oauthError("invalid_request", "Unknown mock persona");
      }
      const code = randomValue(32);
      codes.set(code, {
        ...transaction,
        persona: selected as MockOidcPersona,
        mode,
        expiresAt: now() + 60_000,
      });
      redirect.searchParams.set("code", code);
      observe({ type: "decision", result: "approved", persona: selected, mode });
      return Response.redirect(redirect, 302);
    }
    if (request.method === "POST" && url.pathname === "/token") {
      counters.token++;
      if (
        request.headers.get("content-type")?.split(";", 1)[0] !==
          "application/x-www-form-urlencoded"
      ) {
        return oauthError("invalid_request", "Token request must be form encoded");
      }
      const form = new URLSearchParams(await request.text());
      const codeValue = form.get("code") ?? "";
      const grant = codes.get(codeValue);
      codes.delete(codeValue);
      if (!grant || grant.expiresAt <= now()) return oauthError("invalid_grant", "Invalid code");
      if (grant.mode === "token_http_500") {
        return oauthError("server_error", "Injected failure", 500);
      }
      if (
        form.get("grant_type") !== "authorization_code" ||
        form.get("client_id") !== options.clientId ||
        form.get("client_secret") !== options.clientSecret ||
        form.get("redirect_uri") !== grant.redirectUri
      ) {
        return oauthError("invalid_grant", "Authorization code binding failed");
      }
      const verifier = form.get("code_verifier") ?? "";
      if (!verifier || await sha256(verifier) !== grant.codeChallenge) {
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      const seconds = Math.floor(now() / 1000);
      const profile = MOCK_OIDC_PERSONAS[grant.persona] as Record<string, unknown>;
      const payload: Record<string, unknown> = {
        iss: grant.mode === "wrong_issuer" ? `${options.publicIssuer}/wrong` : options.publicIssuer,
        aud: grant.mode === "wrong_audience" ? "wrong-client" : options.clientId,
        ...profile,
        nonce: grant.mode === "wrong_nonce" ? "wrong-nonce" : grant.nonce,
        iat: grant.mode === "future_iat" ? seconds + 600 : seconds,
        exp: grant.mode === "expired_id_token" ? seconds - 60 : seconds + 300,
      };
      let idToken: string;
      if (grant.mode === "disallowed_algorithm") idToken = unsecuredJwt(payload);
      else {
        const key = grant.mode === "invalid_signature" ? invalid : primary;
        idToken = await signJwt(
          key.privateKey,
          key === invalid ? "mock-invalid" : "mock-primary",
          payload,
        );
      }
      const accessToken = `mock-at-${randomValue(24)}`;
      grants.set(accessToken, {
        persona: grant.persona,
        mode: grant.mode,
        expiresAt: now() + 5 * 60_000,
      });
      counters.tokenSuccess++;
      observe({ type: "token", result: "success", persona: grant.persona, mode: grant.mode });
      return json(
        {
          token_type: "Bearer",
          access_token: accessToken,
          expires_in: 300,
          scope: grant.scope,
          id_token: idToken,
        },
        200,
        { "cache-control": "no-store", pragma: "no-cache" },
      );
    }
    if (request.method === "GET" && url.pathname === "/userinfo") {
      counters.userinfo++;
      const authorization = request.headers.get("authorization") ?? "";
      const accessToken = authorization.match(/^Bearer (.+)$/u)?.[1];
      const grant = accessToken ? grants.get(accessToken) : undefined;
      if (!grant || grant.expiresAt <= now()) {
        return oauthError("invalid_token", "Invalid token", 401);
      }
      if (grant.mode === "userinfo_http_500") {
        return oauthError("server_error", "Injected failure", 500);
      }
      const profile = { ...MOCK_OIDC_PERSONAS[grant.persona] } as Record<string, unknown>;
      if (grant.mode === "userinfo_subject_mismatch") profile.sub = "mock-sub-mismatch";
      observe({ type: "userinfo", persona: grant.persona, mode: grant.mode });
      return json(profile, 200, { "cache-control": "no-store" });
    }
    if (url.pathname.startsWith("/control/")) {
      if (!controlAuthorized(request, options.controlToken)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (request.method === "POST" && url.pathname === "/control/reset") {
        reset();
        return json({ status: "reset" });
      }
      if (request.method === "POST" && url.pathname === "/control/mode") {
        const value = await request.json().catch(() => null) as { mode?: unknown } | null;
        if (!value || typeof value.mode !== "string" || !modes.has(value.mode as MockOidcMode)) {
          return json({ error: "invalid_mode" }, 422);
        }
        mode = value.mode as MockOidcMode;
        return json({ mode });
      }
      if (request.method === "GET" && url.pathname === "/control/state") {
        return json({
          mode,
          counters,
          pending: pending.size,
          codes: codes.size,
          grants: grants.size,
          recent,
        });
      }
    }
    return json({ error: "not_found" }, 404);
  };

  return { fetch, reset };
}
