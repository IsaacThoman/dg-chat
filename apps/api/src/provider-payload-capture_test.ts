import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import {
  providerDiagnosticBody,
  providerDiagnosticError,
  ProviderStreamDiagnostic,
} from "./provider-payload-capture.ts";

function encodeLayers(value: string, count: number): string {
  for (let pass = 0; pass < count; pass++) value = encodeURIComponent(value);
  return value;
}

Deno.test("provider diagnostics remove credentials, URLs, and encoded media", () => {
  const deeplyEncodedSignedUrl = encodeLayers(
    "relative/path?X-Amz-Credential=private&X-Amz-Signature=secret",
    4,
  );
  const overEncodedAmbiguousValue = encodeLayers("relative/path?ordinary=value", 14);
  const body = providerDiagnosticBody({
    model: "public/chat",
    headers: { authorization: "Bearer should-never-persist" },
    nested: {
      api_key: "sk-test-secret-value",
      image_url: "https://objects.example/image.png?X-Signature=secret",
      audio: `data:audio/wav;base64,${"A".repeat(512)}`,
    },
    output: "safe response text",
    embedded: "prefix Bearer embedded-secret suffix",
    embeddedUrl: "diagnostic source https://example.test/path?X-Amz-Signature=secret suffix",
    connection: "connect with postgres://user:password@db.example/database",
    signedFragment: "relative/path?X-Goog-Signature=secret",
    signedShort: "relative/path?sig=secret",
    encodedSigned: "relative%2Fpath%3FX-Amz-Credential%3Dprivate%26X-Amz-Signature%3Dsecret",
    deeplyEncodedSignedUrl,
    overEncodedAmbiguousValue,
    malformedEncoding: "diagnostic%E0%A4%Avalue",
    authAssignment: "authorization=opaque-short-value",
    proxyAuthAssignment: "proxy-authorization: opaque-proxy-value",
    cloudOne: "prefix AKIAIOSFODNN7EXAMPLE suffix",
    cloudTwo: "prefix wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY suffix",
    cloudThree: "prefix AIzaSyD-example_key_material_1234567890ab suffix",
    keyAssignment: "access_key=opaque-short-value",
    pem: "-----BEGIN PRIVATE KEY----- private material",
    opaque: "aB3defghijklmnopqrstuvwxyz1234567890ABCD",
    lowercaseHex: "0123456789abcdef0123456789abcdef0123456789abcdef",
    base64url: `prefix ${"a_b-".repeat(79)}abcd suffix`,
    "api key": "short-api-secret",
    safeKeys: {
      max_tokens: 12,
      prompt_tokens: 4,
      completion_tokens: 8,
      tokenizer: "cl100k_base",
      secretary: "Ada",
      headerless: true,
    },
  });
  assertStringIncludes(body!, "safe response text");
  assertEquals(body!.includes("should-never-persist"), false);
  assertEquals(body!.includes("sk-test"), false);
  assertEquals(body!.includes("X-Signature"), false);
  assertEquals(body!.includes("data:audio"), false);
  for (
    const secret of [
      "embedded-secret",
      "https://example.test",
      "password@db.example",
      "X-Goog-Signature",
      "sig=secret",
      "X-Amz-Credential",
      "ordinary=value",
      "diagnostic%E0",
      "opaque-short-value",
      "opaque-proxy-value",
      "AKIAIOSFODNN7EXAMPLE",
      "EXAMPLEKEY",
      "AIzaSyD",
      "opaque-short-value",
      "PRIVATE KEY",
      "abcdefghijklmnopqrstuvwxyz1234567890",
      "0123456789abcdef0123456789abcdef",
      "short-api-secret",
      "a_b-a_b-",
    ]
  ) assertEquals(body!.includes(secret), false, secret);
  assertEquals(JSON.parse(body!).safeKeys, {
    max_tokens: 12,
    prompt_tokens: 4,
    completion_tokens: 8,
    tokenizer: "cl100k_base",
    secretary: "Ada",
    headerless: true,
  });
});

