import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import {
  createPinnedLookup,
  isSpecialUseIp,
  pinnedProviderFetch,
  resolvePinnedAddress,
} from "./provider_transport.ts";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";

class FakeResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = "OK";
  headers: Record<string, string> = { "content-type": "text/plain" };
  destroyed = false;
  paused = false;
  destroy() {
    this.destroyed = true;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  endedBody: string | Uint8Array | undefined;
  end(body?: string | Uint8Array) {
    this.endedBody = body;
  }
  destroy(error?: Error) {
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  }
}

Deno.test("DNS pinning rejects every special answer and supports lookup all mode", async () => {
  assert(isSpecialUseIp("127.0.0.1"));
  assert(isSpecialUseIp("::1"));
  assert(isSpecialUseIp("fc00::1"));
  assert(isSpecialUseIp("2001:20::1"));
  assert(isSpecialUseIp("2002:7f00:1::1"));
  assert(isSpecialUseIp("3fff::1"));
  assertEquals(isSpecialUseIp("2001:4860:4860::8888"), false);
  await assertRejects(
    () =>
      resolvePinnedAddress(
        "provider.example",
        (_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34", "10.0.0.1"] : []),
      ),
    Error,
    "private or special-use",
  );
  const pinned = await resolvePinnedAddress(
    "provider.example",
    (_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34"] : ["2606:4700::1111"]),
  );
  assertEquals(pinned, { address: "93.184.216.34", family: 4 });
  const lookup = createPinnedLookup(pinned);
  const single = await new Promise<{ address: string; family: number }>((resolve, reject) =>
    lookup(
      "ignored.example",
      {},
      (error, address, family) =>
        error ? reject(error) : resolve({ address: String(address), family: Number(family) }),
    )
  );
  assertEquals(single, pinned);
  const all = await new Promise<unknown>((resolve, reject) =>
    lookup(
      "ignored.example",
      { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses),
    )
  );
  assertEquals(all, [pinned]);
});

Deno.test("pinned HTTPS transport preserves authority, streams, and cancels sockets", async () => {
  const fakeRequest = new FakeRequest();
  const fakeResponse = new FakeResponse();
  let requestedUrl: URL | undefined;
  let options: RequestOptions | undefined;
  const request = (
    url: URL,
    requestOptions: RequestOptions,
    callback: (r: IncomingMessage) => void,
  ) => {
    requestedUrl = url;
    options = requestOptions;
    queueMicrotask(() => callback(fakeResponse as unknown as IncomingMessage));
    return fakeRequest;
  };
  const response = await pinnedProviderFetch("https://provider.example/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: "{}",
  }, {
    resolveDns: (_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34"] : []),
    request,
  });
  assertEquals(requestedUrl?.hostname, "provider.example");
  assertEquals(
    (options as RequestOptions & { servername?: string } | undefined)?.servername,
    "provider.example",
  );
  assertEquals(options?.agent, false);
  assertEquals(options?.family, 4);
  assertEquals((options?.headers as Record<string, string>)["accept-encoding"], "identity");
  assertEquals(fakeRequest.endedBody, "{}");
  fakeResponse.emit("data", new TextEncoder().encode("split "));
  assert(fakeResponse.paused);
  const bodyReader = response.body?.getReader();
  assert(bodyReader);
  const firstChunk = await bodyReader.read();
  assertEquals(new TextDecoder().decode(firstChunk.value), "split ");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(fakeResponse.paused, false);
  fakeResponse.emit("data", new TextEncoder().encode("body"));
  fakeResponse.emit("end");
  const secondChunk = await bodyReader.read();
  assertEquals(new TextDecoder().decode(secondChunk.value), "body");
  assertEquals((await bodyReader.read()).done, true);

  const cancelRequest = new FakeRequest();
  const cancelResponse = new FakeResponse();
  const cancelResult = await pinnedProviderFetch(
    "https://provider.example/v1/chat/completions",
    {},
    {
      resolveDns: (_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34"] : []),
      request: (_url, _options, callback) => {
        queueMicrotask(() => callback(cancelResponse as unknown as IncomingMessage));
        return cancelRequest;
      },
    },
  );
  await cancelResult.body?.cancel();
  assert(cancelRequest.destroyed);
  assert(cancelResponse.destroyed);
});

Deno.test("pinned transport rejects unsafe URLs, redirects, and aborted requests", async () => {
  const neverRequest = () => {
    throw new Error("request must not be reached");
  };
  for (
    const url of [
      "http://provider.example/v1",
      "https://user:pass@provider.example/v1",
      "https://provider.example/v1#fragment",
    ]
  ) {
    await assertRejects(
      () => pinnedProviderFetch(url, {}, { request: neverRequest }),
      Error,
    );
  }

  const redirect = new FakeResponse();
  redirect.statusCode = 302;
  redirect.headers.location = "https://other.example/";
  await assertRejects(
    () =>
      pinnedProviderFetch("https://provider.example/v1", {}, {
        resolveDns: (_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34"] : []),
        request: (_url, _options, callback) => {
          const request = new FakeRequest();
          queueMicrotask(() => callback(redirect as unknown as IncomingMessage));
          return request;
        },
      }),
    Error,
    "redirects",
  );
  assert(redirect.destroyed);

  const manualRedirect = new FakeResponse();
  manualRedirect.statusCode = 307;
  manualRedirect.headers.location = "https://cdn.example/image.png";
  const manual = await pinnedProviderFetch(
    "https://provider.example/image",
    { redirect: "manual" },
    {
      resolveDns: (_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34"] : []),
      request: (_url, _options, callback) => {
        const request = new FakeRequest();
        queueMicrotask(() => callback(manualRedirect as unknown as IncomingMessage));
        return request;
      },
    },
  );
  assertEquals(manual.status, 307);
  assertEquals(manual.headers.get("location"), "https://cdn.example/image.png");
  assert(manualRedirect.destroyed);

  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assertRejects(
    () =>
      pinnedProviderFetch("https://provider.example/v1", { signal: controller.signal }, {
        request: neverRequest,
      }),
    DOMException,
    "cancelled",
  );

  const duringDns = new AbortController();
  const pendingDns = pinnedProviderFetch(
    "https://provider.example/v1",
    { signal: duringDns.signal },
    {
      resolveDns: () => new Promise<string[]>(() => {}),
      request: neverRequest,
    },
  );
  duringDns.abort(new DOMException("dns cancelled", "AbortError"));
  await assertRejects(() => pendingDns, DOMException, "dns cancelled");
});
