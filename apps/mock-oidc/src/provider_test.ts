import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.14";
import { createLocalJWKSet, jwtVerify } from "npm:jose@6.2.3";
import { createMockOidcProvider } from "./provider.ts";

const options = {
  publicIssuer: "http://localhost:4020",
  internalBaseUrl: "http://mock-oidc:4020",
  clientId: "dg-chat-e2e",
  clientSecret: "dg-chat-e2e-secret",
  redirectUri: "http://localhost:8000/api/auth/oidc/callback",
  controlToken: "control-secret",
};

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
}

async function authorize(
  provider: Awaited<ReturnType<typeof createMockOidcProvider>>,
  verifier: string,
  persona = "new_verified",
) {
  const challengeBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let binary = "";
  for (const byte of challengeBytes) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const url = new URL("http://mock/authorize");
  for (
    const [key, value] of Object.entries({
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state: "state-value",
      nonce: "nonce-value",
      code_challenge_method: "S256",
      code_challenge: challenge,
    })
  ) url.searchParams.set(key, value);
  const page = await provider.fetch(new Request(url));
  assertEquals(page.status, 200);
  const requestId = (await page.text()).match(/name="request_id" value="([^"]+)"/u)?.[1];
  assert(requestId);
  const form = new URLSearchParams({ request_id: requestId, persona });
  const decision = await provider.fetch(
    new Request("http://mock/authorize/decision", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }),
  );
  assertEquals(decision.status, 302);
  const callback = new URL(decision.headers.get("location")!);
  return { code: callback.searchParams.get("code")!, callback, challenge };
}

async function setMode(
  provider: Awaited<ReturnType<typeof createMockOidcProvider>>,
  mode: string,
) {
  const response = await provider.fetch(
    new Request("http://mock/control/mode", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode }),
    }),
  );
  assertEquals(response.status, 200);
}

async function exchange(
  provider: Awaited<ReturnType<typeof createMockOidcProvider>>,
  code: string,
  verifier: string,
) {
  return await provider.fetch(
    new Request("http://mock/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: verifier,
      }),
    }),
  );
}

Deno.test("discovery advertises browser and container endpoints without secrets", async () => {
  const provider = await createMockOidcProvider(options);
  const response = await provider.fetch(
    new Request("http://mock/.well-known/openid-configuration"),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    issuer: options.publicIssuer,
    authorization_endpoint: "http://localhost:4020/authorize",
    token_endpoint: "http://mock-oidc:4020/token",
    userinfo_endpoint: "http://mock-oidc:4020/userinfo",
    jwks_uri: "http://mock-oidc:4020/jwks",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    scopes_supported: ["openid", "profile", "email"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
});

Deno.test("authorization requires state, nonce, exact redirect, scopes, and S256 PKCE", async () => {
  const provider = await createMockOidcProvider(options);
  const response = await provider.fetch(
    new Request(
      `http://mock/authorize?client_id=${options.clientId}&redirect_uri=${
        encodeURIComponent(options.redirectUri)
      }&response_type=code`,
    ),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_request");
});

Deno.test("token exchange enforces PKCE, consumes codes, signs ID token, and serves UserInfo", async () => {
  const provider = await createMockOidcProvider(options);
  const verifier = "v".repeat(64);
  const first = await authorize(provider, verifier);
  assertEquals(first.callback.searchParams.get("state"), "state-value");
  assertEquals(first.callback.searchParams.get("iss"), options.publicIssuer);

  const wrong = await provider.fetch(
    new Request("http://mock/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: first.code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: "wrong-verifier",
      }),
    }),
  );
  assertEquals(wrong.status, 400);
  assertEquals((await wrong.json()).error, "invalid_grant");
  const replay = await provider.fetch(
    new Request("http://mock/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: first.code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: verifier,
      }),
    }),
  );
  assertEquals((await replay.json()).error, "invalid_grant");

  const second = await authorize(provider, verifier);
  const token = await provider.fetch(
    new Request("http://mock/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: second.code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: verifier,
      }),
    }),
  );
  assertEquals(token.status, 200);
  const tokens = await token.json();
  assertMatch(tokens.id_token, /^[^.]+\.[^.]+\.[^.]+$/u);
  assertEquals(decodeJwtPayload(tokens.id_token).nonce, "nonce-value");
  const jwks = await (await provider.fetch(new Request("http://mock/jwks"))).json();
  const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    issuer: options.publicIssuer,
    audience: options.clientId,
  });
  assertEquals(verified.payload.sub, "mock-sub-new-verified");
  const userinfo = await provider.fetch(
    new Request("http://mock/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }),
  );
  assertEquals(await userinfo.json(), {
    sub: "mock-sub-new-verified",
    email: "oidc-new@e2e.invalid",
    email_verified: true,
    name: "OIDC New Applicant",
  });
});

