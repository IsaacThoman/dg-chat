export interface NetworkPolicy {
  allowedDomains?: readonly string[];
  allowPrivateNetwork?: boolean;
  allowedPorts?: readonly number[];
}

export type DnsResolver = (hostname: string, recordType: "A" | "AAAA") => Promise<string[]>;

export class NetworkPolicyError extends Error {
  constructor(
    readonly code:
      | "invalid_url"
      | "scheme_not_allowed"
      | "credentials_not_allowed"
      | "domain_not_allowed"
      | "port_not_allowed"
      | "address_not_allowed"
      | "dns_resolution_failed",
    message: string,
  ) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

const normalizeDomain = (value: string) => value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");

export function domainMatches(hostname: string, allowedDomain: string): boolean {
  const host = normalizeDomain(hostname);
  const allowed = normalizeDomain(allowedDomain);
  return Boolean(allowed) && (host === allowed || host.endsWith(`.${allowed}`));
}

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : undefined;
}

function parseIpv6(value: string): number[] | undefined {
  let normalized = value.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const ipv4 = parseIpv4(mapped[2]);
    if (!ipv4) return undefined;
    normalized = `${mapped[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${
      ((ipv4[2] << 8) | ipv4[3]).toString(16)
    }`;
  }
  if (!normalized.includes(":")) return undefined;
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (left.length + right.length > 7) return undefined;
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(fill).fill("0"), ...right].map((part) =>
    /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN
  );
  return words.length === 8 && words.every(Number.isFinite) ? words : undefined;
}

/** Rejects every non-global address class commonly useful for SSRF or metadata access. */
export function isPublicNetworkAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const ipv6 = parseIpv6(address);
  if (!ipv6) return false;
  const [a, b, c, d, e, f, g, h] = ipv6;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return isPublicNetworkAddress(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  }
  return !(
    ipv6.every((word) => word === 0) ||
    (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) ||
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xff00) === 0xff00 ||
    (a === 0x2001 && b === 0x0db8)
  );
}

export const defaultDnsResolver: DnsResolver = async (hostname, recordType) => {
  try {
    return await Deno.resolveDns(hostname, recordType);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

export async function validateNetworkTarget(
  input: string | URL,
  policy: NetworkPolicy = {},
  resolve: DnsResolver = defaultDnsResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new NetworkPolicyError("invalid_url", "Target URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NetworkPolicyError("scheme_not_allowed", "Only HTTP and HTTPS targets are allowed");
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError("credentials_not_allowed", "Target credentials are not allowed");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const allowedPorts = policy.allowedPorts ?? [80, 443];
  if (!allowedPorts.includes(port)) {
    throw new NetworkPolicyError("port_not_allowed", "Target port is not allowed");
  }
  if (
    policy.allowedDomains?.length &&
    !policy.allowedDomains.some((domain) => domainMatches(url.hostname, domain))
  ) throw new NetworkPolicyError("domain_not_allowed", "Target domain is not allowed");

  if (policy.allowPrivateNetwork) return url;
  const literal = parseIpv4(url.hostname) || parseIpv6(url.hostname);
  let addresses: string[];
  if (literal) {
    addresses = [url.hostname.replace(/^\[|\]$/g, "")];
  } else {
    try {
      const [ipv4, ipv6] = await Promise.all([
        resolve(url.hostname, "A"),
        resolve(url.hostname, "AAAA"),
      ]);
      addresses = [...ipv4, ...ipv6];
    } catch {
      throw new NetworkPolicyError("dns_resolution_failed", "Target could not be resolved safely");
    }
  }
  if (!addresses.length) {
    throw new NetworkPolicyError("dns_resolution_failed", "Target did not resolve to an address");
  }
  if (addresses.some((address) => !isPublicNetworkAddress(address))) {
    throw new NetworkPolicyError("address_not_allowed", "Target resolves to a private address");
  }
  return url;
}

/** Validates and returns the exact addresses a transport must pin for this request. */
export async function resolveNetworkTarget(
  input: string | URL,
  policy: NetworkPolicy = {},
  resolve: DnsResolver = defaultDnsResolver,
): Promise<{ url: URL; addresses: string[] }> {
  const url = await validateNetworkTarget(input, policy, resolve);
  const literal = parseIpv4(url.hostname) || parseIpv6(url.hostname);
  const addresses = literal
    ? [url.hostname.replace(/^\[|\]$/g, "")]
    : [...await resolve(url.hostname, "A"), ...await resolve(url.hostname, "AAAA")];
  if (!addresses.length) {
    throw new NetworkPolicyError("dns_resolution_failed", "Target did not resolve to an address");
  }
  if (
    !policy.allowPrivateNetwork && addresses.some((address) => !isPublicNetworkAddress(address))
  ) {
    throw new NetworkPolicyError("address_not_allowed", "Target resolves to a private address");
  }
  return { url, addresses: [...new Set(addresses)] };
}
