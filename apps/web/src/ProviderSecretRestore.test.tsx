import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canApplyProviderSecretRestore,
  PROVIDER_SECRET_RESTORE_CONFIRMATION,
  ProviderSecretRestore,
} from "./ProviderSecretRestore.tsx";

const preview = {
  id: "10000000-0000-4000-8000-000000000010",
  restoreId: "10000000-0000-4000-8000-000000000011",
  status: "validated" as const,
  version: 2,
  baseFingerprint: "a".repeat(64),
  sidecarFingerprint: "b".repeat(64),
  recoveryKeyId: "recovery-2026",
  recordCount: 2,
  providers: [],
  warnings: [],
  blockingErrors: [],
  providersRemainDisabled: true as const,
};

describe("ProviderSecretRestore", () => {
  it("renders a fail-closed disabled policy warning", () => {
    const html = renderToStaticMarkup(<ProviderSecretRestore enabled={false} />);
    expect(html).toContain("Provider-secret restore is disabled");
    expect(html).toContain("destination recovery keyring");
    expect(html).not.toContain("Choose the matching");
  });

  it("explains exact pairing and preloads a recent completed restore", () => {
    const html = renderToStaticMarkup(
      <ProviderSecretRestore enabled initialRestoreId={preview.restoreId} />,
    );
    expect(html).toContain("Exact pairing and recovery key required");
    expect(html).toContain("every provider stays disabled");
    expect(html).toContain(`value="${preview.restoreId}"`);
    expect(html).toContain("Choose the matching .dgsecrets file");
  });

  it("requires exact confirmation, no blockers, and an unapplied preview", () => {
    expect(canApplyProviderSecretRestore(undefined, PROVIDER_SECRET_RESTORE_CONFIRMATION)).toBe(
      false,
    );
    expect(canApplyProviderSecretRestore(preview, "restore provider secrets")).toBe(false);
    expect(canApplyProviderSecretRestore(preview, PROVIDER_SECRET_RESTORE_CONFIRMATION)).toBe(true);
    expect(canApplyProviderSecretRestore(
      { ...preview, blockingErrors: ["Provider missing"] },
      PROVIDER_SECRET_RESTORE_CONFIRMATION,
    )).toBe(false);
    expect(canApplyProviderSecretRestore(preview, PROVIDER_SECRET_RESTORE_CONFIRMATION, true)).toBe(
      false,
    );
  });
});
