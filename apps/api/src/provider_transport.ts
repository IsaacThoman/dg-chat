import { request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { LookupFunction } from "node:net";

type AddressFamily = 4 | 6;

export interface PinnedAddress {
  address: string;
  family: AddressFamily;
}

export type ResolveDns = (hostname: string, recordType: "A" | "AAAA") => Promise<string[]>;

interface ClientRequestLike {
  end(body?: string | Uint8Array): void;
  destroy(error?: Error): void;
  on(event: "error", listener: (error: Error) => void): this;
}

type RequestHttps = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequestLike;

export interface PinnedTransportDependencies {
  resolveDns?: ResolveDns;
  request?: RequestHttps;
}

function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every((part) => part <= 255) ? octets : undefined;
}

function ipv6Words(host: string): number[] | undefined {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!bare.includes(":") || bare.includes("%") || bare.split("::").length > 2) return undefined;
  const convert = (parts: string[]) => {
    const words: number[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (part.includes(".")) {
        if (index !== parts.length - 1) return undefined;
        const octets = ipv4Octets(part);
        if (!octets) return undefined;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };
  const [leftText, rightText] = bare.split("::");
  const left = convert(leftText ? leftText.split(":") : []);
  const right = convert(rightText ? rightText.split(":") : []);
  if (!left || !right) return undefined;
  if (!bare.includes("::")) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array(missing).fill(0), ...right] : undefined;
}

/** Conservatively classifies IP literals that must never be used for provider egress. */
export function isSpecialUseIp(host: string): boolean {
  const ipv4 = ipv4Octets(host);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const ipv6 = ipv6Words(host);
  if (!ipv6) return false;
  const [first, second] = ipv6;
  const mapped = ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff;
  const compatible = ipv6.slice(0, 6).every((word) => word === 0);
  if (mapped || compatible) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return true;
  }
  // IANA special-purpose space, documentation prefixes, and deprecated transition mechanisms.
  if (first === 0x2001 && ((second & 0xfe00) === 0 || second === 0x0db8)) return true;
  if (first === 0x2002) return true;
  if (first === 0x3fff && (second & 0xf000) === 0) return true;
  return (first & 0xe000) !== 0x2000;
}

function parsedIp(host: string): PinnedAddress | undefined {
  const bare = host.replace(/^\[|\]$/g, "");
  if (ipv4Octets(bare)) return { address: bare, family: 4 };
  if (ipv6Words(bare)) return { address: bare, family: 6 };
  return undefined;
}

export async function resolvePinnedAddress(
  hostname: string,
  resolveDns: ResolveDns = Deno.resolveDns,
  signal?: AbortSignal,
): Promise<PinnedAddress> {
  signal?.throwIfAborted();
  const literal = parsedIp(hostname);
  let results: Awaited<ReturnType<typeof Promise.allSettled<string[]>>> = [];
  if (!literal) {
    const resolution = Promise.allSettled([
      resolveDns(hostname, "A"),
      resolveDns(hostname, "AAAA"),
    ]);
    let abort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted", "AbortError"),
        );
      signal?.addEventListener("abort", abort, { once: true });
    });
    results = await Promise.race([resolution, aborted]).finally(() =>
      signal?.removeEventListener("abort", abort)
    );
  }
  const answers = literal
    ? [literal]
    : results.flatMap((result, index) =>
      result.status === "fulfilled"
        ? result.value.map((address) => ({
          address,
          family: (index === 0 ? 4 : 6) as AddressFamily,
        }))
        : []
    );
  if (answers.length === 0) throw new Error("Provider hostname did not resolve");
  if (answers.some(({ address }) => !parsedIp(address) || isSpecialUseIp(address))) {
    throw new Error("Provider hostname resolved to a private or special-use network");
  }
  return answers[0];
}

export function createPinnedLookup(pinned: PinnedAddress): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (options?.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) { for (const item of value) headers.append(name, item); }
    else if (value !== undefined) headers.set(name, String(value));
  }
  return headers;
}

/** HTTPS-only fetch adapter that pins the validated DNS answer through TCP and TLS. */
export async function pinnedProviderFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  dependencies: PinnedTransportDependencies = {},
): Promise<Response> {
  const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
  if (url.protocol !== "https:") throw new Error("Pinned provider transport requires HTTPS");
  if (url.username || url.password || url.hash) {
    throw new Error("Provider URL must not contain credentials or a fragment");
  }
  if (input instanceof Request && init.body === undefined && input.body !== null) {
    throw new TypeError("Pinned provider transport requires Request bodies in init.body");
  }
  init.signal?.throwIfAborted();
  const pinned = await resolvePinnedAddress(
    url.hostname,
    dependencies.resolveDns,
    init.signal ?? undefined,
  );
  init.signal?.throwIfAborted();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.set("accept-encoding", "identity");
  const body = init.body;
  if (
    body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)
  ) {
    throw new TypeError("Pinned provider transport only supports string or byte request bodies");
  }

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let upstream: IncomingMessage | undefined;
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    let abort = () => {};
    const cleanupAbort = () => init.signal?.removeEventListener("abort", abort);
    const request = (dependencies.request ?? httpsRequest)(url, {
      method,
      headers: Object.fromEntries(headers.entries()),
      agent: false,
      family: pinned.family,
      lookup: createPinnedLookup(pinned),
      servername: url.hostname,
      rejectUnauthorized: true,
    }, (response) => {
      upstream = response;
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        cleanupAbort();
        response.destroy();
        settled = true;
        if (init.redirect === "manual") {
          resolve(
            new Response(null, {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders(response),
            }),
          );
          return;
        }
        reject(new Error("Provider redirects are not allowed"));
        return;
      }
      const noBody = method === "HEAD" || status === 204 || status === 304;
      const stream = noBody ? null : new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Uint8Array) => {
            controller.enqueue(new Uint8Array(chunk));
            if ((controller.desiredSize ?? 1) <= 0) response.pause();
          });
          response.once("end", () => {
            cleanupAbort();
            controller.close();
          });
          response.once("error", (error: Error) => {
            cleanupAbort();
            controller.error(error);
          });
        },
        cancel(reason) {
          cleanupAbort();
          response.destroy(reason instanceof Error ? reason : undefined);
          request.destroy(reason instanceof Error ? reason : undefined);
        },
        pull() {
          response.resume();
        },
      });
      if (noBody) cleanupAbort();
      settled = true;
      resolve(
        new Response(stream, {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders(response),
        }),
      );
    });
    abort = () => {
      const reason = init.signal?.reason instanceof Error
        ? init.signal.reason
        : new DOMException("The operation was aborted", "AbortError");
      upstream?.destroy(reason);
      request.destroy(reason);
      if (!settled) {
        settled = true;
        reject(reason);
      }
    };
    init.signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => {
      cleanupAbort();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.end(body === null || body === undefined ? undefined : body);
  });
}
