import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";

const root = new URL("../../", import.meta.url).pathname.replace(/\/$/u, "");

async function preflight(patch: Record<string, string>) {
  const command = new Deno.Command("bash", {
    args: ["tests/load/run.sh", "--preflight-only"],
    cwd: root,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      LOAD_RUN_ID: "script-test",
      LOAD_ARTIFACT_DIR: `${root}/test-results/load/script-test`,
      ...patch,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("load runner script fails closed without destructive opt-in before Docker", async () => {
  const result = await preflight({});
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, "DG_CHAT_LOAD_ALLOW_DESTRUCTIVE=true");
});

Deno.test("load runner script validates its disposable target without invoking Docker", async () => {
  const result = await preflight({ DG_CHAT_LOAD_ALLOW_DESTRUCTIVE: "true", LOAD_PROFILE: "ci" });
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "Load harness preflight passed");
});

Deno.test("load runner script rejects invalid profiles and privileged ports", async () => {
  const invalidProfile = await preflight({
    DG_CHAT_LOAD_ALLOW_DESTRUCTIVE: "true",
    LOAD_PROFILE: "forever",
  });
  assertEquals(invalidProfile.code, 2);
  assertStringIncludes(invalidProfile.stderr, "ci, standard, or scheduled");

  const invalidPort = await preflight({
    DG_CHAT_LOAD_ALLOW_DESTRUCTIVE: "true",
    LOAD_WEB_HOST_PORT: "80",
  });
  assertEquals(invalidPort.code, 2);
  assertStringIncludes(invalidPort.stderr, "unprivileged TCP port");
});