Deno.test("provider diagnostics normalize key variants and serialized secret representations", () => {
  const body = providerDiagnosticBody({
    APIKey: "api-key-secret",
    apikey: "lower-api-key-secret",
    XAPIKey: "compact-x-api-secret",
    "x-api-key": "header-api-key-secret",
    "subscription-key": "subscription-secret",
    csrfToken: "csrf-token-secret",
    tokenValue: "token-value-secret",
    clientSecretValue: "client-secret-value",
    passwordHash: "password-hash-secret",
    authorizationHeader: "authorization-header-secret",
    authHeader: "auth-header-secret",
    "x-functions-key": "functions-key-secret",
    auth: "standalone-auth-secret",
    session_token: "session-token-secret",
    toolArguments: JSON.stringify({
      XAPIKey: "tool-api-secret",
      nested: {
        authorization: "tool-auth-secret",
        tokenValue: "tool-token-secret",
        clientSecretValue: "tool-client-secret",
        passwordHash: "tool-password-secret",
        authorizationHeader: "tool-authorization-header-secret",
        authHeader: "tool-auth-header-secret",
        "x-functions-key": "tool-functions-key-secret",
        failed_reason: "tool-failed-reason-secret",
      },
    }),
    entityAssignment: "authorization&#61;entity-auth-secret",
    hexEntityAssignment: "proxy-authorization&#x3d;entity-proxy-secret",
    entitySignedQuery: "relative/path?ordinary=value&amp;X-Amz-Signature&#61;signed-secret",
    uppercaseHex: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    uuidCredential: "123E4567-E89B-12D3-A456-426614174000",
    safe: {
      max_tokens: 64,
      prompt_tokens: 32,
      completion_tokens: 32,
      cached_tokens: 8,
      reasoning_tokens: 4,
      tokenizer: "o200k_base",
      secretary: "Grace",
      headerless: true,
    },
  })!;
  for (
    const secret of [
      "api-key-secret",
      "lower-api-key-secret",
      "compact-x-api-secret",
      "header-api-key-secret",
      "subscription-secret",
      "csrf-token-secret",
      "token-value-secret",
      "client-secret-value",
      "password-hash-secret",
      "authorization-header-secret",
      "auth-header-secret",
      "functions-key-secret",
      "standalone-auth-secret",
      "session-token-secret",
      "tool-api-secret",
      "tool-auth-secret",
      "tool-token-secret",
      "tool-client-secret",
      "tool-password-secret",
      "tool-authorization-header-secret",
      "tool-auth-header-secret",
      "tool-functions-key-secret",
      "tool-failed-reason-secret",
      "entity-auth-secret",
      "entity-proxy-secret",
      "signed-secret",
      "ABCDEF0123456789",
      "123E4567-E89B",
    ]
  ) assertEquals(body.includes(secret), false, secret);
  assertEquals(JSON.parse(body).safe, {
    max_tokens: 64,
    prompt_tokens: 32,
    completion_tokens: 32,
    cached_tokens: 8,
    reasoning_tokens: 4,
    tokenizer: "o200k_base",
    secretary: "Grace",
    headerless: true,
  });
});

Deno.test("provider diagnostics canonicalize every encoded representation before inspection", () => {
  const body = providerDiagnosticBody({
    caseUrl: encodeLayers("https://objects.example/private", 2),
    caseBearer: encodeLayers("Bearer encoded-bearer-secret", 2),
    caseApi: encodeLayers("api_key=encoded-api-secret", 2),
    caseFour: encodeLayers("authorization=encoded-auth-secret", 2),
    caseConnection: encodeLayers("postgres://user:password@db.example/private", 2),
    caseCombined: "%61%75%74%68%6F%72%69%7A%61%74%69%6F%6E%26%2361%3Bcombined-secret",
    caseSigned: encodeLayers("relative/path?X-Goog-Signature=signed-secret", 3),
    decimalColon: "authorization&#58;decimal-colon-secret",
    hexColon: "authorization&#x3A;hex-colon-secret",
    namedColon: "authorization&colon;named-colon-secret",
    namedEquals: "api_key&equals;named-equals-secret",
    wrappedColon: "authorization%26%23x3A%3Bwrapped-colon-secret",
    bearerPlus: "Bearer+form-bearer-secret",
    encodedBearerPlus: encodeLayers("Bearer+encoded-form-bearer-secret", 2),
    safeEncodedProse: "ordinary%20diagnostic%20text",
    safePlus: "C++ provider adapter",
  })!;
  for (
    const secret of [
      "caseUrl",
      "caseBearer",
      "caseApi",
      "caseFour",
      "caseConnection",
      "caseCombined",
      "caseSigned",
      "decimalColon",
      "hexColon",
      "namedColon",
      "namedEquals",
      "wrappedColon",
      "bearerPlus",
      "encodedBearerPlus",
    ]
  ) assertEquals(JSON.parse(body)[secret], "[SENSITIVE STRING OMITTED]", secret);
  assertEquals(JSON.parse(body).safeEncodedProse, "ordinary%20diagnostic%20text");
  assertEquals(JSON.parse(body).safePlus, "C++ provider adapter");
});

