import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.14";
import { assertSafeLoadTarget, loadProfile } from "./safety.ts";

const safe = {
  allowDestructive: "true",
  baseUrl: "http://127.0.0.1:18080",
  databaseUrl: "postgresql://dgchat:password@127.0.0.1:15432/dgchat_load_a1",
  projectName: "dg-chat-load-a1",
  artifactDirectory: "/repo/test-results/load/a1",
  repositoryRoot: "/repo",
};

Deno.test("load target safety accepts only the disposable loopback namespace", () => {
  assertEquals(assertSafeLoadTarget(safe), undefined);
});

Deno.test("load target safety requires exact destructive opt-in", () => {
  for (const value of [undefined, "", "TRUE", "1"]) {
    assertThrows(
      () => assertSafeLoadTarget({ ...safe, allowDestructive: value }),
      Error,
      "DG_CHAT_LOAD_ALLOW_DESTRUCTIVE=true",
    );
  }
});

Deno.test("load target safety rejects remote or credential-bearing application targets", () => {
  for (
    const baseUrl of [
      "https://chat.example.test",
      "http://user:secret@127.0.0.1:18080",
      "file:///tmp/socket",
    ]
  ) {
    assertThrows(
      () => assertSafeLoadTarget({ ...safe, baseUrl }),
      Error,
      "credential-free loopback HTTP",
    );
  }
});

Deno.test("load target safety rejects foreign projects, databases, hosts, and artifact paths", () => {
  const unsafe = [
    { projectName: "dg-chat" },
    { projectName: "dg-chat-load-../../prod" },
    { databaseUrl: "postgresql://u:p@127.0.0.1:5432/dgchat" },
    { databaseUrl: "postgresql://u:p@db.example.test:5432/dgchat_load_a1" },
    { artifactDirectory: "/tmp/load" },
    { artifactDirectory: "/repo/test-results/load/../outside" },
  ];
  for (const patch of unsafe) {
    assertThrows(() => assertSafeLoadTarget({ ...safe, ...patch }), Error, "Refusing load test");
  }
});

Deno.test("load profiles stay bounded and reject accidental unbounded names", () => {
  assertEquals(loadProfile("ci"), {
    streams: 6,
    editContenders: 12,
    accountingAttempts: 12,
    accountingSlots: 4,
    queueJobs: 100,
    mixedQueueJobs: 12,
    timeoutSeconds: 720,
  });
  assertEquals(loadProfile("scheduled").queueJobs, 500);
  assertThrows(() => loadProfile("unlimited"), Error, "ci, standard, or scheduled");
});

Deno.test("load topology keeps published dependencies on a disposable host bridge", async () => {
  const compose = await Deno.readTextFile(
    new URL("../../docker-compose.load.yml", import.meta.url),
  );
  assertStringIncludes(
    compose,
    'ports: !override\n      - "127.0.0.1:${LOAD_WEB_HOST_PORT:',
    "the public web proxy must replace the production binding with a loopback-only port",
  );
  for (const service of ["postgres", "mock-provider", "prometheus"]) {
    const serviceStart = compose.indexOf(`  ${service}:\n`);
    assertEquals(serviceStart >= 0, true, `${service} service must exist`);
    const following = compose.slice(serviceStart + 1);
    const nextBlock = following.search(/\n(?:[ ]{2}[a-z][a-z0-9-]*:|networks:)\n/u);
    const serviceBlock = nextBlock < 0 ? following : following.slice(0, nextBlock);
    assertStringIncludes(
      serviceBlock,
      "      - load-host",
      `${service} must join load-host so its loopback-published port is reachable`,
    );
  }
  assertStringIncludes(compose, "  load-host:\n    driver: bridge");
});

Deno.test("chaos markers prove live work and bind faults to real claim owners", async () => {
  const runner = await Deno.readTextFile(new URL("./runner.ts", import.meta.url));
  const script = await Deno.readTextFile(new URL("./run.sh", import.meta.url));
  assertStringIncludes(runner, "activeStreams: currentlyOpen");
  assertStringIncludes(runner, "onOpen:");
  assertStringIncludes(runner, "onClose:");
  assertStringIncludes(runner, "NEW.status IN ('running','completed')");
  assertStringIncludes(runner, "PERFORM pg_sleep(3)");
  assertStringIncludes(runner, "every non-target backlog job is held behind the crash target");
  assertStringIncludes(
    script,
    'dg_chat_http_requests_in_flight{job="dg-chat-api",method="POST",route="api"} > 0',
  );
  assertStringIncludes(script, "activeMetricInstance");
  assertStringIncludes(script, "cat /tmp/dg-chat-worker-instance");
  assertStringIncludes(script, "status='running'");
  assertStringIncludes(script, "bounded_host_command 30");
  assertStringIncludes(script, "bounded_host_command 75");
  assertStringIncludes(script, "worker-chaos-diagnostics.log");
  assertStringIncludes(script, ".worker-chaos-complete.$$.tmp");
  assertStringIncludes(runner, 'waitForFile("worker-chaos-complete.json", 240_000)');
});
