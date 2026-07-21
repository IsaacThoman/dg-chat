import postgres from "npm:postgres@3.4.7";
import { assertSafeLoadTarget, loadProfile } from "./safety.ts";
import {
  abortableDelay,
  consumeLiveSse,
  derivedTimeoutSignal,
  hostOrchestrationFailureMessage,
  percentile,
  retentionScrubRequest,
  type TimedSseFrame,
} from "./runtime.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type PhaseResult = {
  name: string;
  passed: boolean;
  durationMs: number;
  assertions: Record<string, Json>;
};
type Message = {
  id: string;
  parentId: string | null;
  supersedesId: string | null;
  siblingIndex: number;
  idempotencyKey: string;
  role: "user" | "assistant";
  content: string;
};
type Detail = {
  id: string;
  version: number;
  activeLeafId: string | null;
  messages: Message[];
};

const env = Deno.env.toObject();
const repositoryRoot = env.LOAD_REPOSITORY_ROOT ?? Deno.cwd();
const artifactDirectory = env.LOAD_ARTIFACT_DIR ?? `${repositoryRoot}/test-results/load/unknown`;
const baseUrl = env.LOAD_BASE_URL ?? "";
const databaseUrl = env.LOAD_DATABASE_URL ?? "";
const prometheusUrl = env.LOAD_PROMETHEUS_URL ?? "";
const mockControlUrl = env.LOAD_MOCK_CONTROL_URL ?? "";
const projectName = env.COMPOSE_PROJECT_NAME ?? "";
const profileName = env.LOAD_PROFILE ?? "ci";
const profile = loadProfile(profileName);

assertSafeLoadTarget({
  allowDestructive: env.DG_CHAT_LOAD_ALLOW_DESTRUCTIVE,
  baseUrl,
  databaseUrl,
  projectName,
  artifactDirectory,
  repositoryRoot,
});
for (const [name, value] of [["Prometheus", prometheusUrl], ["mock provider", mockControlUrl]]) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.replace(/^\[|\]$/gu, ""))
  ) throw new Error(`${name} load endpoint must use loopback HTTP`);
}

await Deno.mkdir(artifactDirectory, { recursive: true });
const rootController = new AbortController();
const rootTimer = setTimeout(
  () =>
    rootController.abort(
      new DOMException(`Load profile exceeded ${profile.timeoutSeconds}s`, "TimeoutError"),
    ),
  profile.timeoutSeconds * 1_000,
);
const signal = rootController.signal;
const startedAt = new Date();
const results: PhaseResult[] = [];
const sql = postgres(databaseUrl, {
  max: 12,
  connect_timeout: 10,
  idle_timeout: 5,
  max_lifetime: 120,
});
let cookie = "";
let userId = "";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Load invariant failed: ${message}`);
}

async function fetchBounded(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeoutSignal]);
  try {
    return await fetch(input, { ...init, signal: combined });
  } catch (error) {
    if (timeoutSignal.aborted && !signal.aborted) {
      throw new DOMException(`${label} timed out`, "TimeoutError");
    }
    throw error;
  }
}

async function jsonRequest<T>(
  path: string,
  init: RequestInit = {},
  expected: readonly number[] = [200],
): Promise<T> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  headers.set("origin", baseUrl);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetchBounded(
    new URL(path, baseUrl),
    { ...init, headers },
    45_000,
    `${init.method ?? "GET"} ${path}`,
  );
  const text = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) as T : undefined as T;
}

async function writeJsonArtifact(name: string, value: unknown): Promise<void> {
  const path = `${artifactDirectory}/${name}`;
  const temporary = `${artifactDirectory}/.${name}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined);
    throw error;
  }
}

async function phase(
  name: string,
  operation: () => Promise<Record<string, Json>>,
): Promise<void> {
  const before = performance.now();
  const assertions = await operation();
  results.push({
    name,
    passed: true,
    durationMs: Math.round(performance.now() - before),
    assertions,
  });
  await writeJsonArtifact("progress.json", { profile: profileName, phases: results });
}

