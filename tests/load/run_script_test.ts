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
    const childPidPath = `${artifactDirectory}/term-resistant-child.pid`;
    const command = new Deno.Command("bash", {
      args: [
        "-c",
        'source "$1"; export LOAD_ARTIFACT_DIR="$2"; bounded_host_command 2 "stalled probe" ' +
        `bash -c 'bash -c '\\''trap "" TERM; while :; do sleep 1; done'\\'' & ` +
        `child=$!; printf "%s\\\\n" "$child" > "$3"; wait "$child"' ` +
        `_ ignored ignored "$3"`,
        "_",
        `${root}/tests/load/host-commands.sh`,
        artifactDirectory,
        childPidPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const started = performance.now();
    const output = await command.output();
    const elapsedMs = performance.now() - started;
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 124, stderr);
    assertEquals(elapsedMs < 6_000, true, `bounded command took ${Math.round(elapsedMs)}ms`);
    assertStringIncludes(stderr, "Host operation timed out after 2s: stalled probe");
    const operations = await Deno.readTextFile(`${artifactDirectory}/host-operations.log`);
    assertStringIncludes(operations, "timeout stalled probe");
    const childPid = (await Deno.readTextFile(childPidPath)).trim();
    assertEquals(/^[1-9][0-9]*$/u.test(childPid), true, "child pid was not recorded");
    let childStillRunning = true;
    const processDeadline = performance.now() + 2_000;
    while (performance.now() < processDeadline) {
      const probe = await new Deno.Command("bash", {
        args: [
          "-c",
          'kill -0 "$1" 2>/dev/null || exit 1; ' +
          'state="$(ps -p "$1" -o stat= 2>/dev/null)" || exit 1; ' +
          'case "$state" in *Z*) exit 1;; esac',
          "_",
          childPid,
        ],
        stdout: "null",
        stderr: "null",
      }).output();
      if (probe.code !== 0) {
        childStillRunning = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertEquals(childStillRunning, false, `descendant process ${childPid} survived timeout`);
  } finally {
    await Deno.remove(artifactDirectory, { recursive: true });
  }
});
