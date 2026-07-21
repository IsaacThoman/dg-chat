import { assertSafeLoadTarget, loadProfile } from "./safety.ts";

const env = Deno.env.toObject();
loadProfile(env.LOAD_PROFILE ?? "ci");
assertSafeLoadTarget({
  allowDestructive: env.DG_CHAT_LOAD_ALLOW_DESTRUCTIVE,
  baseUrl: env.LOAD_BASE_URL ?? "",
  databaseUrl: env.LOAD_DATABASE_URL ?? "",
  projectName: env.COMPOSE_PROJECT_NAME ?? "",
  artifactDirectory: env.LOAD_ARTIFACT_DIR ?? "",
  repositoryRoot: env.LOAD_REPOSITORY_ROOT ?? Deno.cwd(),
});
console.log("Load harness preflight passed.");
