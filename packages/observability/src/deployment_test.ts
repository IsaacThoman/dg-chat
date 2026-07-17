import { assertMatch, assertNotMatch } from "jsr:@std/assert@1.0.16";

Deno.test("Compose keeps service exporters private and Prometheus scrapes both internal listeners", async () => {
  const root = new URL("../../../", import.meta.url);
  const compose = await Deno.readTextFile(new URL("docker-compose.yml", root));
  const prometheus = await Deno.readTextFile(new URL("deploy/prometheus/prometheus.yml", root));
  const alerts = await Deno.readTextFile(new URL("deploy/prometheus/alerts.yml", root));
  const dockerfile = await Deno.readTextFile(new URL("Dockerfile", root));
  assertMatch(compose, /METRICS_HOST: 0\.0\.0\.0/u);
  assertMatch(compose, /profiles: \["observability"\]/u);
  assertMatch(compose, /OTEL_DENO: "false"/u);
  assertMatch(compose, /DG_CHAT_OTEL_ENABLED:/u);
  assertMatch(prometheus, /targets: \["app:9090"\]/u);
  assertMatch(prometheus, /targets: \["worker:9091"\]/u);
  assertMatch(alerts, /alert: DgChatQueueStalled/u);
  assertMatch(alerts, /alert: DgChatDependencyUnavailable/u);
  assertMatch(dockerfile, /location ~ \^\/metrics/u);
  assertNotMatch(compose, /- "\$\{API_METRICS_PORT/u);
  assertNotMatch(compose, /- "\$\{WORKER_METRICS_PORT/u);
});
