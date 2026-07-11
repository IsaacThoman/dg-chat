import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, Cloud, Plus, RefreshCw, Search } from "lucide-react";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { MODEL_CAPABILITIES, type ModelCapability } from "../../../packages/contracts/src/types.ts";
import type {
  AdminModel,
  AdminProvider,
  DiscoveredProviderModel,
  ModelPriceVersion,
  ProviderProtocol,
} from "./types.ts";

const capabilities = MODEL_CAPABILITIES;
const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "The request failed";
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString() : "Never";
export const microsToUsd = (value: number) => value / 1_000_000;
export const usdToMicros = (value: string) => Math.round(Number(value) * 1_000_000);
export const formatMicrosAsUsd = (value: number) => {
  const fixed = microsToUsd(value).toFixed(6);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
};
export function dateTimeLocalValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function effectivePrice(prices: ModelPriceVersion[], now = Date.now()) {
  return [...prices].filter((price) => Date.parse(price.effectiveAt) <= now)
    .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
}

export function modelAvailabilityBlockers(
  model: AdminModel,
  provider: AdminProvider | undefined,
  price: ModelPriceVersion | undefined,
): string[] {
  const blockers: string[] = [];
  if (!model.enabled) blockers.push("Model disabled");
  if (!provider) blockers.push("Provider missing");
  else {
    if (!provider.enabled) blockers.push("Provider disabled");
    if (!provider.hasCredential) blockers.push("Credential required");
    if (provider.protocol !== "chat_completions") blockers.push("Protocol unsupported");
  }
  if (!price) blockers.push("Pricing required");
  return blockers;
}

export function selectionAfterSuccessfulImports(
  selected: ReadonlySet<string>,
  importedIds: readonly string[],
): Set<string> {
  const remaining = new Set(selected);
  importedIds.forEach((id) => remaining.delete(id));
  return remaining;
}

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
  if (loading) return <div className="registry-state" role="status">Loading…</div>;
  return (
    <>
      {error && (
        <div className="registry-banner" role="alert">
          The latest data could not be loaded. Previously loaded data is preserved.
          <button className="secondary" onClick={retry}>
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}
      {empty && !error
        ? <div className="registry-state">Nothing has been configured yet.</div>
        : children}
    </>
  );
}

