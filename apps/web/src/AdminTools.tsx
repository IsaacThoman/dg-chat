import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, RefreshCw, Save, ShieldAlert } from "lucide-react";
import { type AdminTool, api, ApiError } from "./api.ts";

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error
    ? error.message
    : "The policy could not be saved";
export const parseAllowedDomains = (
  value: string,
) => [
  ...new Set(value.split(/[\n,]/).map((domain) => domain.trim().toLowerCase()).filter(Boolean)),
];

function PolicyCard({ tool }: { tool: AdminTool }) {
  const client = useQueryClient();
  const [allowed, setAllowed] = useState(tool.policy?.allowed ?? false);
  const [domains, setDomains] = useState((tool.policy?.allowedDomains ?? []).join("\n"));
  const [privateNetwork, setPrivateNetwork] = useState(tool.policy?.allowPrivateNetwork ?? false);
  const save = useMutation({
    mutationFn: () =>
      api.updateAdminTool(tool, {
        allowed,
        allowedDomains: parseAllowedDomains(domains),
        allowPrivateNetwork: privateNetwork,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin-tools"] }),
  });
  return (
    <article className="table-card full tool-policy-card">
      <header className="tool-policy-head">
        <span className="brand-mark">
          <Globe2 size={18} />
        </span>
        <div>
          <h3>{tool.definition.name}</h3>
          <p>{tool.definition.description}</p>
        </div>
        <label className="tool-policy-toggle">
          <input
            type="checkbox"
            checked={allowed}
            onChange={(event) => setAllowed(event.target.checked)}
          />{" "}
          Enable
        </label>
      </header>
      <label className="form-field">
        <span>Domain allowlist</span>
        <textarea
          rows={3}
          value={domains}
          placeholder="search.example.com"
          onChange={(event) => setDomains(event.target.value)}
          aria-describedby={`${tool.definition.id}-domain-help`}
        />
        <small id={`${tool.definition.id}-domain-help`}>
          One hostname per line. Subdomains are matched explicitly.
        </small>
      </label>
      <label className="tool-private-warning">
        <input
          type="checkbox"
          checked={privateNetwork}
          onChange={(event) => setPrivateNetwork(event.target.checked)}
        />
        <span>
          <ShieldAlert size={16} /> Allow access to private network targets
        </span>
      </label>
      {save.error && <p className="registry-banner" role="alert">{message(save.error)}</p>}
      <footer>
        <span>
          {tool.policy
            ? `Policy version ${tool.policy.version}`
            : "Not configured — denied by default"}
        </span>
        <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          <Save size={16} /> {save.isPending ? "Saving…" : "Save policy"}
        </button>
      </footer>
    </article>
  );
}

export function AdminTools() {
  const tools = useQuery({ queryKey: ["admin-tools"], queryFn: api.adminTools });
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Tools & web search</h1>
          <p>Control which tools users may approve and where they can connect</p>
        </div>
        <button className="secondary" onClick={() => tools.refetch()} disabled={tools.isFetching}>
          <RefreshCw size={16} /> Refresh
        </button>
      </header>
      {tools.isLoading && (
        <div className="registry-state" role="status">
          Loading tool policies…
        </div>
      )}
      {tools.error && <div className="registry-banner" role="alert">{message(tools.error)}</div>}
      {tools.data?.length === 0 && (
        <div className="registry-state">No tool adapters are configured.</div>
      )}
      <div className="tool-policy-grid">
        {tools.data?.map((tool) => (
          <PolicyCard key={`${tool.definition.id}:${tool.policy?.version ?? 0}`} tool={tool} />
        ))}
      </div>
    </>
  );
}
