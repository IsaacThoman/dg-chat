import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  domainMatches,
  isPublicNetworkAddress,
  NetworkPolicyError,
  resolveNetworkTarget,
  validateNetworkTarget,
} from "./network-policy.ts";

Deno.test("network policy recognizes public and non-public IPv4 and IPv6 ranges", () => {
  for (
    const address of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.1.2",
      "0.0.0.0",
      "224.0.0.1",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]
  ) assertEquals(isPublicNetworkAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assertEquals(isPublicNetworkAddress(address), true, address);
  }
});

Deno.test("resolved transport addresses are revalidated and pinned against DNS rebinding", async () => {
  let aReads = 0;
  const error = await assertRejects(
    () =>
      resolveNetworkTarget(
        "https://search.example.com/path",
        { allowedDomains: ["example.com"] },
        (_host, type) => {
          if (type === "AAAA") return Promise.resolve([]);
          return Promise.resolve([++aReads === 1 ? "93.184.216.34" : "127.0.0.1"]);
        },
      ),
    NetworkPolicyError,
  );
  assertEquals(error.code, "address_not_allowed");
});

Deno.test("domain allowlist matches exact host and subdomains without suffix confusion", () => {
  assertEquals(domainMatches("search.example.com", "example.com"), true);
  assertEquals(domainMatches("example.com", ".example.com."), true);
  assertEquals(domainMatches("evilexample.com", "example.com"), false);
  assertEquals(domainMatches("example.com.evil.test", "example.com"), false);
});

Deno.test("network policy fails closed for credentials, schemes, ports, domains, and mixed DNS", async () => {
  const resolve = (_host: string, type: "A" | "AAAA") =>
    Promise.resolve(type === "A" ? ["93.184.216.34", "127.0.0.1"] : []);
  for (
    const [url, code] of [
      ["file:///etc/passwd", "scheme_not_allowed"],
      ["https://user:secret@example.com", "credentials_not_allowed"],
      ["https://example.com:8443", "port_not_allowed"],
      ["https://evil.test", "domain_not_allowed"],
      ["https://example.com", "address_not_allowed"],
    ] as const
  ) {
    const error = await assertRejects(
      () => validateNetworkTarget(url, { allowedDomains: ["example.com"] }, resolve),
      NetworkPolicyError,
    );
    assertEquals(error.code, code);
  }
});

Deno.test("network policy permits a public allowlisted endpoint and explicit private endpoint", async () => {
  const publicUrl = await validateNetworkTarget(
    "https://search.example.com/path",
    { allowedDomains: ["example.com"] },
    (_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34"] : []),
  );
  assertEquals(publicUrl.hostname, "search.example.com");
  const privateUrl = await validateNetworkTarget("http://searxng:8080", {
    allowedDomains: ["searxng"],
    allowedPorts: [8080],
    allowPrivateNetwork: true,
  });
  assertEquals(privateUrl.port, "8080");
});