Deno.test("protected controls select negative modes and expose sanitized counters", async () => {
  const provider = await createMockOidcProvider(options);
  assertEquals(
    (await provider.fetch(new Request("http://mock/control/state"))).status,
    401,
  );
  const headers = {
    authorization: `Bearer ${options.controlToken}`,
    "content-type": "application/json",
  };
  const mode = await provider.fetch(
    new Request("http://mock/control/mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "wrong_nonce" }),
    }),
  );
  assertEquals(mode.status, 200);
  const verifier = "x".repeat(64);
  const authorization = await authorize(provider, verifier);
  const token = await provider.fetch(
    new Request("http://mock/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorization.code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: verifier,
      }),
    }),
  );
  assertEquals(decodeJwtPayload((await token.json()).id_token).nonce, "wrong-nonce");
  const state = await provider.fetch(
    new Request("http://mock/control/state", {
      headers: { authorization: `Bearer ${options.controlToken}` },
    }),
  );
  const value = await state.json();
  assertEquals(value.counters.tokenSuccess, 1);
  assertEquals(JSON.stringify(value).includes(options.clientSecret), false);
  const reset = await provider.fetch(
    new Request("http://mock/control/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${options.controlToken}` },
    }),
  );
  assertEquals(reset.status, 200);
});

Deno.test("negative modes deterministically alter only the requested protocol boundary", async () => {
  const claimCases = [
    ["wrong_issuer", "iss", `${options.publicIssuer}/wrong`],
    ["wrong_audience", "aud", "wrong-client"],
    ["wrong_nonce", "nonce", "wrong-nonce"],
  ] as const;
  for (const [mode, claim, expected] of claimCases) {
    const provider = await createMockOidcProvider(options);
    await setMode(provider, mode);
    const verifier = `${mode}-`.padEnd(64, "v");
    const authorization = await authorize(provider, verifier);
    const response = await exchange(provider, authorization.code, verifier);
    assertEquals(response.status, 200);
    assertEquals(decodeJwtPayload((await response.json()).id_token)[claim], expected);
  }

  for (const mode of ["expired_id_token", "future_iat"] as const) {
    const provider = await createMockOidcProvider(options);
    await setMode(provider, mode);
    const verifier = `${mode}-`.padEnd(64, "v");
    const authorization = await authorize(provider, verifier);
    const response = await exchange(provider, authorization.code, verifier);
    const payload = decodeJwtPayload((await response.json()).id_token);
    const now = Math.floor(Date.now() / 1000);
    if (mode === "expired_id_token") assert(Number(payload.exp) < now);
    else assert(Number(payload.iat) > now);
  }

  for (const mode of ["invalid_signature", "disallowed_algorithm"] as const) {
    const provider = await createMockOidcProvider(options);
    await setMode(provider, mode);
    const verifier = `${mode}-`.padEnd(64, "v");
    const authorization = await authorize(provider, verifier);
    const response = await exchange(provider, authorization.code, verifier);
    const token = (await response.json()).id_token as string;
    const header = decodeJwtPayload(`${token.split(".")[0]}.${token.split(".")[0]}.x`);
    if (mode === "disallowed_algorithm") assertEquals(header.alg, "none");
    else assertEquals(header.kid, "mock-invalid");
  }

  const failingProvider = await createMockOidcProvider(options);
  await setMode(failingProvider, "token_http_500");
  const verifier = "token-failure".padEnd(64, "v");
  const authorization = await authorize(failingProvider, verifier);
  assertEquals((await exchange(failingProvider, authorization.code, verifier)).status, 500);

  const mismatchProvider = await createMockOidcProvider(options);
  await setMode(mismatchProvider, "userinfo_subject_mismatch");
  const mismatchVerifier = "userinfo-mismatch".padEnd(64, "v");
  const mismatchAuthorization = await authorize(mismatchProvider, mismatchVerifier);
  const tokens = await (await exchange(
    mismatchProvider,
    mismatchAuthorization.code,
    mismatchVerifier,
  )).json();
  const userinfo = await mismatchProvider.fetch(
    new Request("http://mock/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }),
  );
  assertEquals((await userinfo.json()).sub, "mock-sub-mismatch");

  const userinfoFailureProvider = await createMockOidcProvider(options);
  await setMode(userinfoFailureProvider, "userinfo_http_500");
  const userinfoFailureVerifier = "userinfo-failure".padEnd(64, "v");
  const userinfoFailureAuthorization = await authorize(
    userinfoFailureProvider,
    userinfoFailureVerifier,
  );
  const userinfoFailureTokens = await (await exchange(
    userinfoFailureProvider,
    userinfoFailureAuthorization.code,
    userinfoFailureVerifier,
  )).json();
  assertEquals(
    (await userinfoFailureProvider.fetch(
      new Request("http://mock/userinfo", {
        headers: { authorization: `Bearer ${userinfoFailureTokens.access_token}` },
      }),
    )).status,
    500,
  );

  const denialProvider = await createMockOidcProvider(options);
  await setMode(denialProvider, "authorization_error");
  const denied = await authorize(denialProvider, "authorization-error".padEnd(64, "v"));
  assertEquals(denied.callback.searchParams.get("error"), "access_denied");
  assertEquals(denied.callback.searchParams.has("code"), false);
});