Deno.test("provider diagnostics omit nested free-form error subtrees", () => {
  const body = providerDiagnosticBody({
    choices: [{ message: { content: "safe response" } }],
    metadata: {
      error: {
        message: "unstructured nested failure detail",
        debug: "private nested debug detail",
      },
      errors: [
        { message: "first plural failure" },
        "second plural failure",
      ],
      error_details: { message: "error details secret" },
      errorMessage: "error message secret",
      provider_errors_detail: { message: "provider errors detail secret" },
      exception: { message: "exception secret" },
      last_failure: { message: "last failure secret" },
      failed_reason: "failed reason secret",
      neighboring: {
        errorless: "safe errorless metadata",
        exceptional: "safe exceptional metadata",
        failuresafe: "safe failuresafe metadata",
      },
    },
    safeDiagnostic: {
      error: { category: "timeout", status: 504 },
      errors: [
        { category: "rate_limited", status: 429 },
        { category: "network", status: null },
      ],
    },
  })!;
  assertStringIncludes(body, "safe response");
  for (
    const detail of [
      "unstructured nested failure detail",
      "private nested debug detail",
      "first plural failure",
      "second plural failure",
      "error details secret",
      "error message secret",
      "provider errors detail secret",
      "exception secret",
      "last failure secret",
      "failed reason secret",
    ]
  ) assertEquals(body.includes(detail), false, detail);
  assertStringIncludes(body, "safe errorless metadata");
  assertStringIncludes(body, "safe exceptional metadata");
  assertStringIncludes(body, "safe failuresafe metadata");
  assertEquals(JSON.parse(body).safeDiagnostic, {
    error: { category: "timeout", status: 504 },
    errors: [
      { category: "rate_limited", status: 429 },
      { category: "network", status: null },
    ],
  });
});

Deno.test("provider diagnostics preserve ordinary hyphenated prose next to credential identifiers", () => {
  const body = providerDiagnosticBody({
    prose: "internationalization-configuration-documentation remains useful",
    release: "feature-preview-compatible-release-notes",
    technical: "GPT4-compatible-HTTP2-OAuth2 integration",
    technicalLower: "gpt4-compatible-http2-oauth2 migration",
    uuid: "123e4567-e89b-12d3-a456-426614174000",
    knownPrefix: "sk-proj-Ab12Cd34Ef56Gh78",
  })!;
  assertStringIncludes(body, "internationalization-configuration-documentation");
  assertStringIncludes(body, "feature-preview-compatible-release-notes");
  assertStringIncludes(body, "GPT4-compatible-HTTP2-OAuth2");
  assertStringIncludes(body, "gpt4-compatible-http2-oauth2");
  assertEquals(body.includes("123e4567-e89b"), false);
  assertEquals(body.includes("sk-proj-Ab12"), false);
});

Deno.test("stream diagnostics process many small frames with bounded linear work", () => {
  const stream = new ProviderStreamDiagnostic();
  const started = performance.now();
  for (let index = 0; index < 8_000; index++) {
    stream.observe(JSON.stringify({ index, choices: [{ delta: { content: "ok" } }] }));
  }
  const body = stream.body();
  const elapsed = performance.now() - started;
  assertEquals((JSON.parse(body!) as { events: unknown[] }).events.length, 8_000);
  // This intentionally generous ceiling catches the former quadratic whole-buffer serialization
  // while remaining stable on slower CI runners.
  assertEquals(elapsed < 5_000, true, `8,000 frames took ${elapsed.toFixed(0)}ms`);

  stream.observe("one frame beyond the configured count budget");
  for (let index = 8_001; index <= 10_000; index++) stream.observe(String(index));
  assertEquals(stream.body(), null);
});

Deno.test("provider error diagnostics expose only allowlisted categorical fields", () => {
  const error = Object.assign(new Error("Bearer embedded-error-secret"), {
    status: 503,
    code: "attacker-code-AKIAIOSFODNN7EXAMPLE",
    headers: { authorization: "Bearer header-secret" },
    stack: "private stack",
    response: { body: "private raw response" },
  });
  const body = providerDiagnosticBody({ error: providerDiagnosticError(error) })!;
  assertEquals(Object.keys(JSON.parse(body).error), ["category", "status"]);
  assertEquals(JSON.parse(body).error, { category: "upstream_unavailable", status: 503 });
  assertEquals(body.includes("private stack"), false);
  assertEquals(body.includes("private raw response"), false);
  assertEquals(body.includes("embedded-error-secret"), false);
  assertEquals(body.includes("attacker-code"), false);
  assertStringIncludes(body, "upstream_unavailable");
});

Deno.test("provider error diagnostics reject hostile category and status metadata", () => {
  assertEquals(
    providerDiagnosticError({
      name: "SecretError-AKIAIOSFODNN7EXAMPLE",
      message: "AIzaSyD-example_key_material_1234567890ab",
      code: "access_key=do-not-store",
      status: 999,
      options: {
        category: "Bearer hostile-category-secret",
        status: "503",
      },
    }),
    { category: "unknown", status: null },
  );
  assertEquals(
    providerDiagnosticError({
      name: "TimeoutError",
      options: { category: "timeout", status: 504 },
    }),
    { category: "timeout", status: 504 },
  );
});

Deno.test("provider diagnostics omit oversized complete and streaming bodies", () => {
  assertEquals(providerDiagnosticBody({ text: "large text ".repeat(120_000) }), null);
  const stream = new ProviderStreamDiagnostic();
  stream.observe(
    JSON.stringify({ choices: [{ delta: { content: "large text ".repeat(120_000) } }] }),
  );
  assertEquals(stream.body(), null);
});
