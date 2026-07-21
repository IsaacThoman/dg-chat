import { type FormEvent, type ReactNode, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Play, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Modal } from "./Modal.tsx";

export const retryableHttpStatuses = [408, 425, 429, 500, 502, 503, 504] as const;

export interface RetryPolicy {
  id: string;
  name: string;
  enabled: boolean;
  maxAttempts: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplierBps: number;
  jitterBps: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  retryableStatuses: number[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type RetryPolicyInput = Omit<RetryPolicy, "id" | "version" | "createdAt" | "updatedAt">;

export interface ResilienceModel {
  id: string;
  publicModelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  enabled: boolean;
  providerEnabled: boolean;
  configured: boolean;
  protocol: "chat_completions" | "responses" | null;
  priced: boolean;
  capabilities: string[];
  contextWindow: number;
}

export interface ModelRoute {
  id: string;
  sourceModelId: string;
  retryPolicyId: string | null;
  fallbackModelIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RouteEntry {
  model: ResilienceModel;
  route: ModelRoute | null;
}

export interface ResilienceAdminClient {
  listPolicies(): Promise<RetryPolicy[]>;
  createPolicy(input: RetryPolicyInput): Promise<RetryPolicy>;
  updatePolicy(id: string, expectedVersion: number, input: RetryPolicyInput): Promise<RetryPolicy>;
  listRoutes(): Promise<RouteEntry[]>;
  setRoute(input: {
    sourceModelId: string;
    expectedVersion: number;
    retryPolicyId: string | null;
    fallbackModelIds: string[];
  }): Promise<ModelRoute>;
  runPlayground(scenario: unknown): Promise<PlaygroundResult>;
}

export type PlaygroundResult = {
  ok: true;
  completion: {
    scenarioId: string;
    seed: number;
    role: string;
    text: string;
    reasoning: string;
    toolCalls: unknown[];
    usage: Record<string, unknown>;
  };
} | {
  ok: false;
  error: { kind: string; message: string; details: Record<string, unknown> };
};

export class ResilienceAdminError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ResilienceAdminError";
  }
}

async function resilienceRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin/resilience${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let code = "request_failed";
    let message = `Request failed (${response.status})`;
    if (
      response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
        "application/json"
    ) {
      try {
        const value = await response.json() as { error?: { code?: unknown; message?: unknown } };
        if (typeof value.error?.code === "string" && value.error.code.length <= 120) {
          code = value.error.code;
        }
        if (typeof value.error?.message === "string" && value.error.message.length <= 500) {
          message = value.error.message;
        }
      } catch {
        // Preserve the bounded fallback instead of reflecting a malformed response.
      }
    }
    throw new ResilienceAdminError(response.status, code, message);
  }
  return await response.json() as T;
}

