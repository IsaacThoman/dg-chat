import postgres from "npm:postgres@3.4.7";

const PREFIX = /^dgchat_ci_[a-z0-9_]{1,30}_$/u;
const SUFFIX = /^[a-z][a-z0-9_]{0,23}$/u;
const PROTECTED_DATABASES = new Set(["postgres", "template0", "template1"]);
const OWNERSHIP_SCHEMA = "dg_chat_ci_harness";
const OWNERSHIP_TABLE = "database_ownership";

type EnvironmentReader = (name: string) => string | undefined;

export interface DestructiveDatabaseConfig {
  baseUrl: string;
  baseDatabase: string;
  prefix: string;
  template: string;
}

function required(read: EnvironmentReader, name: string): string {
  const value = read(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function destructiveDatabaseConfig(
  read: EnvironmentReader = (name) => Deno.env.get(name),
): DestructiveDatabaseConfig {
  if (read("DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES") !== "true") {
    throw new Error(
      "DG_CHAT_ALLOW_DESTRUCTIVE_TEST_DATABASES must be exactly true for disposable database operations",
    );
  }
  const baseUrl = required(read, "DATABASE_URL");
  const baseDatabase = decodeURIComponent(new URL(baseUrl).pathname.replace(/^\//u, ""));
  const prefix = required(read, "POSTGRES_TEST_DATABASE_PREFIX");
  if (!PREFIX.test(prefix)) {
    throw new Error(`POSTGRES_TEST_DATABASE_PREFIX must match ${PREFIX}`);
  }
  const template = `${prefix}template`;
  if (template.length > 63 || PROTECTED_DATABASES.has(template) || template === baseDatabase) {
    throw new Error("POSTGRES_TEST_DATABASE_PREFIX does not produce a safe template database");
  }
  return { baseUrl, baseDatabase, prefix, template };
}

export function ownedDatabaseName(
  config: DestructiveDatabaseConfig,
  suffix: string,
): string {
  if (!SUFFIX.test(suffix)) throw new Error(`database group suffix must match ${SUFFIX}`);
  const name = `${config.prefix}${suffix}`;
  if (
    name.length > 63 || PROTECTED_DATABASES.has(name) || name === config.baseDatabase ||
    name === config.template
  ) {
    throw new Error("database group does not produce a safe helper-owned database name");
  }
  return name;
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function adminClient(baseUrl: string) {
  return postgres(databaseUrl(baseUrl, "postgres"), { max: 1 });
}

async function ensureOwnershipStore(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${OWNERSHIP_SCHEMA}`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${OWNERSHIP_SCHEMA}.${OWNERSHIP_TABLE}(
    database_name text PRIMARY KEY,
    namespace text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function databaseExists(sql: postgres.Sql, name: string): Promise<boolean> {
  return (await sql<{ exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${name}) exists`)[0].exists;
}

async function recordedOwner(sql: postgres.Sql, name: string): Promise<string | undefined> {
  const rows = await sql<{ namespace: string }[]>`
    SELECT namespace FROM dg_chat_ci_harness.database_ownership WHERE database_name=${name}`;
  return rows[0]?.namespace;
}

async function dropOwnedDatabase(
  sql: postgres.Sql,
  config: DestructiveDatabaseConfig,
  name: string,
): Promise<void> {
  const exists = await databaseExists(sql, name);
  const owner = await recordedOwner(sql, name);
  if (owner !== undefined && owner !== config.prefix) {
    throw new Error(`Refusing database ${name}: it belongs to another test namespace`);
  }
  if (exists && owner !== config.prefix) {
    throw new Error(`Refusing to drop unowned database ${name}`);
  }
  if (exists) await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (owner === config.prefix) {
    await sql`
      DELETE FROM dg_chat_ci_harness.database_ownership
      WHERE database_name=${name} AND namespace=${config.prefix}`;
  }
}

async function createOwnedDatabase(
  sql: postgres.Sql,
  config: DestructiveDatabaseConfig,
  name: string,
  template?: string,
): Promise<void> {
  if (await databaseExists(sql, name) || await recordedOwner(sql, name)) {
    throw new Error(`Refusing to create over existing database ownership state for ${name}`);
  }
  await sql`
    INSERT INTO dg_chat_ci_harness.database_ownership(database_name,namespace)
    VALUES(${name},${config.prefix})`;
  try {
    await sql.unsafe(
      template ? `CREATE DATABASE "${name}" TEMPLATE "${template}"` : `CREATE DATABASE "${name}"`,
    );
  } catch (error) {
    await sql`
      DELETE FROM dg_chat_ci_harness.database_ownership
      WHERE database_name=${name} AND namespace=${config.prefix}`;
    throw error;
  }
}

async function run(
  executable: string,
  args: string[],
  environment: Record<string, string>,
): Promise<number> {
  const child = new Deno.Command(executable, {
    args,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await child.status).code;
}

async function main(): Promise<number> {
  const config = destructiveDatabaseConfig();
  const [modeOrSuffix, executable, ...commandArgs] = Deno.args;
  const admin = adminClient(config.baseUrl);
  try {
    await ensureOwnershipStore(admin);
    if (modeOrSuffix === "--prepare-template") {
      await dropOwnedDatabase(admin, config, config.template);
      await createOwnedDatabase(admin, config, config.template);
      const templateUrl = databaseUrl(config.baseUrl, config.template);
      const code = await run("deno", ["task", "db:migrate"], {
        ...Deno.env.toObject(),
        DATABASE_URL: templateUrl,
        TEST_DATABASE_URL: templateUrl,
      });
      if (code !== 0) {
        await dropOwnedDatabase(admin, config, config.template);
        return code;
      }
      console.log(`Prepared freshly migrated PostgreSQL template ${config.template}`);
      return 0;
    }
    if (modeOrSuffix === "--cleanup-template") {
      await dropOwnedDatabase(admin, config, config.template);
      console.log(`Removed helper-owned PostgreSQL template ${config.template}`);
      return 0;
    }

    if (!modeOrSuffix || !executable) {
      throw new Error(
        "Usage: run-postgres-test-group.ts <group-suffix> <command> [...args], --prepare-template, or --cleanup-template",
      );
    }
    const group = ownedDatabaseName(config, modeOrSuffix);
    await dropOwnedDatabase(admin, config, group);
    await createOwnedDatabase(admin, config, group, config.template);
    let exitCode = 1;
    try {
      console.log(`Running ${executable} in isolated PostgreSQL database ${group}`);
      const groupUrl = databaseUrl(config.baseUrl, group);
      exitCode = await run(executable, commandArgs, {
        ...Deno.env.toObject(),
        DATABASE_URL: groupUrl,
        TEST_DATABASE_URL: groupUrl,
      });
    } finally {
      await dropOwnedDatabase(admin, config, group);
    }
    return exitCode;
  } finally {
    await admin.end();
  }
}

if (import.meta.main) Deno.exit(await main());
