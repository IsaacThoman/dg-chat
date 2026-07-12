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

/**
 * Privileged installation-portability boundary. Implementations own durable operation state,
 * archive validation, object staging, and the database maintenance fence. Hono only authenticates
 * and translates the browser contract.
 */
export interface BackupAdminService {
  readonly restoreEnabled: boolean;
  /** Fail-closed feature capability; omitted by services that only support redacted backups. */
  readonly privilegedSecretBackupsEnabled?: boolean;
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
