import { APIError, createAuthEndpoint, originCheck } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
  createAuthorizationURL,
  generateState,
  handleOAuthUserInfo,
  parseState,
} from "better-auth/oauth2";
import type { BetterAuthPlugin } from "better-auth";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import {
  defaultDnsResolver,
  type DnsResolver,
  resolveNetworkTarget,
  validateNetworkTarget,
} from "./network-policy.ts";

export interface OidcConfig {
  providerId: string;
  discoveryUrl: string;
  expectedIssuer: string;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  webOrigin: string;
  allowedAlgorithms: readonly string[];
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
  allowedEndpointOrigins?: readonly string[];
  fetch?: typeof fetch;
  resolveDns?: DnsResolver;
  pruneExpiredState?: () => Promise<void>;
}

const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  response_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
}).passthrough();

const userInfoSchema = z.object({
  sub: z.string().min(1).max(512),
  email: z.string().email().max(320),
  name: z.string().min(1).max(256).optional(),
  preferred_username: z.string().min(1).max(256).optional(),
  email_verified: z.unknown().optional(),
  picture: z.string().url().max(2048).optional(),
}).passthrough();

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8192),
  id_token: z.string().min(1).max(32768),
  token_type: z.string().max(64),
  expires_in: z.number().int().positive().max(86_400).optional(),
  scope: z.string().max(4096).optional(),
}).passthrough();