type ProviderDraft = {
  slug: string;
  displayName: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  credential: string;
};
function ProviderForm({ provider, close }: { provider?: AdminProvider; close: () => void }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(provider);
  const [draft, setDraft] = useState<ProviderDraft>({
    slug: provider?.slug ?? "",
    displayName: provider?.displayName ?? "",
    baseUrl: provider?.baseUrl ?? "https://api.example.com/v1",
    protocol: provider?.protocol ?? "chat_completions",
    enabled: provider?.enabled ?? false,
    credential: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (draft.enabled && !current?.hasCredential && !draft.credential) {
      setError("Add a credential before enabling this provider.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const creating = !current;
      let saved = current
        ? await api.updateAdminProvider(current, {
          displayName: draft.displayName,
          baseUrl: draft.baseUrl,
          protocol: draft.protocol,
          enabled: draft.enabled,
        })
        : await api.createAdminProvider({
          slug: draft.slug,
          displayName: draft.displayName,
          baseUrl: draft.baseUrl,
          protocol: draft.protocol,
          enabled: false,
        });
      setCurrent(saved);
      if (draft.credential) {
        saved = await api.replaceAdminProviderCredential(saved, draft.credential);
        setCurrent(saved);
        set("credential", "");
      }
      if (creating && draft.enabled) {
        saved = await api.updateAdminProvider(saved, { enabled: true });
        setCurrent(saved);
      }
      queryClient.setQueryData<AdminProvider[]>(
        ["admin-providers"],
        (current = []) =>
          current.some((item) => item.id === saved.id)
            ? current.map((item) =>
              item.id === saved.id ? { ...saved, modelCount: item.modelCount } : item
            )
            : [...current, { ...saved, modelCount: 0 }],
      );
      close();
    } catch (reason) {
      setError(errorMessage(reason));
      await queryClient.invalidateQueries({ queryKey: ["admin-providers"] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={provider ? `Manage ${provider.displayName}` : "Add provider"}
      close={close}
      dismissible={!busy}
    >
      <form onSubmit={save} aria-busy={busy}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label className="field">
          <span>Display name</span>
          <input
            autoFocus
            data-autofocus
            required
            maxLength={120}
            value={draft.displayName}
            onChange={(e) => set("displayName", e.target.value)}
          />
        </label>
        <label className="field">
          <span>Provider ID</span>
          <input
            required
            pattern="[a-z0-9][a-z0-9-]{0,62}"
            disabled={Boolean(current)}
            value={draft.slug}
            onChange={(e) => set("slug", e.target.value.toLowerCase())}
          />
          <small>
            {current ? "Stable after creation" : "Lowercase letters, numbers, and hyphens"}
          </small>
        </label>
        <label className="field">
          <span>Base URL</span>
          <input
            required
            type="url"
            inputMode="url"
            value={draft.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
          />
          <small>HTTPS only; credentials, query strings, and fragments are rejected.</small>
        </label>
        <label className="field">
          <span>Upstream protocol</span>
          <select
            value={draft.protocol}
            onChange={(e) => set("protocol", e.target.value as ProviderProtocol)}
          >
            <option value="chat_completions">OpenAI Chat Completions</option>
          </select>
          <small>
            Responses protocol providers will be enabled after the upstream adapter is available.
          </small>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />{" "}
          Enabled
        </label>
        <label className="field credential-field">
          <span>
            {current?.hasCredential ? "Replace credential (optional)" : "API credential (optional)"}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={draft.credential}
            onChange={(e) => set("credential", e.target.value)}
          />
          <small>
            {current?.hasCredential
              ? "A credential is stored. Leave blank to keep it; it can never be revealed."
              : "Stored encrypted and never shown again."}
          </small>
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save provider"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Discovery({ provider, result, close }: {
  provider: AdminProvider;
  result: DiscoveredProviderModel[];
  close: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set(result.map((model) => model.id)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failureById, setFailureById] = useState<Record<string, string>>({});
  const importModels = async () => {
    setBusy(true);
    let imported = 0;
    const importedIds: string[] = [];
    const failures: Record<string, string> = {};
    for (const model of result.filter((item) => selected.has(item.id))) {
      try {
        await api.createAdminModel({
          providerId: provider.id,
          publicModelId: `${provider.slug}/${model.id}`,
          upstreamModelId: model.id,
          displayName: model.id,
          capabilities: ["chat", "streaming"],
          contextWindow: 128_000,
          enabled: false,
        });
        imported++;
        importedIds.push(model.id);
      } catch (error) {
        failures[model.id] = errorMessage(error).slice(0, 240);
      }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-models"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-providers"] }),
    ]);
    setSelected((current) => selectionAfterSuccessfulImports(current, importedIds));
    setFailureById(failures);
    const failureCount = Object.keys(failures).length;
    setMessage(
      failureCount
        ? `Imported ${imported}. ${failureCount} model${
          failureCount === 1 ? "" : "s"
        } could not be imported; review the marked rows and retry.`
        : `Imported ${imported} disabled model${imported === 1 ? "" : "s"}.`,
    );
    setBusy(false);
  };
  return (
    <Modal
      title={`Models discovered from ${provider.displayName}`}
      close={close}
      dismissible={!busy}
    >
      <p className="muted">
        Review models before importing. Imported models start disabled with conservative defaults.
      </p>
      <div className="discovery-list" role="group" aria-label="Discovered models">
        {result.length === 0 && <p>No models were returned. You can add one manually.</p>}
        {result.map((model, index) => (
          <label className="check-row" key={model.id}>
            <input
              data-autofocus={index === 0 || undefined}
              type="checkbox"
              checked={selected.has(model.id)}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  event.target.checked ? next.add(model.id) : next.delete(model.id);
                  return next;
                })}
            />
            <span>
              <strong>{model.id}</strong>
              {model.ownedBy && <small>{model.ownedBy}</small>}
              {failureById[model.id] && (
                <small className="discovery-error">{failureById[model.id]}</small>
              )}
            </span>
          </label>
        ))}
      </div>
      {message && (
        <p
          className={`registry-banner ${Object.keys(failureById).length ? "error" : ""}`}
          role={Object.keys(failureById).length ? "alert" : "status"}
        >
          {message}
        </p>
      )}
      <div className="modal-actions">
        <button className="secondary" disabled={busy} onClick={close}>Close</button>
        <button className="primary" disabled={busy || selected.size === 0} onClick={importModels}>
          {busy ? "Importing…" : `Import ${selected.size} selected`}
        </button>
      </div>
    </Modal>
  );
}

