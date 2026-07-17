export interface LoadTargetSafetyOptions {
  allowDestructive?: string;
  baseUrl: string;
  databaseUrl: string;
  projectName: string;
  artifactDirectory: string;
  repositoryRoot: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PROJECT_PATTERN = /^dg-chat-load-[a-z0-9](?:[a-z0-9-]{0,39})$/;
const DATABASE_PATTERN = /^dgchat_load_[a-z0-9][a-z0-9_]{0,39}$/;

function url(value: string, kind: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Refusing load test: ${kind} is not a valid URL.`);
  }
}

function loopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

function containedPath(root: string, child: string): boolean {
  const normalizedRoot = root.replace(/\/+$/u, "");
  const normalizedChild = child.replace(/\/+$/u, "");
  return normalizedChild.startsWith(`${normalizedRoot}/test-results/load/`) &&
    !normalizedChild.split("/").includes("..");
}

/**
 * The load harness creates administrator state, spends credits, and removes its volumes. It is
 * deliberately more restrictive than the ordinary browser harness: only a generated Compose
 * project, loopback listeners, a load-prefixed database, and a repository-owned artifact path are
 * accepted.
 */
export function assertSafeLoadTarget(options: LoadTargetSafetyOptions): void {
  if (options.allowDestructive !== "true") {
    throw new Error(
      "Refusing load test: set DG_CHAT_LOAD_ALLOW_DESTRUCTIVE=true for the disposable stack.",
    );
  }
  if (!PROJECT_PATTERN.test(options.projectName)) {
    throw new Error(
      "Refusing load test: Compose project must use the generated dg-chat-load-* namespace.",
    );
  }

  const base = url(options.baseUrl, "base URL");
  if (base.protocol !== "http:" || !loopback(base.hostname) || base.username || base.password) {
    throw new Error(
      "Refusing load test: the application target must be credential-free loopback HTTP.",
    );
  }

  const database = url(options.databaseUrl, "database URL");
  const databaseName = decodeURIComponent(database.pathname.replace(/^\/+/u, ""));
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !loopback(database.hostname) ||
    !DATABASE_PATTERN.test(databaseName)
  ) {
    throw new Error(
      "Refusing load test: PostgreSQL must be loopback and use a dgchat_load_* database.",
    );
  }
  if (!containedPath(options.repositoryRoot, options.artifactDirectory)) {
    throw new Error(
      "Refusing load test: artifacts must remain under test-results/load in this repository.",
    );
  }
}

export interface LoadProfile {
  streams: number;
  editContenders: number;
  accountingAttempts: number;
  accountingSlots: number;
  queueJobs: number;
  mixedQueueJobs: number;
  timeoutSeconds: number;
}

const PROFILES: Record<string, LoadProfile> = {
  ci: {
    streams: 6,
    editContenders: 12,
    accountingAttempts: 12,
    accountingSlots: 4,
    queueJobs: 100,
    mixedQueueJobs: 12,
    timeoutSeconds: 720,
  },
  standard: {
    streams: 12,
    editContenders: 30,
    accountingAttempts: 30,
    accountingSlots: 10,
    queueJobs: 250,
    mixedQueueJobs: 30,
    timeoutSeconds: 1_200,
  },
  scheduled: {
    streams: 24,
    editContenders: 60,
    accountingAttempts: 60,
    accountingSlots: 20,
    queueJobs: 500,
    mixedQueueJobs: 60,
    timeoutSeconds: 1_800,
  },
};

export function loadProfile(name: string): LoadProfile {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error("LOAD_PROFILE must be one of ci, standard, or scheduled.");
  }
  return { ...profile };
}