const jsonLimit = 256 * 1024;
export const fetchOidcJson = async (
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  addresses: readonly string[] = [],
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let dispatcher: Agent | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (addresses.length) {
      let cursor = 0;
      dispatcher = new Agent({
        connect: {
          lookup(_hostname, options, callback) {
            const records = addresses.map((address) => ({
              address,
              family: address.includes(":") ? 6 as const : 4 as const,
            }));
            if (options.all) callback(null, records);
            else {
              const record = records[cursor++ % records.length];
              callback(null, record.address, record.family);
            }
          },
        },
      });
      response = await undiciFetch(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        dispatcher,
      } as never) as unknown as Response;
    } else {
      response = await fetcher(url, { ...init, redirect: "error", signal: controller.signal });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OIDC endpoint returned ${response.status}`);
    }
    if (
      !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("OIDC endpoint returned a non-JSON response");
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error("OIDC endpoint returned an empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > jsonLimit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("OIDC response is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    if (!reader) await response?.body?.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader?.releaseLock();
    await dispatcher?.destroy().catch(() => undefined);
    clearTimeout(timer);
  }
};

const exactOriginUrl = (value: string, allowHttp: boolean): URL => {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("OIDC URL contains unsafe fields");
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("OIDC endpoints must use HTTPS");
  }
  return url;
};

const timingSafeEqual = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
};

const stableError = (webOrigin: string, code: string): never => {
  const target = new URL("/login", webOrigin);
  target.searchParams.set("error", code);
  throw new APIError("FOUND", { headers: { location: target.toString() } });
};

export function selectTokenClientAuthentication(methods?: readonly string[]): "basic" | "post" {
  const advertised = methods ?? ["client_secret_basic"];
  if (advertised.includes("client_secret_basic")) return "basic";
  if (advertised.includes("client_secret_post")) return "post";
  throw new Error("OIDC token endpoint does not support client-secret authentication");
}

export const oauthFormEncode = (value: string): string =>
  new URLSearchParams({ value }).toString().slice("value=".length);

export function authorizedPartyIsValid(
  audience: string | string[] | undefined,
  authorizedParty: unknown,
  clientId: string,
): boolean {
  if (authorizedParty !== undefined && authorizedParty !== clientId) return false;
  return !(Array.isArray(audience) && audience.length > 1 && authorizedParty !== clientId);
}

export function validateOidcConfig(config: OidcConfig): OidcConfig {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(config.providerId)) {
    throw new Error("OIDC provider ID is invalid");
  }
  if (!config.clientId || !config.clientSecret) {
    throw new Error("OIDC client credentials are required");
  }
  if (
    !/^[\x21-\x7e]{1,1024}$/.test(config.clientId) ||
    !/^[\x21-\x7e]{1,4096}$/.test(config.clientSecret)
  ) throw new Error("OIDC client credentials must be bounded ASCII values");
  exactOriginUrl(config.discoveryUrl, config.allowInsecureHttp === true);
  exactOriginUrl(config.expectedIssuer, config.allowInsecureHttp === true);
  if (
    !config.allowedAlgorithms.length ||
    config.allowedAlgorithms.some((value) =>
      !["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"].includes(value)
    )
  ) {
    throw new Error("OIDC algorithm allowlist is invalid");
  }
  return config;
}

export function oidcPlugin(rawConfig: OidcConfig): BetterAuthPlugin {
  const config = validateOidcConfig(rawConfig);
  const fetcher = config.fetch ?? fetch;
  const resolver = config.resolveDns ?? defaultDnsResolver;
  const allowedEndpointOrigins = new Set([
    new URL(config.discoveryUrl).origin,
    ...(config.allowedEndpointOrigins ?? []).map((value) =>
      exactOriginUrl(value, config.allowInsecureHttp === true).origin
    ),
  ]);
  const allowedEndpointUrls = [...allowedEndpointOrigins].map((origin) => new URL(origin));
  const networkPolicy = {
    allowedDomains: [...new Set(allowedEndpointUrls.map((url) => url.hostname))],
    allowedPorts: [
      ...new Set(
        allowedEndpointUrls.map((url) =>
          Number(url.port || (url.protocol === "https:" ? 443 : 80))
        ),
      ),
    ],
    allowPrivateNetwork: config.allowPrivateNetwork === true,
  };
  const secureFetchJson = async (url: string, init: RequestInit = {}) => {
    if (!allowedEndpointOrigins.has(new URL(url).origin)) {
      throw new Error("OIDC endpoint origin is not allowlisted");
    }
    if (fetcher !== fetch) {
      const validated = await validateNetworkTarget(url, networkPolicy, resolver);
      return await fetchOidcJson(validated.toString(), init, fetcher);
    }
    const resolved = await resolveNetworkTarget(url, networkPolicy, resolver);
    return await fetchOidcJson(resolved.url.toString(), init, fetcher, resolved.addresses);
  };
  const callbackURL = `${config.appUrl.replace(/\/$/, "")}/api/auth/oidc/callback`;
  let cachedDiscovery: { value: z.infer<typeof discoverySchema>; expiresAt: number } | undefined;
  const discover = async () => {
    if (cachedDiscovery && cachedDiscovery.expiresAt > Date.now()) return cachedDiscovery.value;
    const value = discoverySchema.parse(await secureFetchJson(config.discoveryUrl));
    if (value.issuer !== config.expectedIssuer) throw new Error("OIDC discovery issuer mismatch");
    for (
      const endpoint of [
        value.authorization_endpoint,
        value.token_endpoint,
        value.userinfo_endpoint,
        value.jwks_uri,
      ]
    ) {
      exactOriginUrl(endpoint, config.allowInsecureHttp === true);
    }
    for (const endpoint of [value.token_endpoint, value.userinfo_endpoint, value.jwks_uri]) {
      if (!allowedEndpointOrigins.has(new URL(endpoint).origin)) {
        throw new Error("OIDC server endpoint origin is not allowlisted");
      }
    }
    if (value.response_types_supported && !value.response_types_supported.includes("code")) {
      throw new Error("OIDC provider does not support authorization code flow");
    }
    if (
      value.code_challenge_methods_supported &&
      !value.code_challenge_methods_supported.includes("S256")
    ) {
      throw new Error("OIDC provider does not support PKCE S256");
    }
    cachedDiscovery = { value, expiresAt: Date.now() + 5 * 60_000 };
    return value;
  };

  return {
    id: "dg-chat-oidc",
    endpoints: {
      signInOidc: createAuthEndpoint("/sign-in/oidc", {
        method: "POST",
        body: z.object({}).strict(),
        use: [originCheck(() => config.webOrigin)],
      }, async (ctx) => {
        try {
          await config.pruneExpiredState?.();
          const discovery = await discover();
          const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
          const nonce = Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
          );
          const { state, codeVerifier } = await generateState(ctx, undefined, {
            nonce,
            oidcIssuer: config.expectedIssuer,
          });
          const url = await createAuthorizationURL({
            id: config.providerId,
            options: { clientId: config.clientId, clientSecret: config.clientSecret },
            authorizationEndpoint: discovery.authorization_endpoint,
            state,
            codeVerifier,
            scopes: ["openid", "profile", "email"],
            redirectURI: callbackURL,
            responseType: "code",
            responseMode: "query",
            additionalParams: { nonce },
          });
          return ctx.json({ url: url.toString(), redirect: true });
        } catch {
          throw APIError.from("BAD_REQUEST", {
            code: "OIDC_CONFIGURATION_ERROR",
            message: "SSO is temporarily unavailable",
          });
        }
      }),
      oidcCallback: createAuthEndpoint("/oidc/callback", {
        method: "GET",
        query: z.object({
          code: z.string().min(1).max(2048).optional(),
          state: z.string().min(1).max(4096).optional(),
          error: z.string().max(256).optional(),
        }).passthrough(),
      }, async (ctx) => {
        if (!ctx.query.state) return stableError(config.webOrigin, "oidc_state_invalid");
        let state: Awaited<ReturnType<typeof parseState>>;
        try {
          state = await parseState(ctx);
        } catch {
          return stableError(config.webOrigin, "oidc_state_invalid");
        }
        if (state.oidcIssuer !== config.expectedIssuer || typeof state.nonce !== "string") {
          return stableError(config.webOrigin, "oidc_state_invalid");
        }
        if (ctx.query.error || !ctx.query.code) {
          return stableError(
            config.webOrigin,
            ctx.query.error === "access_denied" ? "oidc_access_denied" : "oidc_code_invalid",
          );
        }
        try {
          const discovery = await discover();
          const tokenBody = new URLSearchParams({
            grant_type: "authorization_code",
            code: ctx.query.code,
            redirect_uri: callbackURL,
            client_id: config.clientId,
            code_verifier: state.codeVerifier,
          });
          const tokenAuthentication = selectTokenClientAuthentication(
            discovery.token_endpoint_auth_methods_supported,
          );
          const tokenHeaders: Record<string, string> = {
            "content-type": "application/x-www-form-urlencoded",
          };
          if (tokenAuthentication === "basic") {
            tokenHeaders.authorization = `Basic ${
              btoa(`${oauthFormEncode(config.clientId)}:${oauthFormEncode(config.clientSecret)}`)
            }`;
          } else {
            tokenBody.set("client_secret", config.clientSecret);
          }
          const tokens = tokenResponseSchema.parse(
            await secureFetchJson(discovery.token_endpoint, {
              method: "POST",
              headers: tokenHeaders,
              body: tokenBody,
            }),
          );
          const protectedHeader = decodeProtectedHeader(tokens.id_token);
          if (!protectedHeader.alg || !config.allowedAlgorithms.includes(protectedHeader.alg)) {
            return stableError(config.webOrigin, "oidc_id_token_invalid");
          }
          const jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(32) })
            .parse(
              await secureFetchJson(discovery.jwks_uri),
            );
          const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
            algorithms: [...config.allowedAlgorithms],
            issuer: config.expectedIssuer,
            audience: config.clientId,
            clockTolerance: 60,
            maxTokenAge: "10m",
          });
          const claims = verified.payload;
          if (!claims.sub || typeof claims.iat !== "number" || typeof claims.exp !== "number") {
            return stableError(config.webOrigin, "oidc_id_token_invalid");
          }
          if (!authorizedPartyIsValid(claims.aud, claims.azp, config.clientId)) {
            return stableError(config.webOrigin, "oidc_id_token_invalid");
          }
          if (typeof claims.nonce !== "string" || !timingSafeEqual(claims.nonce, state.nonce)) {
            return stableError(config.webOrigin, "oidc_nonce_invalid");
          }
          const profile = userInfoSchema.parse(
            await secureFetchJson(discovery.userinfo_endpoint, {
              headers: { authorization: `Bearer ${tokens.access_token}` },
            }),
          );
          if (profile.sub !== claims.sub) {
            return stableError(config.webOrigin, "oidc_profile_invalid");
          }
          const result = await handleOAuthUserInfo(ctx, {
            userInfo: {
              id: profile.sub,
              email: profile.email.toLowerCase(),
              emailVerified: profile.email_verified === true,
              name: profile.name ?? profile.preferred_username ?? profile.email,
              image: profile.picture,
            },
            account: { providerId: config.providerId, accountId: profile.sub },
            callbackURL: `${config.webOrigin}/pending`,
            trustProviderByName: false,
            isTrustedProvider: false,
          });
          if (result.error || !result.data) {
            return stableError(config.webOrigin, "oidc_account_not_linked");
          }
          await setSessionCookie(ctx, result.data);
          throw ctx.redirect(`${config.webOrigin}/pending`);
        } catch (error) {
          if (error instanceof APIError) throw error;
          return stableError(config.webOrigin, "oidc_code_invalid");
        }
      }),
    },
  };
}