async function waitForFile(
  name: string,
  timeoutMs: number,
  failureName?: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  const path = `${artifactDirectory}/${name}`;
  const failurePath = failureName ? `${artifactDirectory}/${failureName}` : undefined;
  let lastInvalidJson = "";
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    if (failurePath) {
      try {
        const failure = JSON.parse(await Deno.readTextFile(failurePath));
        throw new Error(hostOrchestrationFailureMessage(failure));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    try {
      const text = await Deno.readTextFile(path);
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          lastInvalidJson = "marker is not a JSON object";
        } else return value as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Host-side markers are published by a separate process. A legacy/non-atomic writer may
        // briefly expose a prefix, so wait for the bounded deadline instead of failing the entire
        // load run on a partial read.
        lastInvalidJson = error.message;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await abortableDelay(100, signal);
  }
  throw new Error(
    `Timed out waiting for host orchestration marker ${name}${
      lastInvalidJson ? `: ${lastInvalidJson.slice(0, 160)}` : ""
    }`,
  );
}

async function bootstrap(): Promise<void> {
  const status = await jsonRequest<{ bootstrapRequired: boolean }>("/api/setup/status");
  invariant(status.bootstrapRequired, "the load database must be a fresh installation");
  const email = `load-${crypto.randomUUID()}@load.invalid`;
  const password = "Load-Harness-Only-42!";
  const setup = await jsonRequest<{ user: { id: string } }>("/api/setup/bootstrap", {
    method: "POST",
    headers: { "x-setup-token": env.SETUP_TOKEN ?? "" },
    body: JSON.stringify({ email, password, name: "Disposable Load Administrator" }),
  }, [201]);
  userId = setup.user.id;
  const response = await fetchBounded(
    new URL("/api/auth/login", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email, password }),
    },
    45_000,
    "administrator login",
  );
  invariant(response.status === 200, `administrator login returned ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  invariant(cookie.length > 0, "administrator login did not return a session cookie");
  await response.body?.cancel();
}

async function createConversation(title: string): Promise<{ id: string; version: number }> {
  return await jsonRequest("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title }),
  }, [201]);
}

function webBody(
  content: string,
  idempotencyKey: string,
  expectedVersion: number,
  parentId: string | null = null,
  supersedesId: string | null = null,
) {
  return {
    mode: "send",
    parentId,
    supersedesId,
    content,
    model: "simulated/slow",
    expectedVersion,
    idempotencyKey,
    attachmentIds: [],
  };
}

function terminalFrame(frames: TimedSseFrame[]): TimedSseFrame | undefined {
  return frames.find((frame) =>
    ["generation.completed", "generation.stopped"].includes(String(frame.json?.type))
  );
}

async function openWebStream(
  conversationId: string,
  body: Record<string, unknown>,
  options: {
    slowReaderDelayMs?: number;
    disconnectAfterDataFrames?: number;
    onOpen?: () => void;
    onClose?: () => void;
  } = {},
) {
  const requestStarted = performance.now();
  const timeout = derivedTimeoutSignal(signal, 180_000, "web SSE");
  let opened = false;
  try {
    const response = await fetch(
      new URL(`/api/conversations/${conversationId}/generate/stream`, baseUrl),
      {
        method: "POST",
        headers: { cookie, origin: baseUrl, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: timeout.signal,
      },
    );
    const headerAtMs = performance.now() - requestStarted;
    if (response.status !== 200) {
      const text = await response.text();
      return {
        status: response.status,
        text,
        frames: [] as TimedSseFrame[],
        disconnected: false,
        headerAtMs,
        completedAtMs: headerAtMs,
      };
    }
    opened = true;
    options.onOpen?.();
    const live = await consumeLiveSse(response, {
      signal: timeout.signal,
      startedAtMs: requestStarted,
      headerAtMs,
      slowReaderDelayMs: options.slowReaderDelayMs,
      disconnectAfterDataFrames: options.disconnectAfterDataFrames,
    });
    return { status: response.status, text: "", ...live };
  } finally {
    if (opened) options.onClose?.();
    timeout.dispose();
  }
}

async function replayUntilTerminal(
  conversationId: string,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof openWebStream>>> {
  const deadline = Date.now() + 150_000;
  let last = "";
  while (Date.now() < deadline) {
    const result = await openWebStream(conversationId, body);
    if (result.status === 200 && terminalFrame(result.frames)) return result;
    invariant(
      result.status === 409 || result.status === 503,
      `interrupted stream replay returned unexpected ${result.status}`,
    );
    last = result.text;
    await abortableDelay(1_000, signal);
  }
  throw new Error(
    `Interrupted stream did not converge before its lease bound: ${last.slice(0, 120)}`,
  );
}

async function prometheusVector(query: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetchBounded(
    new URL(`/api/v1/query?query=${encodeURIComponent(query)}`, prometheusUrl),
    {},
    10_000,
    "Prometheus query",
  );
  invariant(response.ok, `Prometheus query returned ${response.status}`);
  const payload = await response.json() as {
    status: string;
    data: { result: Array<Record<string, unknown>> };
  };
  invariant(payload.status === "success", "Prometheus query succeeds");
  return payload.data.result;
}

async function waitForMetric(query: string, minimum: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await prometheusVector(query);
    if (result.length >= minimum) return result;
    await abortableDelay(500, signal);
  }
  throw new Error(`Prometheus did not expose ${minimum} series for ${query}`);
}

async function streamsPhase(): Promise<Record<string, Json>> {
  const conversations = await Promise.all(
    Array.from(
      { length: profile.streams },
      (_, index) => createConversation(`Load stream ${index + 1}`),
    ),
  );
  const bodies = conversations.map((_, index) =>
    webBody(
      `long-live-${index}-${"incremental frame ".repeat(70)}`,
      `load-stream-${index}-${crypto.randomUUID()}`,
      0,
    )
  );
  const started = performance.now();
  let currentlyOpen = 0;
  let maximumOpen = 0;
  const openConversationIds = new Set<string>();
  const attempts = bodies.map((body, index) =>
    openWebStream(conversations[index].id, body, {
      slowReaderDelayMs: index % 3 === 1 ? 150 : undefined,
      disconnectAfterDataFrames: index === 0 ? 3 : undefined,
      onOpen: () => {
        currentlyOpen++;
        maximumOpen = Math.max(maximumOpen, currentlyOpen);
        openConversationIds.add(conversations[index].id);
      },
      onClose: () => {
        currentlyOpen--;
        openConversationIds.delete(conversations[index].id);
      },
    }).catch((error) => ({
      status: 0,
      text: error instanceof Error ? error.message : "stream interrupted",
      frames: [] as TimedSseFrame[],
      disconnected: true,
      headerAtMs: 0,
      completedAtMs: 0,
    }))
  );
  // Do not publish the chaos marker while part of the bounded cohort is still negotiating. The
  // host uses per-replica in-flight gauges to prove both API replicas own live bodies before it
  // restarts one; publishing after only two opens made that proof race slower CI machines.
  const requiredOpen = profile.streams;
  const openDeadline = Date.now() + 30_000;
  while (currentlyOpen < requiredOpen && Date.now() < openDeadline) {
    await abortableDelay(25, signal);
  }
  invariant(
    currentlyOpen >= requiredOpen,
    `at least ${requiredOpen} response bodies are concurrently open before API chaos`,
  );
  await writeJsonArtifact("streams-active.json", {
    observedAt: new Date().toISOString(),
    activeStreams: currentlyOpen,
    maximumOpen,
    openConversationIds: [...openConversationIds],
  });
  const chaos = await waitForFile("api-chaos-complete.json", 60_000);
  invariant(typeof chaos.restartedContainer === "string", "host restarted one API container");
  invariant(
    typeof chaos.activeMetricInstance === "string" &&
      Number(chaos.activeRequestsBeforeRestart) >= 1 &&
      Number(chaos.activeReplicaCount) === 2,
    "host proved both API replicas owned streams and restarted one active replica",
  );
  const initial = await Promise.all(attempts);
  const replayed = await Promise.all(
    bodies.map((body, index) => replayUntilTerminal(conversations[index].id, body)),
  );
  invariant(
    replayed.every((result) => result.status === 200 && terminalFrame(result.frames)),
    "every stream converges durably after disconnect/restart",
  );
  invariant(
    replayed.every((result) =>
      result.frames.some((frame) => frame.json?.type === "response.text.delta")
    ),
    "every replay exposes durable response content",
  );
  const uninterrupted = initial.filter((result) => terminalFrame(result.frames));
  invariant(uninterrupted.length >= 1, "at least one live stream survives the rolling restart");
  const timed = initial.filter((result) =>
    result.frames.some((frame) => frame.json?.type === "response.text.delta")
  );
  const ttfts = timed.map((result) =>
    result.frames.find((frame) => frame.json?.type === "response.text.delta")!.atMs
  );
  invariant(percentile(ttfts, 0.95) <= 5_000, "stream p95 TTFT remains below five seconds");
  const gaps = timed.flatMap((result) => {
    const deltas = result.frames.filter((frame) => frame.json?.type === "response.text.delta");
    return deltas.slice(1).map((frame, index) => frame.atMs - deltas[index].atMs);
  });
  invariant(gaps.length > 0, "live parsing observes multiple separately timed frames");
  invariant(
    percentile(gaps, 0.99) <= 3_000,
    "stream p99 inter-frame gap remains below three seconds",
  );
  const details = await Promise.all(
    conversations.map(({ id }) => jsonRequest<Detail>(`/api/conversations/${id}`)),
  );
  invariant(
    details.every((detail) =>
      detail.messages.length === 2 &&
      ["complete", "stopped"].includes(
        String(
          (detail.messages.find((message) => message.role === "assistant") as unknown as {
            status?: string;
          })?.status ?? "complete",
        ),
      )
    ),
    "each stream has exactly one immutable user/assistant pair",
  );
  const stale = await sql<{ count: string }[]>`
    SELECT count(*)::text count FROM usage_runs
    WHERE user_id=${userId}::uuid AND
      (status='reserved' OR run_lease_token IS NOT NULL OR generation_lease_token IS NOT NULL)
  `;
  invariant(stale[0].count === "0", "stream drain leaves no reserved usage or generation leases");
  const apiTargets = await waitForMetric(
    'dg_chat_http_requests_total{job="dg-chat-api",route="health"} > 0',
    2,
  );
  const elapsedSeconds = (performance.now() - started) / 1_000;
  invariant(
    profile.streams / elapsedSeconds >= 0.02,
    "stream convergence throughput stays bounded",
  );
  return {
    streams: profile.streams,
    initiallyTerminal: uninterrupted.length,
    intentionalDisconnects: initial.filter((result) => result.disconnected).length,
    replayedToTerminal: replayed.length,
    apiTargetsWithTraffic: apiTargets.length,
    maximumConcurrentlyOpen: maximumOpen,
    restartedActiveMetricInstance: String(chaos.activeMetricInstance),
    p95TtftMs: Math.round(percentile(ttfts, 0.95)),
    p99InterFrameGapMs: Math.round(percentile(gaps, 0.99)),
    throughputPerSecond: Number((profile.streams / elapsedSeconds).toFixed(3)),
    rollingRestart: true,
  };
}

async function editsPhase(): Promise<Record<string, Json>> {
  const conversation = await createConversation("Hot immutable edit DAG");
  const originalContent = `hot-root-${crypto.randomUUID()}`;
  const seedBody = {
    ...webBody(originalContent, `load-edit-seed-${crypto.randomUUID()}`, 0),
    model: "simulated/dg-chat",
  };
  const seed = await openWebStream(conversation.id, seedBody);
  invariant(terminalFrame(seed.frames), "edit seed completes");
  const seeded = await jsonRequest<Detail>(`/api/conversations/${conversation.id}`);
  const original = seeded.messages.find((message) =>
    message.role === "user" && message.content === originalContent
  );
  invariant(original, "hot-row original exists");
  const contenders = Array.from({ length: profile.editContenders }, (_, index) => ({
    content: `contended-edit-${index}-${crypto.randomUUID()}`,
    key: `load-edit-hot-${index}-${crypto.randomUUID()}`,
  }));
  const started = performance.now();
  const firstWave = await Promise.all(contenders.map((contender) =>
    openWebStream(conversation.id, {
      ...webBody(
        contender.content,
        contender.key,
        seeded.version,
        original.parentId,
        original.id,
      ),
      model: "simulated/dg-chat",
    })
  ));
  invariant(
    firstWave.filter((result) => result.status === 200).length === 1,
    "exactly one same-version hot-row contender wins",
  );
  invariant(
    firstWave.filter((result) => result.status === 409).length === contenders.length - 1,
    "all stale first-wave contenders are version-fenced",
  );

  let retries = 0;
  for (let index = 0; index < contenders.length; index++) {
    if (firstWave[index].status === 200) continue;
    let converged = false;
    for (let attempt = 0; attempt < 6 && !converged; attempt++) {
      const current = await jsonRequest<Detail>(`/api/conversations/${conversation.id}`);
      const body = {
        ...webBody(
          contenders[index].content,
          contenders[index].key,
          current.version,
          original.parentId,
          original.id,
        ),
        model: "simulated/dg-chat",
      };
      const response = await openWebStream(conversation.id, body);
      retries++;
      if (response.status === 409) {
        await abortableDelay(10 * (attempt + 1), signal);
        continue;
      }
      invariant(terminalFrame(response.frames), "retried edit reaches a terminal SSE event");
      const versionBeforeReplay = (await jsonRequest<Detail>(
        `/api/conversations/${conversation.id}`,
      )).version;
      const replay = await openWebStream(conversation.id, body);
      invariant(
        replay.frames.some((frame) => frame.json?.replay === true),
        "accepted edit idempotency key replays without appending",
      );
      invariant(
        (await jsonRequest<Detail>(`/api/conversations/${conversation.id}`)).version ===
          versionBeforeReplay,
        "accepted edit replay leaves the exact graph version unchanged",
      );
      converged = true;
    }
    invariant(converged, "every optimistic conflict converges within bounded retries");
  }

  const graph = await jsonRequest<Detail>(`/api/conversations/${conversation.id}`);
  const expectedMessages = 2 + 2 * contenders.length;
  invariant(graph.messages.length === expectedMessages, "every converged branch appends two nodes");
  invariant(
    graph.version === seeded.version + 2 * contenders.length,
    "conversation version advances exactly once per appended immutable node",
  );
  invariant(
    graph.messages.filter((message) => message.supersedesId === original.id).length ===
      contenders.length,
    "every edit is a recoverable sibling that supersedes the original",
  );
  invariant(
    graph.messages.some((message) =>
      message.id === original.id && message.content === originalContent
    ),
    "hot-row contention never removes or rewrites the original",
  );
  invariant(
    graph.messages.some((message) => message.id === graph.activeLeafId),
    "the active leaf is a persisted graph node",
  );
  const dag = await sql<{
    dangling: string;
    cyclic: string;
    sibling_gaps: string;
    duplicate_keys: string;
  }[]>`
    WITH RECURSIVE ancestry AS (
      SELECT id,parent_id,ARRAY[id] path,false cyclic FROM messages
      WHERE conversation_id=${conversation.id}::uuid
      UNION ALL
      SELECT m.id,m.parent_id,a.path||m.id,m.id=ANY(a.path)
      FROM ancestry a JOIN messages m ON m.id=a.parent_id
      WHERE NOT a.cyclic
    ), sibling_groups AS (
      SELECT parent_id,count(*) count,min(sibling_index) minimum,max(sibling_index) maximum
      FROM messages WHERE conversation_id=${conversation.id}::uuid GROUP BY parent_id
    )
    SELECT
      (SELECT count(*) FROM messages m WHERE m.conversation_id=${conversation.id}::uuid
        AND m.parent_id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM messages p WHERE p.id=m.parent_id))::text dangling,
      (SELECT count(*) FROM ancestry WHERE cyclic)::text cyclic,
      (SELECT count(*) FROM sibling_groups
        WHERE minimum<>0 OR maximum<>count-1)::text sibling_gaps,
      (SELECT count(*)-count(DISTINCT idempotency_key) FROM messages
        WHERE conversation_id=${conversation.id}::uuid)::text duplicate_keys
  `;
  invariant(
    Object.values(dag[0]).every((value) => value === "0"),
    "DAG has no cycles, dangling parents, sibling gaps, or duplicate idempotency keys",
  );
  const elapsedSeconds = (performance.now() - started) / 1_000;
  invariant(
    contenders.length / elapsedSeconds >= 0.25,
    "contended edit convergence sustains at least 0.25 branches/second",
  );
  return {
    contenders: contenders.length,
    initialWinner: 1,
    initialConflicts: contenders.length - 1,
    boundedRetries: retries,
    finalMessages: graph.messages.length,
    finalVersion: graph.version,
    dagValidated: true,
    throughputPerSecond: Number((contenders.length / elapsedSeconds).toFixed(3)),
  };
}

async function mockState(): Promise<{
  attempts: Record<string, number>;
  scenarios: Record<string, { opened: number; completed: number; aborted: number }>;
  chatBarrier: {
    model: string;
    target: number;
    opened: number;
    released: boolean;
  } | null;
}> {
  const response = await fetchBounded(
    new URL("/__test/state", mockControlUrl),
    { headers: { authorization: `Bearer ${env.MOCK_PROVIDER_CONTROL_TOKEN}` } },
    10_000,
    "mock provider state",
  );
  invariant(response.ok, "mock provider state request succeeds");
  return await response.json();
}

async function accountingPhase(): Promise<Record<string, Json>> {
  const token = await jsonRequest<{ id: string; token: string }>("/api/tokens", {
    method: "POST",
    body: JSON.stringify({
      name: "Scarce-credit load token",
      scopes: ["models:read", "chat:write"],
      rpmLimit: 1_000,
      burstLimit: 1_000,
    }),
  }, [201]);
  const messages = [{
    role: "user",
    content: `scarce-credit ${"hold reservation ".repeat(40)}`,
  }];
  const maximumOutput = 32;
  const calibrationBody = {
    model: "openai/mock-slow",
    messages,
    max_tokens: maximumOutput,
    stream: true,
    stream_options: { include_usage: true },
  };
  // A Chat stream reserves its worst-case replay envelope (roughly 50 MiB at the default
  // provider/event bounds). The default per-user replay quota intentionally admits only one
  // such envelope at a time, so streaming contenders would exercise replay admission before
  // scarce-credit admission. Buffered Chat replay reservations are bounded to roughly 4 MiB;
  // all CI contenders fit under the same production replay quota and therefore reach the
  // atomic credit boundary this phase is designed to verify.
  const contentionBody = {
    model: "openai/mock-slow",
    messages,
    max_tokens: maximumOutput,
    stream: false,
  };
  const calibrationKey = `load-reservation-calibration-${crypto.randomUUID()}`;
  const calibration = await fetchBounded(
    new URL("/v1/chat/completions", baseUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
        "content-type": "application/json",
        "idempotency-key": calibrationKey,
      },
      body: JSON.stringify(calibrationBody),
    },
    90_000,
    "reservation calibration",
  );
  invariant(calibration.status === 200, "reservation calibration dispatch begins");
  const calibrated = await sql<{ run_id: string; reserved: string }[]>`
    SELECT r.id run_id,(-l.amount_micros)::text reserved
    FROM api_idempotency_requests a JOIN usage_runs r ON r.id=a.usage_run_id
    JOIN ledger_entries l ON l.usage_run_id=r.id AND l.kind='reserve'
    WHERE a.user_id=${userId}::uuid AND a.endpoint='chat.completions'
      AND a.idempotency_key=${calibrationKey}
  `;
  invariant(
    calibrated.length === 1 && Number(calibrated[0].reserved) > 0,
    "calibration observes the exact durable reservation",
  );
  const reservationMicros = Number(calibrated[0].reserved);
  await calibration.body?.cancel("reservation calibration complete");
  const calibrationDeadline = Date.now() + 30_000;
  while (Date.now() < calibrationDeadline) {
    const terminal = await sql<{ status: string }[]>`
      SELECT status FROM usage_runs WHERE id=${calibrated[0].run_id}
    `;
    if (terminal[0]?.status !== "reserved") break;
    await abortableDelay(100, signal);
  }
  invariant(
    (await sql<{ status: string }[]>`
      SELECT status FROM usage_runs WHERE id=${calibrated[0].run_id}
    `)[0].status !== "reserved",
    "calibration cancellation reaches terminal accounting",
  );
  const reset = await fetchBounded(
    new URL("/__test/reset", mockControlUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.MOCK_PROVIDER_CONTROL_TOKEN}` },
    },
    10_000,
    "mock provider reset",
  );
  invariant(reset.ok, "mock provider reset succeeds after calibration");
  await reset.body?.cancel();
  const desiredBalance = reservationMicros * profile.accountingSlots;
  const current = await sql<{ balance_micros: string }[]>`
    SELECT balance_micros::text FROM users WHERE id=${userId}::uuid
  `;
  await jsonRequest(`/api/admin/users/${userId}/balance-adjustments`, {
    method: "POST",
    headers: { "idempotency-key": `load-scarce-balance-${crypto.randomUUID()}` },
    body: JSON.stringify({
      amountMicros: desiredBalance - Number(current[0].balance_micros),
      expectedBalanceMicros: Number(current[0].balance_micros),
      reason: "Disposable scarce-credit contention boundary",
    }),
  });
  const configuredBarrier = await fetchBounded(
    new URL("/__test/chat-barrier", mockControlUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.MOCK_PROVIDER_CONTROL_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "mock-slow", target: profile.accountingSlots }),
    },
    10_000,
    "mock provider chat barrier configuration",
  );
  invariant(configuredBarrier.ok, "mock provider scarce-credit barrier is configured");
  await configuredBarrier.body?.cancel();
  const boundary = await sql<{ boundary: Date; sequence: string }[]>`
    SELECT clock_timestamp() boundary,
      COALESCE((SELECT max(sequence) FROM ledger_entries WHERE user_id=${userId}::uuid),0)::text
        sequence
  `;
  const keys = Array.from(
    { length: profile.accountingAttempts },
    (_, index) => `load-scarce-${index}-${crypto.randomUUID()}`,
  );
  const started = performance.now();
  type ContentionResponse = {
    key: string;
    status: number;
    body: string;
    replay: string | null;
  };
  const observedResponses: ContentionResponse[] = [];
  const responsePromises = keys.map(async (key): Promise<ContentionResponse> => {
    const response = await fetchBounded(
      new URL("/v1/chat/completions", baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(contentionBody),
      },
      90_000,
      "scarce-credit completion",
    );
    const body = await response.text();
    const result = {
      key,
      status: response.status,
      body,
      replay: response.headers.get("x-idempotent-replay"),
    };
    observedResponses.push(result);
    return result;
  });
  const admissionDeadline = Date.now() + 30_000;
  let admissionBoundaryObserved = false;
  try {
    while (Date.now() < admissionDeadline) {
      const state = await mockState();
      const deniedSoFar = observedResponses.filter((response) => response.status === 402).length;
      if (
        state.chatBarrier?.opened === profile.accountingSlots &&
        deniedSoFar === profile.accountingAttempts - profile.accountingSlots
      ) {
        admissionBoundaryObserved = true;
        break;
      }
      await abortableDelay(50, signal);
    }
  } finally {
    const releasedBarrier = await fetchBounded(
      new URL("/__test/chat-barrier/release", mockControlUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.MOCK_PROVIDER_CONTROL_TOKEN}` },
      },
      10_000,
      "mock provider chat barrier release",
    );
    invariant(releasedBarrier.ok, "mock provider scarce-credit barrier is released");
    await releasedBarrier.body?.cancel();
  }
  invariant(
    admissionBoundaryObserved,
    "every scarce-credit contender receives an admission decision before settlement",
  );
  const responses = await Promise.all(responsePromises);
  const accepted = responses.filter((response) => response.status === 200);
  const denied = responses.filter((response) => response.status === 402);
  const responseDistribution = Object.fromEntries(
    Array.from(
      Map.groupBy(responses, (response) => {
        try {
          const parsed = JSON.parse(response.body) as { error?: { code?: string } };
          return `${response.status}:${parsed.error?.code ?? "success"}`;
        } catch {
          return `${response.status}:invalid_json`;
        }
      }),
      ([key, values]) => [key, values.length],
    ),
  );
  invariant(
    accepted.length === profile.accountingSlots,
    `scarce credit admits exactly the configured reservation slots (${
      JSON.stringify(responseDistribution)
    })`,
  );
  invariant(
    denied.length === profile.accountingAttempts - profile.accountingSlots,
    "all excess contenders receive insufficient credit",
  );
  invariant(
    denied.every((response) => {
      try {
        return (JSON.parse(response.body) as { error?: { code?: string } }).error?.code ===
          "insufficient_credit";
      } catch {
        return false;
      }
    }),
    "every denied contender carries the OpenAI insufficient_credit error",
  );
  const dispatched = await mockState();
  invariant(
    dispatched.attempts["mock-slow"] === accepted.length,
    "only admitted requests dispatch upstream",
  );
  for (const acceptedRequest of accepted) {
    const replays = await Promise.all(Array.from({ length: 3 }, () =>
      fetchBounded(
        new URL("/v1/chat/completions", baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.token}`,
            "content-type": "application/json",
            "idempotency-key": acceptedRequest.key,
          },
          body: JSON.stringify(contentionBody),
        },
        30_000,
        "accepted-key replay",
      )));
    invariant(
      replays.every((response) =>
        response.status === 200 && response.headers.get("x-idempotent-replay") === "true"
      ),
      "every accepted key replays its exact terminal response",
    );
    await Promise.all(replays.map((response) => response.body?.cancel()));
  }
  invariant(
    (await mockState()).attempts["mock-slow"] === accepted.length,
    "accepted-key replay never redispatches upstream",
  );
  const runs = await sql<{
    id: string;
    status: string;
    cost_micros: string;
    reserves: string;
    terminals: string;
  }[]>`
    SELECT r.id,r.status,r.cost_micros::text,
      count(l.id) FILTER(WHERE l.kind='reserve')::text reserves,
      count(l.id) FILTER(WHERE l.kind IN ('settle','refund'))::text terminals
    FROM usage_runs r LEFT JOIN ledger_entries l ON l.usage_run_id=r.id
    WHERE r.user_id=${userId}::uuid AND r.token_id=${token.id}::uuid
      AND r.created_at >= ${boundary[0].boundary}
    GROUP BY r.id,r.status,r.cost_micros
  `;
  invariant(runs.length === accepted.length, "denied contenders create no usage run");
  invariant(
    runs.every((run) =>
      run.status === "completed" && run.reserves === "1" && run.terminals === "1"
    ),
    "every dispatch has one reserve and one terminal settlement",
  );
  const ledger = await sql<{
    balance: string;
    minimum: string;
    delta: string;
    entries: string;
    min_sequence: string;
    max_sequence: string;
  }[]>`
    SELECT u.balance_micros::text balance,
      (SELECT min(balance_after_micros)::text FROM ledger_entries WHERE user_id=u.id) minimum,
      (SELECT COALESCE(sum(amount_micros),0)::text FROM ledger_entries
        WHERE user_id=u.id AND sequence>${Number(boundary[0].sequence)}) delta,
      (SELECT count(*)::text FROM ledger_entries
        WHERE user_id=u.id AND sequence>${Number(boundary[0].sequence)}) entries,
      (SELECT min(sequence)::text FROM ledger_entries
        WHERE user_id=u.id AND sequence>${Number(boundary[0].sequence)}) min_sequence,
      (SELECT max(sequence)::text FROM ledger_entries
        WHERE user_id=u.id AND sequence>${Number(boundary[0].sequence)}) max_sequence
    FROM users u WHERE u.id=${userId}::uuid
  `;
  invariant(Number(ledger[0].minimum) >= 0, "scarce-credit contention never overspends");
  invariant(
    Number(ledger[0].max_sequence) - Number(ledger[0].min_sequence) + 1 ===
      Number(ledger[0].entries),
    "high-contention ledger sequences are gap-free",
  );
  const usage = await jsonRequest<{
    balanceMicros: number;
    calls: number;
    spentMicros: number;
  }>("/api/usage");
  const sqlUsage = await sql<{ calls: string; spent: string; balance: string }[]>`
    SELECT count(*) FILTER(WHERE status='completed' OR cost_micros>0)::text calls,
      COALESCE(sum(cost_micros) FILTER(WHERE status='completed' OR cost_micros>0),0)::text spent,
      (SELECT balance_micros::text FROM users WHERE id=${userId}::uuid) balance
    FROM usage_runs WHERE user_id=${userId}::uuid
  `;
  invariant(
    usage.calls === Number(sqlUsage[0].calls) &&
      usage.spentMicros === Number(sqlUsage[0].spent) &&
      usage.balanceMicros === Number(sqlUsage[0].balance),
    "per-user API usage exactly matches SQL aggregates",
  );
  const admin = await jsonRequest<{ calls: number; users: number; balanceMicros: number }>(
    "/api/admin/usage",
  );
  const sqlAdmin = await sql<{ calls: string; users: string; balance: string }[]>`
    SELECT (SELECT count(*) FROM usage_runs)::text calls,
      (SELECT count(*) FROM users)::text users,
      (SELECT COALESCE(sum(balance_micros),0) FROM users)::text balance
  `;
  invariant(
    admin.calls === Number(sqlAdmin[0].calls) &&
      admin.users === Number(sqlAdmin[0].users) &&
      admin.balanceMicros === Number(sqlAdmin[0].balance),
    "administrator API summary exactly matches global SQL aggregates",
  );
  const elapsedSeconds = (performance.now() - started) / 1_000;
  invariant(
    profile.accountingAttempts / elapsedSeconds >= 0.5,
    "scarce-credit dispatch sustains at least 0.5 decisions/second",
  );
  return {
    attempts: profile.accountingAttempts,
    admitted: accepted.length,
    insufficientCredit: denied.length,
    upstreamDispatches: accepted.length,
    acceptedKeyReplays: accepted.length * 3,
    nonnegativeBalance: true,
    aggregateReconciliation: true,
    throughputPerSecond: Number((profile.accountingAttempts / elapsedSeconds).toFixed(3)),
  };
}