export function AdminProviders() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["admin-providers"], queryFn: api.adminProviders });
  const [editing, setEditing] = useState<AdminProvider | "new">();
  const [discovery, setDiscovery] = useState<
    { provider: AdminProvider; result: DiscoveredProviderModel[] }
  >();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const [confirmToggle, setConfirmToggle] = useState<AdminProvider>();
  const action = async (provider: AdminProvider, kind: "toggle" | "test" | "discover") => {
    setBusy(`${provider.id}:${kind}`);
    setNotice(undefined);
    try {
      if (kind === "toggle") {
        await api.updateAdminProvider(provider, { enabled: !provider.enabled });
      }
      if (kind === "test") {
        const result = await api.testAdminProvider(provider);
        setNotice({
          message:
            `${provider.displayName} is healthy (${result.latencyMs} ms, ${result.modelCount} models).`,
          error: false,
        });
      }
      if (kind === "discover") {
        const result = await api.discoverAdminProvider(provider);
        setDiscovery({ provider: result.provider, result: result.models });
      }
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["admin-providers"] });
      setBusy(undefined);
    }
  };
  return (
    <>
      <Header
        title="Providers"
        subtitle="Secure OpenAI-compatible endpoints and connection health"
        action={
          <button className="primary" onClick={() => setEditing("new")}>
            <Plus size={16} /> Add provider
          </button>
        }
      />
      {notice && (
        <div
          className={`registry-banner ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
          aria-live={notice.error ? "assertive" : "polite"}
        >
          {notice.message}
        </div>
      )}
      <QueryState
        loading={providers.isLoading}
        error={providers.isError}
        retry={() => void providers.refetch()}
        empty={!providers.data?.length}
      >
        <div className="provider-grid" aria-busy={providers.isFetching}>
          {providers.data?.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <div>
                <span className="provider-logo">
                  <Cloud size={17} />
                </span>
                <span
                  className={`status-chip ${
                    !provider.enabled || provider.healthStatus !== "healthy" ? "warning" : ""
                  }`}
                >
                  {provider.enabled ? provider.healthStatus : "disabled"}
                </span>
              </div>
              <h3>{provider.displayName}</h3>
              <p>{provider.slug} · {new URL(provider.baseUrl).host}</p>
              <div className="provider-stats">
                <span>
                  <small>Credential</small>
                  <strong>{provider.hasCredential ? "Stored" : "Missing"}</strong>
                </span>
                <span>
                  <small>Models</small>
                  <strong>{provider.modelCount}</strong>
                </span>
                <span>
                  <small>Latency</small>
                  <strong>
                    {provider.healthLatencyMs === null ? "—" : `${provider.healthLatencyMs} ms`}
                  </strong>
                </span>
                <span>
                  <small>Last checked</small>
                  <strong>{dateTime(provider.healthCheckedAt)}</strong>
                </span>
              </div>
              {provider.healthError && (
                <p className="provider-error">
                  Last check: {provider.healthError.replaceAll("_", " ")}
                </p>
              )}
              <div className="provider-actions">
                <button
                  className="secondary"
                  aria-label={`Manage ${provider.displayName}`}
                  disabled={Boolean(busy)}
                  onClick={() => setEditing(provider)}
                >
                  Manage
                </button>
                <button
                  className="secondary"
                  aria-label={`Test ${provider.displayName}`}
                  disabled={Boolean(busy) || !provider.hasCredential}
                  onClick={() => action(provider, "test")}
                >
                  <Activity size={14} /> Test
                </button>
                <button
                  className="secondary"
                  aria-label={`Discover models from ${provider.displayName}`}
                  disabled={Boolean(busy) || !provider.hasCredential}
                  onClick={() => action(provider, "discover")}
                >
                  <Search size={14} /> Discover
                </button>
                <button
                  className="secondary"
                  aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.displayName}`}
                  disabled={Boolean(busy) || (!provider.enabled && !provider.hasCredential)}
                  onClick={() => setConfirmToggle(provider)}
                >
                  {provider.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </QueryState>
      {editing && (
        <ProviderForm
          provider={editing === "new" ? undefined : editing}
          close={() => setEditing(undefined)}
        />
      )}
      {discovery && <Discovery {...discovery} close={() => setDiscovery(undefined)} />}
      {confirmToggle && (
        <Modal
          title={`${confirmToggle.enabled ? "Disable" : "Enable"} ${confirmToggle.displayName}?`}
          close={() => setConfirmToggle(undefined)}
          dismissible={!busy}
        >
          <p className="muted">
            {confirmToggle.enabled
              ? `Its ${confirmToggle.modelCount} configured model${
                confirmToggle.modelCount === 1 ? "" : "s"
              } will stop appearing to users. Configuration and history are retained.`
              : "Models with effective pricing can become available to users after the provider is enabled."}
          </p>
          <div className="modal-actions">
            <button
              className="secondary"
              data-autofocus
              disabled={Boolean(busy)}
              onClick={() => setConfirmToggle(undefined)}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={async () => {
                await action(confirmToggle, "toggle");
                setConfirmToggle(undefined);
              }}
            >
              {busy ? "Updating…" : confirmToggle.enabled ? "Disable provider" : "Enable provider"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

type ModelDraft = {
  providerId: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  contextWindow: string;
  enabled: boolean;
  capabilities: ModelCapability[];
};
function ModelForm(
  { model, providers, close }: {
    model?: AdminModel;
    providers: AdminProvider[];
    close: () => void;
  },
) {
  const queryClient = useQueryClient();
  const initialProvider = providers.find((provider) => provider.id === model?.providerId) ??
    providers[0];
  const [draft, setDraft] = useState<ModelDraft>({
    providerId: model?.providerId ?? initialProvider?.id ?? "",
    publicModelId: model?.publicModelId ?? `${initialProvider?.slug ?? "provider"}/`,
    upstreamModelId: model?.upstreamModelId ?? "",
    displayName: model?.displayName ?? "",
    contextWindow: String(model?.contextWindow ?? 128000),
    enabled: model?.enabled ?? false,
    capabilities: model?.capabilities ?? ["chat", "streaming"],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (model) {
        await api.updateAdminModel(model, {
          displayName: draft.displayName,
          contextWindow: Number(draft.contextWindow),
          capabilities: draft.capabilities,
          enabled: draft.enabled,
        });
      } else await api.createAdminModel({ ...draft, contextWindow: Number(draft.contextWindow) });
      await queryClient.invalidateQueries({ queryKey: ["admin-models"] });
      close();
    } catch (reason) {
      setError(errorMessage(reason));
      await queryClient.invalidateQueries({ queryKey: ["admin-models"] });
    } finally {
      setBusy(false);
    }
  };
  const setProvider = (id: string) => {
    const provider = providers.find((item) => item.id === id);
    setDraft((current) => ({
      ...current,
      providerId: id,
      publicModelId: `${provider?.slug ?? "provider"}/${current.upstreamModelId}`,
    }));
  };
  return (
    <Modal
      title={model ? `Edit ${model.displayName}` : "Add model"}
      close={close}
      dismissible={!busy}
    >
      <form onSubmit={save} aria-busy={busy}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label className="field">
          <span>Provider</span>
          <select
            autoFocus
            data-autofocus={model ? undefined : true}
            disabled={Boolean(model)}
            required
            value={draft.providerId}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="" disabled>Select provider</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.displayName}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Upstream model ID</span>
          <input
            disabled={Boolean(model)}
            required
            value={draft.upstreamModelId}
            onChange={(e) =>
              setDraft((current) => ({ ...current, upstreamModelId: e.target.value }))}
          />
        </label>
        <label className="field">
          <span>Public model ID</span>
          <input
            disabled={Boolean(model)}
            required
            value={draft.publicModelId}
            onChange={(e) => setDraft((current) => ({ ...current, publicModelId: e.target.value }))}
          />
        </label>
        <label className="field">
          <span>Display name</span>
          <input
            data-autofocus={model ? true : undefined}
            required
            value={draft.displayName}
            onChange={(e) => setDraft((current) => ({ ...current, displayName: e.target.value }))}
          />
        </label>
        <label className="field">
          <span>Context window</span>
          <input
            type="number"
            min="1"
            required
            value={draft.contextWindow}
            onChange={(e) => setDraft((current) => ({ ...current, contextWindow: e.target.value }))}
          />
        </label>
        <fieldset className="capability-field">
          <legend>Capabilities</legend>
          {capabilities.map((capability) => (
            <label className="check-row" key={capability}>
              <input
                type="checkbox"
                checked={draft.capabilities.includes(capability)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    capabilities: event.target.checked
                      ? [...current.capabilities, capability]
                      : current.capabilities.filter((item) => item !== capability),
                  }))}
              />{" "}
              {capability}
            </label>
          ))}
        </fieldset>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((current) => ({ ...current, enabled: e.target.checked }))}
          />{" "}
          Enabled
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save model"}</button>
        </div>
      </form>
    </Modal>
  );
}

function PriceForm({ model, close }: { model: AdminModel; close: () => void }) {
  const queryClient = useQueryClient();
  const local = dateTimeLocalValue(new Date());
  const [values, setValues] = useState({
    effectiveAt: local,
    input: "0",
    cached: "0",
    reasoning: "0",
    output: "0",
    fixed: "0",
    source: "admin",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.createModelPrice(model, {
        effectiveAt: new Date(values.effectiveAt).toISOString(),
        inputMicrosPerMillion: usdToMicros(values.input),
        cachedInputMicrosPerMillion: usdToMicros(values.cached),
        reasoningMicrosPerMillion: usdToMicros(values.reasoning),
        outputMicrosPerMillion: usdToMicros(values.output),
        fixedCallMicros: usdToMicros(values.fixed),
        source: values.source,
      });
      await queryClient.invalidateQueries({ queryKey: ["admin-models"] });
      close();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof typeof values, label: string, step = "0.000001") => (
    <label className="field">
      <span>{label}</span>
      <input
        data-autofocus={key === "effectiveAt" || undefined}
        type={key === "source" ? "text" : key === "effectiveAt" ? "datetime-local" : "number"}
        min={key === "source" || key === "effectiveAt" ? undefined : "0"}
        step={key === "effectiveAt" || key === "source" ? undefined : step}
        required
        value={values[key]}
        onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
      />
    </label>
  );
  return (
    <Modal title={`Add pricing revision · ${model.displayName}`} close={close} dismissible={!busy}>
      <form onSubmit={save} aria-busy={busy}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="muted">
          Pricing is append-only. Amounts are USD; token rates are per one million tokens.
        </p>
        {field("effectiveAt", "Effective from")}
        <div className="price-grid">
          {field("input", "Input")}
          {field("cached", "Cached input")}
          {field("reasoning", "Reasoning")}
          {field("output", "Output")}
          {field("fixed", "Fixed per call")}
          {field("source", "Source")}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>{busy ? "Adding…" : "Add revision"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AdminModels() {
  const models = useQuery({ queryKey: ["admin-models"], queryFn: api.adminModels });
  const providers = useQuery({ queryKey: ["admin-providers"], queryFn: api.adminProviders });
  const [editing, setEditing] = useState<AdminModel | "new">();
  const [pricing, setPricing] = useState<AdminModel>();
  const [search, setSearch] = useState("");
  const filtered = useMemo(
    () =>
      (models.data ?? []).filter((model) =>
        `${model.displayName} ${model.publicModelId} ${model.upstreamModelId}`.toLowerCase()
          .includes(search.toLowerCase())
      ),
    [models.data, search],
  );
  return (
    <>
      <Header
        title="Models & pricing"
        subtitle="Capabilities, public model IDs, and append-only effective pricing"
        action={
          <button
            className="primary"
            disabled={!providers.data?.length}
            onClick={() => setEditing("new")}
          >
            <Plus size={16} /> Add model
          </button>
        }
      />
      <p className="registry-help">
        A model appears in chat only when the model and provider are enabled, the provider has a
        credential and supported protocol, and an effective pricing revision exists.
      </p>
      <label className="registry-search">
        <Search size={16} />
        <input
          aria-label="Search models"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models"
        />
      </label>
      <QueryState
        loading={models.isLoading || providers.isLoading}
        error={models.isError || providers.isError}
        retry={() => {
          void models.refetch();
          void providers.refetch();
        }}
        empty={!models.data?.length}
      >
        <div className="model-registry" aria-busy={models.isFetching}>
          {filtered.map((model) => {
            const provider = providers.data?.find((item) => item.id === model.providerId);
            const current = effectivePrice(model.prices);
            const blockers = modelAvailabilityBlockers(model, provider, current);
            const available = blockers.length === 0;
            return (
              <article className="model-card" key={model.id}>
                <div className="model-card-head">
                  <span className="provider-logo">
                    <Bot size={17} />
                  </span>
                  <span
                    className={`status-chip ${!available ? "warning" : ""}`}
                  >
                    {available ? "available" : blockers[0]}
                  </span>
                </div>
                {!available && blockers.length > 1 && (
                  <p className="model-blockers">Blocked by: {blockers.join(" · ")}</p>
                )}
                <h3>{model.displayName}</h3>
                <code>{model.publicModelId}</code>
                <p>
                  {provider?.displayName ?? "Unknown provider"} · upstream {model.upstreamModelId}
                </p>
                <div className="capabilities">
                  {model.capabilities.map((capability) => <i key={capability}>{capability}</i>)}
                </div>
                <dl className="model-facts">
                  <div>
                    <dt>Context</dt>
                    <dd>{model.contextWindow.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Current input</dt>
                    <dd>
                      {current
                        ? `$${formatMicrosAsUsd(current.inputMicrosPerMillion)} / 1M`
                        : "Not priced"}
                    </dd>
                  </div>
                  <div>
                    <dt>Price revisions</dt>
                    <dd>{model.prices.length}</dd>
                  </div>
                </dl>
                {model.prices.length > 0 && (
                  <details className="price-history">
                    <summary>Pricing history</summary>
                    {[...model.prices].sort((a, b) =>
                      Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt)
                    ).map((price) => (
                      <div key={price.id}>
                        <time>{dateTime(price.effectiveAt)}</time>
                        <span>
                          in ${formatMicrosAsUsd(price.inputMicrosPerMillion)}{" "}
                          · cached ${formatMicrosAsUsd(price.cachedInputMicrosPerMillion)}{" "}
                          · reasoning ${formatMicrosAsUsd(price.reasoningMicrosPerMillion)}{" "}
                          · out ${formatMicrosAsUsd(price.outputMicrosPerMillion)}{" "}
                          · call ${formatMicrosAsUsd(price.fixedCallMicros)}
                        </span>
                        <small>
                          {price.id === current?.id
                            ? "Active"
                            : Date.parse(price.effectiveAt) > Date.now()
                            ? "Scheduled"
                            : "Historical"} · {price.source}
                        </small>
                      </div>
                    ))}
                  </details>
                )}
                <div className="provider-actions">
                  <button
                    className="secondary"
                    aria-label={`Edit ${model.displayName}`}
                    onClick={() => setEditing(model)}
                  >
                    Edit
                  </button>
                  <button
                    className="secondary"
                    aria-label={`Add pricing for ${model.displayName}`}
                    onClick={() => setPricing(model)}
                  >
                    Add price
                  </button>
                </div>
              </article>
            );
          })}
          {filtered.length === 0 && search && (
            <div className="registry-state">No models match your search.</div>
          )}
        </div>
      </QueryState>
      {editing && (
        <ModelForm
          model={editing === "new" ? undefined : editing}
          providers={providers.data ?? []}
          close={() => setEditing(undefined)}
        />
      )}
      {pricing && <PriceForm model={pricing} close={() => setPricing(undefined)} />}
    </>
  );
}
