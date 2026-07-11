import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { SearxngSearchAdapter, WebSearchError } from "./web-search.ts";

const publicDns = (_host: string, type: "A" | "AAAA") =>
  Promise.resolve(type === "A" ? ["93.184.216.34"] : []);

Deno.test("SearXNG adapter bounds and normalizes results", async () => {
  let seen: URL | undefined;
  const adapter = new SearxngSearchAdapter({
    baseUrl: "https://search.example.com/root/",
    resolveDns: publicDns,
    fetch: (input) => {
      seen = new URL(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                title: " Result ",
                url: "https://docs.example.com/a",
                content: " snippet ",
                engine: "x",
              },
              { title: "unsafe", url: "javascript:alert(1)", content: "bad" },
              { title: "second", url: "https://example.com/b", content: "ok" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  const response = await adapter.search({ query: "hello world", count: 1, safeSearch: 2 });
  assertEquals(seen?.pathname, "/root/search");
  assertEquals(seen?.searchParams.get("q"), "hello world");
  assertEquals(seen?.searchParams.get("safesearch"), "2");
  assertEquals(response.results, [{
    title: "Result",
    url: "https://docs.example.com/a",
    snippet: "snippet",
    source: "x",
    publishedAt: undefined,
  }]);
});

Deno.test("SearXNG adapter rejects redirects, wrong MIME, oversized bodies, and private DNS", async () => {
  const cases: Array<[Response, string]> = [
    [
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }),
      "request_failed",
    ],
    [new Response("{}", { headers: { "content-type": "text/html" } }), "invalid_response"],
    [
      new Response('{"results":[]}', {
        headers: { "content-type": "application/json", "content-length": "999" },
      }),
      "response_too_large",
    ],
  ];
  for (const [response, code] of cases) {
    const adapter = new SearxngSearchAdapter({
      baseUrl: "https://search.example.com",
      resolveDns: publicDns,
      maxResponseBytes: 32,
      fetch: () => Promise.resolve(response),
    });
    const error = await assertRejects(() => adapter.search({ query: "test" }), WebSearchError);
    assertEquals(error.code, code);
  }
  const privateAdapter = new SearxngSearchAdapter({
    baseUrl: "http://searxng:8080",
    resolveDns: (_host, type) => Promise.resolve(type === "A" ? ["172.18.0.2"] : []),
    fetch: () => Promise.resolve(new Response("never")),
  });
  await assertRejects(() => privateAdapter.search({ query: "test" }), WebSearchError, "blocked");
});

Deno.test("SearXNG private service requires an explicit configuration opt-in", async () => {
  const adapter = new SearxngSearchAdapter({
    baseUrl: "http://searxng:8080",
    allowPrivateEndpoint: true,
    fetch: () =>
      Promise.resolve(
        new Response('{"results":[]}', {
          headers: { "content-type": "application/json" },
        }),
      ),
  });
  assertEquals(await adapter.search({ query: "test" }), { query: "test", results: [] });
});
