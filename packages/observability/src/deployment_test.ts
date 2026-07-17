import { assertMatch, assertNotMatch } from "jsr:@std/assert@1.0.16";

Deno.test("Compose keeps per-replica exporters private and starts monitoring before health", async () => {
  const root = new URL("../../../", import.meta.url);
  const compose = await Deno.readTextFile(new URL("docker-compose.yml", root));
  const prometheus = await Deno.readTextFile(new URL("deploy/prometheus/prometheus.yml", root));
  const alerts = await Deno.readTextFile(new URL("deploy/prometheus/alerts.yml", root));
  const dockerfile = await Deno.readTextFile(new URL("Dockerfile", root));
  const acceptance = await Deno.readTextFile(
    new URL("tests/assert-observability-profile.sh", root),
  );
  const workflow = await Deno.readTextFile(new URL(".github/workflows/ci.yml", root));
  assertMatch(compose, /METRICS_HOST: 0\.0\.0\.0/u);
  assertMatch(compose, /profiles: \["observability"\]/u);
  assertMatch(compose, /OTEL_DENO: "false"/u);
  assertMatch(compose, /DG_CHAT_OTEL_ENABLED:/u);
  assertMatch(
    prometheus,
    /names: \["api-metrics"\][\s\S]*?type: A[\s\S]*?port: 9090/u,
  );
  assertMatch(
    prometheus,
    /names: \["worker-metrics"\][\s\S]*?type: A[\s\S]*?port: 9091/u,
  );
  assertMatch(alerts, /alert: DgChatQueueStalled/u);
  assertMatch(
    alerts,
    /max by \(status\) \(dg_chat_job_queue_oldest_seconds\{status="queued"\}\)/u,
  );
  assertMatch(alerts, /alert: DgChatDependencyUnavailable/u);
  assertMatch(
    alerts,
    /alert: DgChatHttpResponseBodyFailures[\s\S]*?dg_chat_http_response_lifecycle_total\{outcome="failed"\}/u,
  );
  assertMatch(
    alerts,
    /alert: DgChatApiTargetsAbsent[\s\S]*?expr: absent\(up\{job="dg-chat-api"\} == 1\)/u,
  );
  assertMatch(
    alerts,
    /alert: DgChatWorkerTargetsAbsent[\s\S]*?expr: absent\(up\{job="dg-chat-worker"\} == 1\)/u,
  );
  assertMatch(dockerfile, /location ~ \^\/metrics/u);
  assertNotMatch(compose, /API_METRICS_PORT|WORKER_METRICS_PORT|METRICS_PORT:/u);
  assertMatch(compose, /aliases:\s+- api-metrics/u);
  assertMatch(compose, /aliases:\s+- worker-metrics/u);
  const prometheusService = compose.slice(compose.indexOf("\n  prometheus:"));
  assertNotMatch(prometheusService, /depends_on:/u);
  assertNotMatch(prometheusService, /--web\.enable-lifecycle/u);
  assertMatch(acceptance, /--scale app=2 --scale worker=2/u);
  assertMatch(acceptance, /stop worker/u);
  assertMatch(acceptance, /wait_for_active_target_count "dg-chat-worker" "0"/u);
  assertMatch(acceptance, /sum\(up\{job="dg-chat-worker"\}\) or vector\(0\)/u);
  assertMatch(workflow, /Start monitoring before application containers/u);
  assertMatch(workflow, /assert-observability-profile\.sh/u);
  assertMatch(workflow, /promtool[\s\S]*?check config[\s\S]*?promtool[\s\S]*?check rules/u);
});
