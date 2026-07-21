import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Globe2, LoaderCircle, Square, X } from "lucide-react";
import { api, ApiError, type ToolExecution } from "./api.ts";
import { Modal } from "./Modal.tsx";

const terminal = (status: ToolExecution["status"]) =>
  status === "succeeded" || status === "failed" || status === "cancelled";
const refundPending = (status: ToolExecution["status"]) =>
  status === "failed_pending_refund" || status === "cancelled_pending_refund";
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
  const [pollRevision, setPollRevision] = useState(0);
  const operationGeneration = useRef(0);
  const actionController = useRef<AbortController | undefined>(undefined);
  const pollController = useRef<AbortController | undefined>(undefined);
  const invalidateOperations = () => {
    operationGeneration.current += 1;
    actionController.current?.abort();
    pollController.current?.abort();
    actionController.current = undefined;
    pollController.current = undefined;
  };
  const beginAction = () => {
    invalidateOperations();
    const generation = operationGeneration.current;
    const controller = new AbortController();
    actionController.current = controller;
    return { controller, generation };
  };
  useEffect(() => () => invalidateOperations(), []);
  useEffect(() => {
    if (!execution || terminal(execution.status)) return;
    const executionId = execution.id;
    const generation = ++operationGeneration.current;
    const controller = new AbortController();
    pollController.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => operationGeneration.current === generation && !controller.signal.aborted;
    const poll = async () => {
      try {
        const next = await api.toolExecution(executionId, controller.signal);
        if (!current()) return;
        setError("");
        setExecution((existing) => existing?.id === executionId ? next : existing);
        if (!terminal(next.status)) timer = setTimeout(() => void poll(), 500);
      } catch (reason) {
        if (!current() || reason instanceof DOMException && reason.name === "AbortError") return;
        setError(errorText(reason));
        timer = setTimeout(() => void poll(), 1_500);
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (pollController.current === controller) pollController.current = undefined;
      if (operationGeneration.current === generation) operationGeneration.current += 1;
    };
  }, [execution?.id, execution?.status, pollRevision]);
  if (!open) return null;
  const dismiss = () => {
    invalidateOperations();
    setExecution(undefined);
    setBusy(false);
    setError("");
    setQuery("");
    close();
  };
  const webSearch = tools.data?.find((tool) => tool.id === "web_search");
  const run = async () => {
    const { controller, generation } = beginAction();
    setBusy(true);
    setError("");
    try {
      const next = await api.requestToolExecution(
        "web_search",
        { query: query.trim() },
        controller.signal,
      );
      if (operationGeneration.current === generation) setExecution(next);
    } catch (reason) {
      if (operationGeneration.current === generation && !controller.signal.aborted) {
        setError(errorText(reason));
      }
    } finally {
      if (operationGeneration.current === generation) {
        actionController.current = undefined;
        setBusy(false);
      }
    }
  };
  const approve = async () => {
    if (!execution) return;
    const { controller, generation } = beginAction();
    setBusy(true);
    setError("");
    try {
      const next = await api.approveToolExecution(execution.id, controller.signal);
      if (operationGeneration.current === generation) {
        setExecution(next);
        if (!terminal(next.status)) setPollRevision((current) => current + 1);
      }
    } catch (reason) {
      if (operationGeneration.current === generation && !controller.signal.aborted) {
        setError(errorText(reason));
        setPollRevision((current) => current + 1);
      }
    } finally {
      if (operationGeneration.current === generation) {
        actionController.current = undefined;
        setBusy(false);
      }
    }
  };
  const cancel = async () => {
    if (!execution) return;
    const { controller, generation } = beginAction();
    setBusy(true);
    setError("");
    try {
      const next = await api.cancelToolExecution(execution.id, controller.signal);
      if (operationGeneration.current === generation) {
        setExecution(next);
        if (!terminal(next.status)) setPollRevision((current) => current + 1);
      }
    } catch (reason) {
      if (operationGeneration.current === generation && !controller.signal.aborted) {
        setError(errorText(reason));
        setPollRevision((current) => current + 1);
      }
    } finally {
      if (operationGeneration.current === generation) {
        actionController.current = undefined;
        setBusy(false);
      }
    }
  };
  return (
    <Modal title="Web search" close={dismiss}>
      <p className="modal-description">
        Search runs only after your explicit approval. Its result can be attached to your next
        immutable chat branch.
      </p>
      {tools.isError && (
        <div className="inline-error" role="alert">
          <p>{errorText(tools.error)}</p>
          <button type="button" className="secondary" onClick={() => void tools.refetch()}>
            Try loading tools again
          </button>
        </div>
      )}
      {!webSearch && !tools.isLoading && !tools.isError && (
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
          {!terminal(execution.status) && execution.status !== "pending_approval" &&
            !refundPending(execution.status) && (
            <p>
              <LoaderCircle className="spin" size={17} /> Searching…
            </p>
          )}
          {refundPending(execution.status) && (
            <p>
              <LoaderCircle className="spin" size={17} /> Finalizing account refund…
            </p>
          )}
          {!terminal(execution.status) && !refundPending(execution.status) && (
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
                  dismiss();
                }}
              >
                <Check size={16} /> Add to next message
              </button>
            </>
          )}
          {execution.error && (
            <p className="inline-error" role="alert">{execution.error.message}</p>
          )}
          {execution.status === "failed" && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setExecution(undefined);
                setError("");
              }}
            >
              Try search again
            </button>
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
