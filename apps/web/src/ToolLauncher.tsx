import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Globe2, LoaderCircle, Square, X } from "lucide-react";
import { api, ApiError, type ToolExecution } from "./api.ts";
import { Modal } from "./Modal.tsx";

const terminal = (status: ToolExecution["status"]) =>
  status === "succeeded" || status === "failed" || status === "cancelled";
const errorText = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "The tool request failed";
export function toolResultForMessage(execution: ToolExecution, maxCharacters = 50_000) {
  const serialized = JSON.stringify(execution.result, null, 2);
  const bounded = serialized.length <= maxCharacters
    ? serialized
    : `${serialized.slice(0, maxCharacters)}\n… result truncated for chat context`;
  return `\n\nWeb search result (approved execution ${execution.id}):\n${bounded}`;
}

export function ToolLauncher({ open, close, insert }: {
  open: boolean;
  close: () => void;
  insert: (execution: ToolExecution) => void;
}) {
  const tools = useQuery({ queryKey: ["tools"], queryFn: api.tools, enabled: open });
  const [query, setQuery] = useState("");
  const [execution, setExecution] = useState<ToolExecution>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!execution || terminal(execution.status)) return;
    const timer = setInterval(() => {
      void api.toolExecution(execution.id).then(setExecution).catch((reason) =>
        setError(errorText(reason))
      );
    }, 500);
    return () => clearInterval(timer);
  }, [execution?.id, execution?.status]);
  if (!open) return null;
  const webSearch = tools.data?.find((tool) => tool.id === "web_search");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setExecution(await api.requestToolExecution("web_search", { query: query.trim() }));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!execution) return;
    setBusy(true);
    setError("");
    try {
      setExecution(await api.approveToolExecution(execution.id));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!execution) return;
    setBusy(true);
    try {
      setExecution(await api.cancelToolExecution(execution.id));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Web search" close={close}>
      <p className="modal-description">
        Search runs only after your explicit approval. Its result can be attached to your next
        immutable chat branch.
      </p>
      {!webSearch && !tools.isLoading && (
        <p className="inline-error" role="alert">Web search is not enabled by an administrator.</p>
      )}
      {!execution && webSearch && (
        <div className="tool-launch-form">
          <label>
            <span>Search query</span>
            <input
              data-autofocus
              value={query}
              maxLength={1000}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="primary" disabled={busy || !query.trim()} onClick={run}>
            <Globe2 size={16} /> Review search
          </button>
        </div>
      )}
      {execution && (
        <section className="tool-execution-status" aria-live="polite">
          <p>
            <strong>Status:</strong> {execution.status.replaceAll("_", " ")}
          </p>
          {execution.status === "pending_approval" && (
            <button className="primary" disabled={busy} onClick={approve}>
              <Check size={16} /> Approve this search
            </button>
          )}
          {!terminal(execution.status) && execution.status !== "pending_approval" && (
            <p>
              <LoaderCircle className="spin" size={17} /> Searching…
            </p>
          )}
          {!terminal(execution.status) && (
            <button className="secondary" disabled={busy} onClick={cancel}>
              <Square size={14} /> Cancel
            </button>
          )}
          {execution.status === "succeeded" && (
            <>
              <pre>{JSON.stringify(execution.result, null, 2)}</pre>
              <button
                className="primary"
                onClick={() => {
                  insert(execution);
                  close();
                }}
              >
                <Check size={16} /> Add to next message
              </button>
            </>
          )}
          {execution.error && (
            <p className="inline-error" role="alert">{execution.error.message}</p>
          )}
          {execution.status === "cancelled" && (
            <p>
              <X size={16} /> Search cancelled.
            </p>
          )}
        </section>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </Modal>
  );
}