async function queuePhase(): Promise<Record<string, Json>> {
  const policy = await jsonRequest<{ version: number }>("/api/admin/retention/policy");
  const preview = await jsonRequest<{
    policyVersion: number;
    requestCutoffAt: string;
    responseCutoffAt: string;
  }>("/api/admin/retention/previews", {
    method: "POST",
    body: JSON.stringify({ expectedPolicyVersion: policy.version }),
  });
  const queueBoundary = await sql<{ boundary: Date }[]>`SELECT clock_timestamp() boundary`;
  await sql`CREATE SEQUENCE load_crash_once_seq`;
  const runs = await Promise.all(
    Array.from(
      { length: profile.queueJobs },
      (_, index) =>
        jsonRequest<{ id: string; status: string }>("/api/admin/retention/scrub-runs", {
          method: "POST",
          body: JSON.stringify(
            retentionScrubRequest(
              preview,
              `load-backlog-${index}-${crypto.randomUUID()}`,
            ),
          ),
        }, [202]),
    ),
  );
  const crashRun = runs[0];
  const crashJob = await sql<{ id: string }[]>`
    SELECT id::text FROM jobs WHERE idempotency_key=${`retention.scrub:${crashRun.id}`}
  `;
  invariant(crashJob.length === 1, "crash target has one durable job");
  await sql.unsafe(`
    CREATE FUNCTION load_crash_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id='${crashRun.id}'::uuid AND OLD.status='queued'
         AND NEW.status IN ('running','completed')
         AND nextval('load_crash_once_seq')=1 THEN
        -- Stay below the worker's real statement_timeout. The host observes claims immediately
        -- after process start, so this is long enough to kill the owner without turning the
        -- intended process crash into a synthetic statement-timeout retry.
        PERFORM pg_sleep(3);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER load_crash_once_trigger BEFORE UPDATE ON retention_scrub_runs
      FOR EACH ROW EXECUTE FUNCTION load_crash_once();
  `);
  const mixed = Array.from({ length: profile.mixedQueueJobs }, () => ({
    id: crypto.randomUUID(),
    stageId: crypto.randomUUID(),
    key: `load-mixed-${crypto.randomUUID()}`,
  }));
  for (const item of mixed) {
    await sql`
      INSERT INTO jobs(id,type,payload,status,available_at,idempotency_key)
      VALUES(${item.id}::uuid,'generated_object.cleanup',
        ${sql.json({ stageId: item.stageId, ownerId: userId })},'queued',now(),${item.key})
    `;
  }
  const deferredBacklogKeys = [
    ...runs.slice(1).map((run) => `retention.scrub:${run.id}`),
    ...mixed.map((item) => item.key),
  ];
  const deferredBacklog = await sql<{ id: string }[]>`
    UPDATE jobs SET available_at=clock_timestamp()+interval '15 seconds'
    WHERE idempotency_key=ANY(${deferredBacklogKeys}::text[])
    RETURNING id::text
  `;
  invariant(
    deferredBacklog.length === runs.length - 1 + mixed.length,
    "every non-target backlog job is held behind the crash target",
  );
  const prioritizedCrashTarget = await sql<{ id: string }[]>`
    UPDATE jobs SET available_at=clock_timestamp()
    WHERE id=${crashJob[0].id}::uuid AND status='queued'
    RETURNING id::text
  `;
  invariant(
    prioritizedCrashTarget.length === 1,
    "the crash target is the unique immediately available backlog job",
  );
  await writeJsonArtifact("queue-enqueued.json", {
    crashRunId: crashRun.id,
    crashJobId: crashJob[0].id,
    retentionJobs: runs.length,
    mixedJobs: mixed.length,
    deferredBehindCrashTarget: deferredBacklog.length,
  });
  // The host keeps the actual claim observation strict (45 seconds), while this envelope also
  // covers a separately bounded Compose start, the post-kill health transition, container identity
  // probes, and the kill. Keeping the runner's deadline above the sum prevents it from racing the
  // host and hiding the specific failed operation, without giving workers any longer to claim the
  // crash target.
  const chaos = await waitForFile(
    "worker-chaos-complete.json",
    240_000,
    "worker-chaos-failed.json",
  );
  const oldClaimToken = String(chaos.oldClaimToken ?? "");
  invariant(oldClaimToken.length > 20, "host captured the killed worker's real claim token");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const residue = await sql<{ active: string; failed: string }[]>`
      SELECT count(*) FILTER(WHERE status IN ('queued','running'))::text active,
        count(*) FILTER(WHERE status='failed')::text failed
      FROM jobs WHERE created_at>=${queueBoundary[0].boundary}
    `;
    if (residue[0].active === "0") {
      invariant(residue[0].failed === "0", "material backlog has no failed jobs");
      break;
    }
    await abortableDelay(250, signal);
  }
  const crash = await sql<{
    status: string;
    attempts: number;
    locked_by: string | null;
    completed_at: Date | null;
  }[]>`SELECT status,attempts,locked_by,completed_at FROM jobs WHERE id=${crashJob[0].id}::uuid`;
  invariant(
    crash[0].status === "completed" && crash[0].attempts >= 2 && crash[0].completed_at,
    "peer reclaims and completes the killed worker's expired claim",
  );
  const stale = await sql<{ id: string }[]>`
    UPDATE jobs SET completed_at=clock_timestamp()
    WHERE id=${crashJob[0].id}::uuid AND status='running' AND locked_by=${oldClaimToken}
    RETURNING id
  `;
  invariant(stale.length === 0, "the killed process's stale claim token cannot mutate completion");
  const global = await sql<{
    active: string;
    failed: string;
    duplicate_keys: string;
    duplicate_audits: string;
    audit_total: string;
    bad_runs: string;
    mixed_completed: string;
  }[]>`
    SELECT
      (SELECT count(*) FROM jobs WHERE status IN ('queued','running'))::text active,
      (SELECT count(*) FROM jobs WHERE status='failed')::text failed,
      (SELECT count(*)-count(DISTINCT idempotency_key) FROM jobs
        WHERE created_at>=${queueBoundary[0].boundary})::text duplicate_keys,
      (SELECT count(*) FROM (
        SELECT target_id FROM audit_events WHERE action='retention.scrub.completed'
          AND target_id=ANY(${runs.map((run) => run.id)}::text[])
        GROUP BY target_id HAVING count(*)<>1
      ) invalid)::text duplicate_audits,
      (SELECT count(*) FROM audit_events WHERE action='retention.scrub.completed'
        AND target_id=ANY(${runs.map((run) => run.id)}::text[]))::text audit_total,
      (SELECT count(*) FROM retention_scrub_runs
        WHERE id=ANY(${runs.map((run) => run.id)}::uuid[]) AND status<>'completed')::text bad_runs,
      (SELECT count(*) FROM jobs WHERE idempotency_key=ANY(${mixed.map((item) => item.key)}::text[])
        AND status='completed')::text mixed_completed
  `;
  invariant(
    global[0].active === "0" && global[0].failed === "0",
    "the entire disposable queue returns to zero active and failed residue",
  );
  invariant(
    global[0].duplicate_keys === "0" &&
      global[0].duplicate_audits === "0" &&
      global[0].audit_total === String(runs.length) &&
      global[0].mixed_completed === String(mixed.length) &&
      global[0].bad_runs === "0",
    "all mixed jobs/runs/audits complete exactly once",
  );
  await sql`DROP TRIGGER IF EXISTS load_crash_once_trigger ON retention_scrub_runs`;
  await sql`DROP FUNCTION IF EXISTS load_crash_once()`;
  await sql`DROP SEQUENCE IF EXISTS load_crash_once_seq`;
  const workerTargets = await waitForMetric(
    'sum by(instance) (dg_chat_worker_jobs_total{job="dg-chat-worker",outcome="completed"}) > 0',
    2,
    45_000,
  );
  const workerInstances = await sql<{ workers: string }[]>`
    SELECT count(*)::text workers FROM worker_instances
    WHERE last_completed_at>=${queueBoundary[0].boundary}
  `;
  invariant(
    Number(workerInstances[0].workers) >= 2,
    "at least two real workers claim backlog jobs",
  );
  const oldest = await waitForMetric(
    'dg_chat_job_queue_depth{job="dg-chat-worker",status="queued"} == 0',
    2,
  );
  const elapsedSeconds = Math.max(
    0.001,
    (Date.now() - queueBoundary[0].boundary.getTime()) / 1_000,
  );
  invariant(
    (runs.length + mixed.length) / elapsedSeconds >= 1,
    "queue drains at least one durable job per second",
  );
  return {
    retentionJobs: runs.length,
    mixedJobs: mixed.length,
    crashTargetAttempts: crash[0].attempts,
    staleTokenFenced: true,
    workerTargetsUsed: workerTargets.length,
    workerClaimIdentities: Number(workerInstances[0].workers),
    zeroDepthTargets: oldest.length,
    jobsPerSecond: Number(((runs.length + mixed.length) / elapsedSeconds).toFixed(3)),
    globalResidueZero: true,
  };
}

async function run(): Promise<void> {
  await bootstrap();
  await phase("live-stream-restart-disconnect-replay", streamsPhase);
  await phase("hot-row-immutable-edit-convergence", editsPhase);
  await phase("scarce-credit-accounting-contention", accountingPhase);
  await phase("claimed-backlog-lease-recovery", queuePhase);
}

try {
  await run();
  await writeJsonArtifact("summary.json", {
    schemaVersion: 2,
    passed: true,
    profile: profileName,
    projectName,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    phases: results,
  });
} catch (error) {
  if (!signal.aborted) rootController.abort(error);
  const message = error instanceof Error ? error.message : "Unknown load harness failure";
  await writeJsonArtifact("summary.json", {
    schemaVersion: 2,
    passed: false,
    profile: profileName,
    projectName,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    phases: results,
    error: message.slice(0, 500),
  });
  console.error(message);
  Deno.exitCode = 1;
} finally {
  clearTimeout(rootTimer);
  if (!signal.aborted) {
    rootController.abort(new DOMException("Load harness complete", "AbortError"));
  }
  await sql.end({ timeout: 5 });
}
