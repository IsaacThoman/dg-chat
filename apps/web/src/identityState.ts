import type { User } from "./types.ts";
import { passwordPolicyError } from "../../../packages/contracts/src/password-policy.ts";

export type AuthStatus = {
  approvalStatus: "pending" | "approved" | "rejected";
  state: "active" | "suspended";
  emailVerified: boolean;
  emailVerificationRequired: boolean;
  sessionLimited: boolean;
  fullSessionEligible: boolean;
  fullAccess: boolean;
};

export function identityTokenFromUrl(value: string): string {
  const url = new URL(value);
  const fragmentToken = new URLSearchParams(url.hash.replace(/^#/, "")).get("token");
  return (fragmentToken ?? url.searchParams.get("token") ?? "").trim();
}

export function identityDestination(user: Pick<User, "status" | "limited">): "/" | "/pending" {
  return user.status === "approved" && !user.limited ? "/" : "/pending";
}

export function pendingMode(status: AuthStatus | undefined):
  | "loading"
  | "approval"
  | "verification"
  | "refresh"
  | "rejected"
  | "unavailable"
  | "ready" {
  if (!status) return "loading";
  if (status.state !== "active") return "unavailable";
  if (status.approvalStatus === "rejected") return "rejected";
  if (status.approvalStatus !== "approved") return "approval";
  if (status.emailVerificationRequired && !status.emailVerified) return "verification";
  if (status.fullSessionEligible && !status.fullAccess) return "refresh";
  return status.fullAccess ? "ready" : "unavailable";
}

export function recoveryPasswordError(password: string, confirmation: string): string | null {
  const policyError = passwordPolicyError(password);
  if (policyError) return policyError;
  if (password !== confirmation) return "The passwords do not match.";
  return null;
}
