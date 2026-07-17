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

  const duplicatePort = await preflight({
    DG_CHAT_LOAD_ALLOW_DESTRUCTIVE: "true",
    LOAD_WEB_HOST_PORT: "18080",
    LOAD_POSTGRES_HOST_PORT: "18080",
  });
  assertEquals(duplicatePort.code, 2);
  assertStringIncludes(duplicatePort.stderr, "ports must differ");
});

Deno.test("host orchestration commands terminate at their own wall-clock bound", async () => {
  const artifactDirectory = await Deno.makeTempDir({ prefix: "dg-chat-host-command-" });
  try {
    const command = new Deno.Command("bash", {
      args: [
        "-c",
        'source "$1"; export LOAD_ARTIFACT_DIR="$2"; bounded_host_command 1 "stalled probe" ' +
        "bash -c 'while :; do :; done'",
        "_",
        `${root}/tests/load/host-commands.sh`,
        artifactDirectory,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const started = performance.now();
    const output = await command.output();
    const elapsedMs = performance.now() - started;
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 124, stderr);
    assertEquals(elapsedMs < 4_000, true, `bounded command took ${Math.round(elapsedMs)}ms`);
    assertStringIncludes(stderr, "Host operation timed out after 1s: stalled probe");
    const operations = await Deno.readTextFile(`${artifactDirectory}/host-operations.log`);
    assertStringIncludes(operations, "timeout stalled probe");
  } finally {
    await Deno.remove(artifactDirectory, { recursive: true });
  }
});