export const resilienceAdminClient: ResilienceAdminClient = {
  listPolicies: async () => (await resilienceRequest<{ data: RetryPolicy[] }>("/policies")).data,
  createPolicy: (input) =>
    resilienceRequest("/policies", { method: "POST", body: JSON.stringify(input) }),
  updatePolicy: (id, expectedVersion, input) =>
    resilienceRequest(`/policies/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion, ...input }),
    }),
  listRoutes: async () => (await resilienceRequest<{ data: RouteEntry[] }>("/routes")).data,
  setRoute: (input) =>
    resilienceRequest(`/routes/${encodeURIComponent(input.sourceModelId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  runPlayground: (scenario) =>
    resilienceRequest("/playground", { method: "POST", body: JSON.stringify(scenario) }),
};

export const defaultPolicyInput = (): RetryPolicyInput => ({
  name: "",
  enabled: true,
  maxAttempts: 3,
  maxRetries: 1,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  backoffMultiplierBps: 20_000,
  jitterBps: 2_000,
  firstTokenTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  retryableStatuses: [408, 425, 429, 500, 502, 503, 504],
});

export function policyInput(policy?: RetryPolicy): RetryPolicyInput {
  if (!policy) return defaultPolicyInput();
  const { id: _id, version: _version, createdAt: _created, updatedAt: _updated, ...input } = policy;
  return { ...input, retryableStatuses: [...input.retryableStatuses] };
}

export function validatePolicyDraft(input: RetryPolicyInput): string | undefined {
  if (!input.name.trim() || input.name.trim().length > 120) {
    return "Name must contain 1–120 characters.";
  }
  const numericValues = numberFields.map((field) => input[field.key]);
  if (numericValues.some((value) => !Number.isSafeInteger(value))) {
    return "Policy limits must be whole numbers.";
  }
  if (input.maxAttempts < 1 || input.maxAttempts > 8) {
    return "Maximum attempts must be from 1 to 8.";
  }
  if (input.maxRetries < 0 || input.maxRetries > 3 || input.maxRetries >= input.maxAttempts) {
    return "Maximum retries must be from 0 to 3 and less than maximum attempts.";
  }
  if (input.baseDelayMs < 0 || input.baseDelayMs > 60_000) return "Base delay is out of range.";
  if (input.maxDelayMs < input.baseDelayMs || input.maxDelayMs > 300_000) {
    return "Maximum delay must be at least the base delay and no more than 300000 ms.";
  }
  if (input.backoffMultiplierBps < 10_000 || input.backoffMultiplierBps > 40_000) {
    return "Backoff multiplier must be from 10000 to 40000 basis points.";
  }
  if (input.jitterBps < 0 || input.jitterBps > 10_000) {
    return "Jitter must be from 0 to 10000 basis points.";
  }
  if (input.firstTokenTimeoutMs < 250 || input.firstTokenTimeoutMs > 300_000) {
    return "First-token timeout must be from 250 to 300000 ms.";
  }
  if (input.idleTimeoutMs < 250 || input.idleTimeoutMs > 300_000) {
    return "Idle timeout must be from 250 to 300000 ms.";
  }
  if (
    input.totalTimeoutMs < Math.max(1_000, input.firstTokenTimeoutMs, input.idleTimeoutMs) ||
    input.totalTimeoutMs > 900_000
  ) return "Total timeout must cover first-token and idle timeouts and be no more than 900000 ms.";
  if (
    new Set(input.retryableStatuses).size !== input.retryableStatuses.length ||
    input.retryableStatuses.some((status) =>
      !retryableHttpStatuses.includes(status as typeof retryableHttpStatuses[number])
    )
  ) return "Retryable HTTP statuses are invalid.";
  return undefined;
}

export function reorderTargets(ids: string[], index: number, direction: -1 | 1): string[] {
  const target = index + direction;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function degradedTargetReasons(source: ResilienceModel, target?: ResilienceModel): string[] {
  if (!target) return ["Model no longer exists"];
  const reasons = modelAvailabilityReasons(target);
  if (target.protocol !== source.protocol) reasons.push("Protocol mismatch");
  const missing = source.capabilities.filter((capability) =>
    !target.capabilities.includes(capability)
  );
  if (missing.length) reasons.push(`Missing capabilities: ${missing.join(", ")}`);
  if (target.contextWindow < source.contextWindow) reasons.push("Smaller context window");
  return reasons;
}

export function modelAvailabilityReasons(model: ResilienceModel): string[] {
  const reasons: string[] = [];
  if (!model.enabled) reasons.push("Model disabled");
  if (!model.providerEnabled) reasons.push("Provider disabled");
  if (!model.configured) reasons.push("Credential missing");
  if (!model.priced) reasons.push("Effective price missing");
  if (!model.protocol) reasons.push("Provider missing");
  return reasons;
}

/** Returns all models reached by a proposed direct route, including its source. */
export function expandedRouteModelIds(
  sourceModelId: string,
  fallbackModelIds: string[],
  entries: RouteEntry[],
): Set<string> {
  const reached = new Set<string>();
  const visit = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    const route = entries.find((entry) => entry.model.id === id)?.route;
    for (const fallback of route?.fallbackModelIds ?? []) visit(fallback);
  };
  reached.add(sourceModelId);
  for (const fallback of fallbackModelIds) visit(fallback);
  return reached;
}

export function routeCandidateReasons(
  source: ResilienceModel,
  candidate: ResilienceModel,
  currentTargets: string[],
  entries: RouteEntry[],
): string[] {
  const reasons = degradedTargetReasons(source, candidate);
  const candidateReach = new Set<string>();
  const visit = (id: string) => {
    if (candidateReach.has(id)) return;
    candidateReach.add(id);
    const route = entries.find((entry) => entry.model.id === id)?.route;
    for (const fallback of route?.fallbackModelIds ?? []) visit(fallback);
  };
  visit(candidate.id);
  if (candidateReach.has(source.id)) reasons.push("Would create a fallback cycle");
  const expanded = expandedRouteModelIds(source.id, [...currentTargets, candidate.id], entries);
  if (expanded.size > 8) reasons.push("Expanded route would exceed eight models");
  return reasons;
}

export const isVersionConflict = (error: unknown) =>
  error instanceof ResilienceAdminError && error.status === 409 &&
  error.code === "version_conflict";

function Header(
  { title, subtitle, action }: { title: string; subtitle: string; action: ReactNode },
) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

function QueryState({ loading, error, retry, empty, children }: {
  loading: boolean;
  error: boolean;
  retry: () => void;
  empty: boolean;
  children: ReactNode;
}) {
  if (loading) {
    return <div className="registry-state" role="status">Loading resilience configuration…</div>;
  }
  if (error) {
    return (
      <div className="registry-banner error" role="alert">
        Resilience configuration could not be loaded.
        <button type="button" className="secondary" onClick={retry}>
          <RefreshCw size={15} /> Retry
        </button>
      </div>
    );
  }
  if (empty) return <div className="registry-state">Nothing has been configured yet.</div>;
  return children;
}

const numberFields: Array<{
  key: Exclude<keyof RetryPolicyInput, "name" | "enabled" | "retryableStatuses">;
  label: string;
  min: number;
  max: number;
}> = [
  { key: "maxAttempts", label: "Maximum attempts", min: 1, max: 8 },
  { key: "maxRetries", label: "Maximum retries per target", min: 0, max: 3 },
  { key: "baseDelayMs", label: "Base retry delay (ms)", min: 0, max: 60_000 },
  { key: "maxDelayMs", label: "Maximum retry delay (ms)", min: 0, max: 300_000 },
  {
    key: "backoffMultiplierBps",
    label: "Backoff multiplier (basis points)",
    min: 10_000,
    max: 40_000,
  },
  { key: "jitterBps", label: "Jitter (basis points)", min: 0, max: 10_000 },
  { key: "firstTokenTimeoutMs", label: "First visible token timeout (ms)", min: 250, max: 300_000 },
  { key: "idleTimeoutMs", label: "Visible stream idle timeout (ms)", min: 250, max: 300_000 },
  { key: "totalTimeoutMs", label: "Total request timeout (ms)", min: 1_000, max: 900_000 },
];

function PolicyModal({ policy, client, close, saved }: {
  policy?: RetryPolicy;
  client: ResilienceAdminClient;
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => policyInput(policy));
  const [expectedVersion, setExpectedVersion] = useState(policy?.version ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = validatePolicyDraft(draft);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      if (policy) {
        await client.updatePolicy(policy.id, expectedVersion, {
          ...draft,
          name: draft.name.trim(),
        });
      } else await client.createPolicy({ ...draft, name: draft.name.trim() });
      await saved(policy ? "Retry policy updated." : "Retry policy created.");
      close();
    } catch (reason) {
      if (policy && isVersionConflict(reason)) {
        try {
          const latest = await client.listPolicies();
          queryClient.setQueryData(["admin-resilience-policies"], latest);
          const fresh = latest.find((item) => item.id === policy.id);
          if (fresh) {
            setDraft(policyInput(fresh));
            setExpectedVersion(fresh.version);
          }
          setError(
            "This policy changed elsewhere. The latest version was loaded; review it and save again.",
          );
        } catch (reloadError) {
          setError(
            `This policy changed elsewhere, but reloading failed. ${
              reloadError instanceof Error ? reloadError.message : "Try again."
            }`,
          );
        }
      } else setError(reason instanceof Error ? reason.message : "Policy could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={policy ? `Edit ${policy.name}` : "Create retry policy"}
      close={close}
      dismissible={!busy}
    >
      <form onSubmit={save} aria-busy={busy}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label className="field">
          <span>Name</span>
          <input
            data-autofocus
            required
            maxLength={120}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />{" "}
          Enabled for route assignment
        </label>
        <div className="price-grid">
          {numberFields.map((field) => (
            <label className="field" key={field.key}>
              <span>{field.label}</span>
              <input
                type="number"
                required
                min={field.min}
                max={field.max}
                value={draft[field.key]}
                onChange={(e) => setDraft({ ...draft, [field.key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
        <fieldset className="capability-field">
          <legend>Retryable HTTP statuses</legend>
          {retryableHttpStatuses.map((status) => (
            <label className="check-row" key={status}>
              <input
                type="checkbox"
                checked={draft.retryableStatuses.includes(status)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    retryableStatuses: e.target.checked
                      ? [...draft.retryableStatuses, status].sort((a, b) => a - b)
                      : draft.retryableStatuses.filter((value) => value !== status),
                  })}
              />{" "}
              {status}
            </label>
          ))}
        </fieldset>
        <p className="muted">
          Retries and fallback apply only before visible output. Connection health and routing
          resilience are reported separately.
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save policy"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RouteTargetControls({ source, targets, models, setTargets }: {
  source: ResilienceModel;
  targets: string[];
  models: ResilienceModel[];
  setTargets: (targets: string[]) => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const changeOrder = (index: number, direction: -1 | 1) => {
    const next = reorderTargets(targets, index, direction);
    setTargets(next);
    const target = models.find((model) => model.id === targets[index]);
    setAnnouncement(
      `${target?.displayName ?? targets[index]} moved to position ${
        index + direction + 1
      } of ${targets.length}.`,
    );
  };
  return (
    <>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <ol aria-label={`Fallback order for ${source.displayName}`}>
        {targets.map((id, index) => {
          const target = models.find((model) => model.id === id);
          const reasons = degradedTargetReasons(source, target);
          return (
            <li key={id}>
              <strong>{index + 1}. {target?.displayName ?? "Missing model"}</strong>
              <span>{target?.publicModelId ?? id}</span>
              {reasons.length > 0 && (
                <p className="model-blockers">Degraded: {reasons.join(" · ")}</p>
              )}
              <div
                className="provider-actions"
                role="group"
                aria-label={`Order controls for ${target?.displayName ?? id}`}
              >
                <button
                  type="button"
                  className="secondary"
                  disabled={index === 0}
                  aria-label={`Move ${target?.displayName ?? id} up`}
                  onClick={() => changeOrder(index, -1)}
                >
                  <ArrowUp size={14} /> Up
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={index === targets.length - 1}
                  aria-label={`Move ${target?.displayName ?? id} down`}
                  onClick={() => changeOrder(index, 1)}
                >
                  <ArrowDown size={14} /> Down
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove ${target?.displayName ?? id}`}
                  onClick={() => {
                    setTargets(targets.filter((value) => value !== id));
                    setAnnouncement(
                      `${target?.displayName ?? id} removed. ${
                        targets.length - 1
                      } fallback targets remain.`,
                    );
                  }}
                >
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function RouteModal({ entry, entries, policies, client, close, saved }: {
  entry: RouteEntry;
  entries: RouteEntry[];
  policies: RetryPolicy[];
  client: ResilienceAdminClient;
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [targets, setTargets] = useState(entry.route?.fallbackModelIds ?? []);
  const [policyId, setPolicyId] = useState(entry.route?.retryPolicyId ?? "");
  const [expectedVersion, setExpectedVersion] = useState(entry.route?.version ?? 0);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const models = entries.map((item) => item.model);
  const available = models.filter((model) =>
    model.id !== entry.model.id && !targets.includes(model.id)
  );
  const selectedPolicy = policies.find((policy) => policy.id === policyId);
  const selectedPolicyUnavailable = Boolean(
    policyId && (!selectedPolicy || !selectedPolicy.enabled),
  );
  const expandedCount = expandedRouteModelIds(entry.model.id, targets, entries).size;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await client.setRoute({
        sourceModelId: entry.model.id,
        expectedVersion,
        retryPolicyId: policyId || null,
        fallbackModelIds: targets,
      });
      await saved("Fallback route updated.");
      close();
    } catch (reason) {
      if (isVersionConflict(reason)) {
        try {
          const latest = await client.listRoutes();
          queryClient.setQueryData(["admin-resilience-routes"], latest);
          const fresh = latest.find((item) => item.model.id === entry.model.id);
          setTargets(fresh?.route?.fallbackModelIds ?? []);
          setPolicyId(fresh?.route?.retryPolicyId ?? "");
          setExpectedVersion(fresh?.route?.version ?? 0);
          setError(
            "This route changed elsewhere. The latest order was loaded; review it and save again.",
          );
        } catch (reloadError) {
          setError(
            `This route changed elsewhere, but reloading failed. ${
              reloadError instanceof Error ? reloadError.message : "Try again."
            }`,
          );
        }
      } else setError(reason instanceof Error ? reason.message : "Route could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Fallback route · ${entry.model.displayName}`} close={close} dismissible={!busy}>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="muted">
        The source remains the advertised model. Targets are tried in this order only before visible
        output. Provider health is not changed by this route.
      </p>
      <label className="field">
        <span>Retry policy</span>
        <select
          data-autofocus
          value={policyId}
          onChange={(e) =>
            setPolicyId(e.target.value)}
        >
          <option value="">No retries</option>
          {policies.map((policy) => (
            <option key={policy.id} value={policy.id} disabled={!policy.enabled}>
              {policy.name}
              {policy.enabled ? "" : " (disabled)"}
            </option>
          ))}
        </select>
      </label>
      {selectedPolicyUnavailable && (
        <p className="model-blockers" role="status">
          This policy is disabled or unavailable, so the route currently performs no retries. Select
          an enabled policy or No retries before saving.
        </p>
      )}
      <div className="field">
        <span>Add fallback target</span>
        <div className="provider-actions">
          <select
            aria-label="Fallback target"
            value={adding}
            onChange={(e) =>
              setAdding(e.target.value)}
          >
            <option value="">Select model</option>
            {available.map((model) => {
              const reasons = routeCandidateReasons(entry.model, model, targets, entries);
              return (
                <option key={model.id} value={model.id} disabled={reasons.length > 0}>
                  {model.displayName} · {model.providerName}
                  {reasons.length ? ` — ${reasons.join(", ")}` : ""}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={!adding || targets.length >= 7 || expandedCount >= 8}
            onClick={() => {
              setTargets([...targets, adding]);
              setAdding("");
            }}
          >
            <Plus size={14} /> Add
          </button>
        </div>
        <small>
          {expandedCount}{" "}
          of 8 expanded models used, including the source and nested routes. At most seven can be
          direct fallbacks. Use the buttons below to set keyboard-accessible order.
        </small>
      </div>
      {targets.length
        ? (
          <RouteTargetControls
            source={entry.model}
            targets={targets}
            models={models}
            setTargets={setTargets}
          />
        )
        : (
          <div className="registry-state">
            No fallback targets. Requests use only the source model.
          </div>
        )}
      <div className="modal-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button
          type="button"
          className="primary"
          disabled={busy || selectedPolicyUnavailable}
          onClick={save}
        >
          {busy ? "Saving…" : "Save route"}
        </button>
      </div>
    </Modal>
  );
}

const defaultPlaygroundScenario = JSON.stringify(
  {
    id: "admin-preview",
    name: "Reasoning preview",
    seed: 42,
    steps: [
      { type: "reasoning", text: "Checking the configured route…", delayMs: 40, jitterMs: 10 },
      { type: "text", text: "The deterministic simulator is ready.", delayMs: 60, jitterMs: 10 },
      {
        type: "usage",
        inputTokens: 24,
        cachedInputTokens: 0,
        reasoningTokens: 8,
        outputTokens: 12,
        delayMs: 0,
        jitterMs: 0,
      },
    ],
  },
  null,
  2,
);

function ResiliencePlayground({ client }: { client: ResilienceAdminClient }) {
  const [scenario, setScenario] = useState(defaultPlaygroundScenario);
  const [result, setResult] = useState<PlaygroundResult>();
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const run = async () => {
    setError("");
    setResult(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(scenario);
    } catch {
      setError("Scenario must be valid JSON.");
      return;
    }
    setRunning(true);
    try {
      setResult(await client.runPlayground(parsed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The simulator could not run.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <section className="resilience-playground" aria-labelledby="playground-title">
      <div>
        <h2 id="playground-title">Deterministic playground</h2>
        <p className="registry-help">
          Exercise latency, reasoning, tool calls, usage, and failures without provider secrets or
          user credits. Scenarios are strictly bounded and run only in this isolated admin
          playground.
        </p>
      </div>
      <div className="playground-grid">
        <label>
          Scenario JSON
          <textarea
            value={scenario}
            onChange={(event) => setScenario(event.target.value)}
            rows={14}
            spellCheck={false}
            aria-describedby="playground-help"
          />
        </label>
        <div className="playground-result" aria-live="polite" aria-busy={running}>
          <strong>Result</strong>
          {running
            ? <p>Running deterministic scenario…</p>
            : error
            ? <p className="model-blockers">{error}</p>
            : result
            ? <pre>{JSON.stringify(result, null, 2)}</pre>
            : <p id="playground-help">Run the sample or edit its bounded steps.</p>}
        </div>
      </div>
      <button type="button" className="primary" onClick={() => void run()} disabled={running}>
        <Play size={16} /> {running ? "Running…" : "Run scenario"}
      </button>
    </section>
  );
}

export function AdminResilience(
  { client = resilienceAdminClient }: { client?: ResilienceAdminClient },
) {
  const queryClient = useQueryClient();
  const policies = useQuery({
    queryKey: ["admin-resilience-policies"],
    queryFn: () => client.listPolicies(),
  });
  const routes = useQuery({
    queryKey: ["admin-resilience-routes"],
    queryFn: () => client.listRoutes(),
  });
  const [editingPolicy, setEditingPolicy] = useState<RetryPolicy | "new">();
  const [editingRoute, setEditingRoute] = useState<RouteEntry>();
  const [notice, setNotice] = useState("");
  const saved = async (message: string) => {
    // Confirm the durable mutation immediately; cache refresh latency must not leave the prior
    // operation's banner on screen while an administrator waits for a new save to finish.
    setNotice(message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-resilience-policies"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-resilience-routes"] }),
    ]);
  };
  return (
    <section aria-labelledby="resilience-title">
      <Header
        title="Routing resilience"
        subtitle="Configure retries and ordered fallback paths without conflating routing with provider connection health"
        action={
          <button
            type="button"
            className="primary"
            onClick={() => setEditingPolicy("new")}
          >
            <Plus size={16} /> Create policy
          </button>
        }
      />
      <h2 id="resilience-title" className="sr-only">Routing resilience configuration</h2>
      <ResiliencePlayground client={client} />
      {notice && (
        <div className="registry-banner" role="status">
          {notice}
          <button type="button" className="secondary" onClick={() => setNotice("")}>
            <RotateCcw size={14} /> Dismiss
          </button>
        </div>
      )}
      <h2>Retry policies</h2>
      <QueryState
        loading={policies.isLoading}
        error={policies.isError}
        retry={() => void policies.refetch()}
        empty={!policies.data?.length}
      >
        <div className="provider-grid" aria-busy={policies.isFetching}>
          {policies.data?.map((policy) => (
            <article className="provider-card" key={policy.id}>
              <div>
                <strong>{policy.name}</strong>
                <span className={`status-chip ${policy.enabled ? "" : "warning"}`}>
                  {policy.enabled ? "enabled" : "disabled"}
                </span>
              </div>
              <p>
                {policy.maxAttempts} attempts · {policy.maxRetries} retries per target ·{" "}
                {policy.firstTokenTimeoutMs} ms first visible token
              </p>
              <div className="provider-actions">
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Edit ${policy.name}`}
                  onClick={() => setEditingPolicy(policy)}
                >
                  Edit policy
                </button>
              </div>
            </article>
          ))}
        </div>
      </QueryState>
      <h2>Fallback routes</h2>
      <p className="registry-help">
        Health tests describe whether an endpoint responds. Routes describe what the gateway should
        try when a healthy-looking endpoint still fails before visible output.
      </p>
      <QueryState
        loading={routes.isLoading || policies.isLoading}
        error={routes.isError || policies.isError}
        retry={() => {
          void routes.refetch();
          void policies.refetch();
        }}
        empty={!routes.data?.length}
      >
        <div className="model-registry" aria-busy={routes.isFetching}>
          {routes.data?.map((entry) => {
            const routePolicy = policies.data?.find((policy) =>
              policy.id === entry.route?.retryPolicyId
            );
            const sourceUnavailable = modelAvailabilityReasons(entry.model);
            const fallbackDegraded = (entry.route?.fallbackModelIds ?? []).flatMap((id) =>
              degradedTargetReasons(
                entry.model,
                routes.data?.find((item) => item.model.id === id)?.model,
              )
            );
            const policyUnavailable = Boolean(
              entry.route?.retryPolicyId && (!routePolicy || !routePolicy.enabled),
            );
            const degraded = [
              ...sourceUnavailable,
              ...fallbackDegraded,
              ...(policyUnavailable ? ["Retry policy disabled or unavailable"] : []),
            ];
            return (
              <article className="model-card" key={entry.model.id}>
                <div className="model-card-head">
                  <strong>{entry.model.displayName}</strong>
                  <span className={`status-chip ${degraded.length ? "warning" : ""}`}>
                    {sourceUnavailable.length
                      ? "unavailable"
                      : degraded.length
                      ? "degraded"
                      : entry.route?.fallbackModelIds.length
                      ? "routed"
                      : "direct"}
                  </span>
                </div>
                <code>{entry.model.publicModelId}</code>
                <p>{entry.model.providerName} · connection health remains separate</p>
                <dl className="model-facts">
                  <div>
                    <dt>Policy</dt>
                    <dd>
                      {entry.route?.retryPolicyId
                        ? routePolicy
                          ? `${routePolicy.name}${
                            routePolicy.enabled ? "" : " (disabled — no retries)"
                          }`
                          : "Unavailable policy — no retries"
                        : "No retries"}
                    </dd>
                  </div>
                  <div>
                    <dt>Fallbacks</dt>
                    <dd>{entry.route?.fallbackModelIds.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Route version</dt>
                    <dd>{entry.route?.version ?? 0}</dd>
                  </div>
                </dl>
                {degraded.length > 0 && (
                  <p className="model-blockers">
                    Route unavailable or degraded: {[...new Set(degraded)].join(" · ")}
                  </p>
                )}
                <div className="provider-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Edit route for ${entry.model.displayName}`}
                    onClick={() => setEditingRoute(entry)}
                  >
                    Edit route
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </QueryState>
      {editingPolicy && (
        <PolicyModal
          policy={editingPolicy === "new" ? undefined : editingPolicy}
          client={client}
          close={() => setEditingPolicy(undefined)}
          saved={saved}
        />
      )}
      {editingRoute && (
        <RouteModal
          entry={editingRoute}
          entries={routes.data ?? []}
          policies={policies.data ?? []}
          client={client}
          close={() => setEditingRoute(undefined)}
          saved={saved}
        />
      )}
    </section>
  );
}
