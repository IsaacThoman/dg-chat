import { createMockOidcProvider } from "./provider.ts";

const port = Number(Deno.env.get("MOCK_OIDC_PORT") ?? "4020");
const provider = await createMockOidcProvider({
  publicIssuer: Deno.env.get("MOCK_OIDC_PUBLIC_ISSUER") ?? `http://localhost:${port}`,
  internalBaseUrl: Deno.env.get("MOCK_OIDC_INTERNAL_BASE_URL") ??
    `http://mock-oidc:${port}`,
  clientId: Deno.env.get("MOCK_OIDC_CLIENT_ID") ?? "dg-chat-e2e",
  clientSecret: Deno.env.get("MOCK_OIDC_CLIENT_SECRET") ?? "dg-chat-e2e-secret",
  redirectUri: Deno.env.get("MOCK_OIDC_REDIRECT_URI") ??
    "http://localhost:8000/api/auth/oidc/callback",
  controlToken: Deno.env.get("MOCK_OIDC_CONTROL_TOKEN") ?? "mock-oidc-control-token",
});

console.log(JSON.stringify({ level: "info", message: "Mock OIDC provider listening", port }));
Deno.serve({ port, onListen: () => {} }, provider.fetch);
