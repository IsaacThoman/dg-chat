export type AdminLifecycleAction =
  | "promote"
  | "demote"
  | "suspend"
  | "activate"
  | "delete"
  | "restore";

/** Parse the administrator-facing USD input without binary floating-point accounting. */
export function parseStartingCreditMicros(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(micros) && micros <= 1_000_000_000 ? micros : null;
}

/** Format exact USD micros for an editable administrator-facing input. */
export function formatStartingCreditMicros(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}.00`;
}

export function adminLifecycleErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "final_admin":
      return "This is the final active administrator. Promote another approved user first.";
    case "self_action_forbidden":
      return "You cannot remove your own administrative access. Ask another administrator.";
    case "invalid_transition":
      return "This account is not eligible for that change. Review its approval, access, and deletion status.";
    case "no_state_change":
      return "The account already has that setting. The directory has been refreshed.";
    default:
      return fallback;
  }
}

export function adminLifecycleConsequence(action: AdminLifecycleAction): string {
  switch (action) {
    case "suspend":
      return "Suspension revokes full sessions and API token families. Reactivation will not recreate them.";
    case "delete":
      return "Deletion revokes full sessions and API token families while preserving audit, ledger, and chat history.";
    case "activate":
      return "Reactivation allows a new sign-in but never restores previously revoked credentials.";
    case "restore":
      return "Restoration clears soft deletion but preserves the account’s current active or suspended state.";
    case "promote":
      return "Promotion grants administrative authority to this approved, active account.";
    case "demote":
      return "Demotion removes administrative authority without changing ordinary workspace access.";
  }
}
