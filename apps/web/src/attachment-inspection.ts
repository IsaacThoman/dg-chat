const FRIENDLY_INSPECTION_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  worker_local_policy_rejected:
    "This upload was blocked by the installation's local security policy.",
  worker_malware_detected:
    "This upload was blocked because the security scanner found unsafe content.",
  worker_retry_exhausted:
    "Security scanning could not finish after several attempts. Try again or contact an administrator.",
  worker_external_scanner_unavailable:
    "The installation's security scanner is temporarily unavailable. Try again later.",
  image_guard_pending: "This image needs an additional security review before it can be used.",
  manual_review_required: "This upload needs administrator review before it can be used.",
  security_scan_inconclusive:
    "Security scanning could not confirm that this upload is safe. Try a different file.",
});

const MACHINE_REASON = /^[a-z0-9]+(?:_[a-z0-9]+)+$/u;

/** Keep stable scanner codes in diagnostics while presenting actionable, non-internal copy. */
export function friendlyAttachmentInspectionError(reason: string | null | undefined) {
  if (!reason) return undefined;
  return FRIENDLY_INSPECTION_ERRORS[reason] ??
    (MACHINE_REASON.test(reason)
      ? "This upload could not be approved by the installation's security policy."
      : reason);
}
