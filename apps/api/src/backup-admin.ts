export type BackupExportStatus = "queued" | "running" | "completed" | "failed";

export interface BackupExportSummary {
  id: string;
  status: BackupExportStatus;
  formatVersion: number;
  includesDiagnostics: boolean;
  secretsRedacted: true;
  bytes: number | null;
  fingerprint: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ProviderSecretExportSummary {
  status: BackupExportStatus;
  encrypted: true;
  providerCount: number | null;
  bytes: number | null;
  fingerprint: string | null;
  recoveryKeyId: string | null;
}

export interface PrivilegedBackupExportSummary extends BackupExportSummary {
  providerSecrets: ProviderSecretExportSummary;
}

export interface BackupRestoreUploadSummary {
  id: string;
  filename: string;
  bytes: number;
  fingerprint: string;
  createdAt: string;
}

export interface BackupRestoreCount {
  resource: string;
  create: number;
  update: number;
  skip: number;
}

export interface BackupRestorePreview {
  restoreId: string;
  fingerprint: string;
  formatVersion: number;
  createdAt: string;
  counts: BackupRestoreCount[];
  warnings: string[];
  blockingErrors: string[];
  secretsRedacted: boolean;
  attachmentsMissing: number;
}

export interface BackupRestoreResult {
  restoreId: string;
  status: "completed";
  completedAt: string;
  counts: BackupRestoreCount[];
}

export interface BackupRestoreStatusCapability {
  token: string;
  expiresAt: string;
}

export interface BackupRestoreStatus {
  restoreId: string;
  status: "validated" | "running" | "completed" | "failed";
  stage: string;
  completedAt: string | null;
  error: string | null;
}

export type ProviderSecretRestoreImpactAction = "restore" | "skip" | "blocked";
export interface ProviderSecretRestoreImpact {
  providerId: string;
  displayName: string;
  action: ProviderSecretRestoreImpactAction;
  reason: string | null;
}
export interface ProviderSecretRestoreUploadSummary {
  id: string;
  restoreId: string;
  status: "uploaded";
  version: number;
  filename: string;
  bytes: number;
  baseFingerprint: string;
  sidecarFingerprint: string;
  recoveryKeyId: string;
  createdAt: string;
}
export interface ProviderSecretRestorePreview {
  id: string;
  restoreId: string;
  status: "validated";
  version: number;
  baseFingerprint: string;
  sidecarFingerprint: string;
  recoveryKeyId: string;
  recordCount: number;
  providers: ProviderSecretRestoreImpact[];
  warnings: string[];
  blockingErrors: string[];
  providersRemainDisabled: true;
}
export interface ProviderSecretRestoreResult {
  id: string;
  restoreId: string;
  status: "applied";
  providerCount: number;
  providersRemainDisabled: true;
  appliedAt: string;
}
export interface ProviderSecretRestoreState {
  id: string;
  restoreId: string;
  status: "staging" | "uploaded" | "validated" | "applied" | "failed" | "cancelled";
  version: number;
  filename: "provider-secrets.dgsecrets";
  bytes: number;
  baseFingerprint: string;
  sidecarFingerprint: string;
  recoveryKeyId: string;
  recordCount: number | null;
  providers: ProviderSecretRestoreImpact[];
  warnings: string[];
  blockingErrors: string[];
  providersRemainDisabled: true;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  expiresAt: string | null;
  canCancel: boolean;
}

/**
 * Privileged installation-portability boundary. Implementations own durable operation state,
 * archive validation, object staging, and the database maintenance fence. Hono only authenticates
 * and translates the browser contract.
 */
export interface BackupAdminService {
  readonly restoreEnabled: boolean;
  /** Fail-closed feature capability; omitted by services that only support redacted backups. */
  readonly privilegedSecretBackupsEnabled?: boolean;
  /** Fail-closed destination recovery capability; independent from privileged export support. */
  readonly providerSecretRestoreEnabled?: boolean;
  listExports(actorId: string): Promise<BackupExportSummary[]>;
  requestExport(input: {
    actorId: string;
    includeDiagnostics: boolean;
    idempotencyKey: string;
  }): Promise<BackupExportSummary>;
  exportContent(actorId: string, exportId: string): Promise<Response>;
  requestPrivilegedExport?(input: {
    actorId: string;
    includeDiagnostics: boolean;
    idempotencyKey: string;
  }): Promise<PrivilegedBackupExportSummary>;
  providerSecretExportContent?(actorId: string, exportId: string): Promise<Response>;
  uploadProviderSecretRestore?(input: {
    actorId: string;
    restoreId: string;
    request: Request;
    idempotencyKey: string;
  }): Promise<ProviderSecretRestoreUploadSummary>;
  previewProviderSecretRestore?(
    actorId: string,
    restoreId: string,
    sidecarId: string,
  ): Promise<ProviderSecretRestorePreview>;
  applyProviderSecretRestore?(input: {
    actorId: string;
    restoreId: string;
    sidecarId: string;
    expectedVersion: number;
    baseFingerprint: string;
    sidecarFingerprint: string;
  }): Promise<ProviderSecretRestoreResult>;
  getProviderSecretRestore?(
    actorId: string,
    restoreId: string,
  ): Promise<ProviderSecretRestoreState | null>;
  cancelProviderSecretRestore?(input: {
    actorId: string;
    restoreId: string;
    sidecarId: string;
    expectedVersion: number;
  }): Promise<ProviderSecretRestoreState>;
  uploadRestore(input: {
    actorId: string;
    request: Request;
    idempotencyKey: string;
  }): Promise<BackupRestoreUploadSummary>;
  previewRestore(actorId: string, restoreId: string): Promise<BackupRestorePreview>;
  issueRestoreStatusCapability(
    actorId: string,
    restoreId: string,
  ): Promise<BackupRestoreStatusCapability>;
  restoreStatus(restoreId: string, capability: string): Promise<BackupRestoreStatus>;
  applyRestore(input: {
    actorId: string;
    restoreId: string;
    fingerprint: string;
  }): Promise<BackupRestoreResult>;
  maintenanceState(): Promise<{ enabled: boolean; retryAfterSeconds: number }>;
  close?(): Promise<void> | void;
}
