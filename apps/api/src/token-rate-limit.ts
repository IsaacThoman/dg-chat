import type { RateLimiter, RateLimitResult } from "./rate-limit.ts";

export interface TokenRatePolicy {
  rotationFamilyId: string;
  requestsPerMinute: number | null;
  burst: number | null;
}

export interface TokenRateLimitResult extends RateLimitResult {
  bucket: "rpm" | "burst";
}

export async function consumeTokenRateLimits(
  limiter: RateLimiter,
  policy: TokenRatePolicy,
  defaultRequestsPerMinute: number,
  defaultBurst: number,
): Promise<TokenRateLimitResult> {
  const pending: Array<Promise<TokenRateLimitResult>> = [];
  const rpmLimit = policy.requestsPerMinute ?? defaultRequestsPerMinute;
  pending.push(
    limiter.consume(
      `token:${policy.rotationFamilyId}:rpm`,
      rpmLimit,
      60,
    ).then((result) => ({ ...result, bucket: "rpm" as const })),
  );
  const burstLimit = policy.burst ?? defaultBurst;
  pending.push(
    limiter.consume(`token:${policy.rotationFamilyId}:burst`, burstLimit, 1)
      .then((result) => ({ ...result, bucket: "burst" as const })),
  );
  const results = await Promise.all(pending);
  return results.reduce((mostRestrictive, candidate) => {
    if (mostRestrictive.allowed !== candidate.allowed) {
      return mostRestrictive.allowed ? candidate : mostRestrictive;
    }
    if (mostRestrictive.remaining !== candidate.remaining) {
      return mostRestrictive.remaining < candidate.remaining ? mostRestrictive : candidate;
    }
    return mostRestrictive.retryAfterSeconds >= candidate.retryAfterSeconds
      ? mostRestrictive
      : candidate;
  });
}
