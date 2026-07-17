import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
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
