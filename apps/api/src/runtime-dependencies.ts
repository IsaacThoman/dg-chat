export interface RuntimeDependencyConfig {
  production: boolean;
  databaseUrl?: string;
  redisUrl?: string;
  objectStoreConfigured: boolean;
}

export const PRODUCTION_READINESS_REQUIREMENTS = {
  storage: "postgres",
  redis: "redis",
  objects: "s3",
} as const;

function present(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Durable, distributed dependencies are mandatory in production. Development and tests may still
 * deliberately use the in-process repository and coordination adapters created by `createApp`.
 */
export function assertRuntimeDependencies(config: RuntimeDependencyConfig): void {
  if (!config.production) return;

  const missing: string[] = [];
  if (!present(config.databaseUrl)) missing.push("DATABASE_URL");
  if (!present(config.redisUrl)) missing.push("REDIS_URL");
  if (!config.objectStoreConfigured) missing.push("S3 object storage");

  if (missing.length > 0) {
    throw new Error(`Production requires ${missing.join(", ")}`);
  }
}
