import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  authorizedPartyIsValid,
  fetchOidcJson,
  oauthFormEncode,
  selectTokenClientAuthentication,
  validateOidcConfig,
} from "./oidc.ts";

const valid = {
  providerId: "organization",
  discoveryUrl: "https://idp.example/.well-known/openid-configuration",
  expectedIssuer: "https://idp.example",
  clientId: "dg-chat",
  clientSecret: "not-a-real-secret",
  appUrl: "https://chat.example",
  webOrigin: "https://chat.example",
  allowedAlgorithms: ["RS256"] as const,
};

Deno.test("OIDC configuration pins safe endpoints and an asymmetric algorithm", () => {
  assertEquals(validateOidcConfig(valid), valid);
  assertThrows(() => validateOidcConfig({ ...valid, discoveryUrl: "http://idp.example/openid" }));
  assertThrows(() => validateOidcConfig({ ...valid, expectedIssuer: "http://idp.example" }));
  assertThrows(() => validateOidcConfig({ ...valid, providerId: "Organization SSO" }));
  assertThrows(() => validateOidcConfig({ ...valid, allowedAlgorithms: ["none"] }));
  assertThrows(() => validateOidcConfig({ ...valid, allowedAlgorithms: ["HS256"] }));
});

Deno.test("insecure HTTP OIDC is an explicit test/private deployment opt-in", () => {
  const configured = {
    ...valid,
    discoveryUrl: "http://mock-oidc:4020/.well-known/openid-configuration",
    expectedIssuer: "http://localhost:4020",
    allowInsecureHttp: true,
  };
  assertEquals(validateOidcConfig(configured), configured);
});

Deno.test("OIDC token authentication prefers basic and defaults to it", () => {
  assertEquals(selectTokenClientAuthentication(), "basic");
  assertEquals(selectTokenClientAuthentication(["client_secret_basic"]), "basic");
  assertEquals(
    selectTokenClientAuthentication(["client_secret_post", "client_secret_basic"]),
    "basic",
  );
  assertEquals(selectTokenClientAuthentication(["client_secret_post"]), "post");
  assertThrows(() => selectTokenClientAuthentication(["private_key_jwt"]));
  assertEquals(oauthFormEncode("client+id%:value"), "client%2Bid%25%3Avalue");
  assertEquals(oauthFormEncode("secret+value%:tail"), "secret%2Bvalue%25%3Atail");
});

Deno.test("OIDC authorized-party validation rejects every mismatched azp shape", () => {
  assertEquals(authorizedPartyIsValid("client", undefined, "client"), true);
  assertEquals(authorizedPartyIsValid("client", "other", "client"), false);
  assertEquals(authorizedPartyIsValid(["client"], "other", "client"), false);
  assertEquals(authorizedPartyIsValid(["client", "api"], undefined, "client"), false);
  assertEquals(authorizedPartyIsValid(["client", "api"], "client", "client"), true);
  assertEquals(authorizedPartyIsValid(["client", "api"], "other", "client"), false);
});

Deno.test("OIDC JSON fetch cancels rejected and oversized response bodies", async () => {
  for (
    const response of [
      { status: 500, contentType: "application/json" },
      { status: 200, contentType: "text/plain" },
    ]
  ) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assertRejects(() =>
      fetchOidcJson("https://idp.example/endpoint", {}, () =>
        Promise.resolve(
          new Response(stream, {
            status: response.status,
            headers: { "content-type": response.contentType },
          }),
        ))
    );
    assertEquals(cancelled, true);
  }

  let oversizedCancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(300_000));
    },
    cancel() {
      oversizedCancelled = true;
    },
  });
  await assertRejects(() =>
    fetchOidcJson(
      "https://idp.example/endpoint",
      {},
      () =>
        Promise.resolve(
          new Response(oversized, {
            headers: { "content-type": "application/json" },
          }),
        ),
    )
  );
  assertEquals(oversizedCancelled, true);
});
