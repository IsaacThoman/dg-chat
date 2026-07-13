import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { Check, Download, FileJson, RefreshCw, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { ConversationPortabilityImportResult } from "./types.ts";

export const PORTABILITY_MAX_BYTES = 16 * 1024 * 1024;

export function validatePortabilityFile(file: Pick<File, "name" | "size" | "type">): string | null {
  if (!/\.(dgchat|json)$/i.test(file.name)) {
    return "Choose a .dgchat file (legacy .json exports are also accepted).";
  }
  if (file.type && file.type !== "application/json") return "The selected file must be JSON.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > PORTABILITY_MAX_BYTES) return "The selected file is larger than 16 MiB.";
  return null;
}

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "The request failed.";

function Summary({ value }: { value: ConversationPortabilityImportResult }) {
  return (
    <dl className="portability-summary" aria-label="Import summary">
      <div>
        <dt>Conversations</dt>
        <dd>{value.conversations}</dd>
      </div>
      <div>
        <dt>Messages</dt>
        <dd>{value.messages}</dd>
      </div>
      <div>
        <dt>Attachment records</dt>
        <dd>{value.attachments}</dd>
      </div>
      <div>
        <dt>Projects</dt>
        <dd>{value.folders}</dd>
      </div>
      <div>
        <dt>Tags</dt>
        <dd>{value.tags}</dd>
      </div>
    </dl>
  );
}

export function UserPortability() {
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [includeTemporary, setIncludeTemporary] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const download = async () => {
    setExporting(true);
    setExportError("");
    try {
      const result = await api.downloadConversationPortability({
        includeDeleted,
        includeTemporary,
      });
      const href = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="portability-card">
        <div className="portability-card-head">
          <span className="portability-icon">
            <Download size={18} />
          </span>
          <span>
            <strong>Export your chat data</strong>
            <small>Download a portable DGCHAT v1 archive.</small>
          </span>
        </div>
        <p>
          Includes preferences, projects, tags, conversations, every message branch, and attachment
          metadata. Attachment object bytes, account credentials, API tokens, billing, and provider
          secrets are never included.
        </p>
        <fieldset className="portability-options">
          <legend>Optional conversations</legend>
          <label>
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(event) => setIncludeDeleted(event.target.checked)}
            />{" "}
            Include deleted conversations
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeTemporary}
              onChange={(event) => setIncludeTemporary(event.target.checked)}
            />{" "}
            Include temporary conversations
          </label>
          <small>
            Archived conversations are included. Temporary and deleted conversations are excluded by
            default.
          </small>
        </fieldset>
        {exportError && <p className="inline-error" role="alert">{exportError}</p>}
        <button
          className="secondary"
          type="button"
          disabled={exporting}
          onClick={() => void download()}
        >
          {exporting ? <RefreshCw className="spin" size={16} /> : <Download size={16} />}
          {exporting ? "Preparing export…" : exportError ? "Retry export" : "Download export"}
        </button>
      </div>

      <div className="portability-card">
        <div className="portability-card-head">
          <span className="portability-icon">
            <Upload size={18} />
          </span>
          <span>
            <strong>Import a DGCHAT archive</strong>
            <small>Preview everything before adding it to your account.</small>
          </span>
        </div>
        <p>
          Import creates new copies with new identifiers. It does not overwrite or delete existing
          chats.
        </p>
        <button className="secondary" type="button" onClick={() => setImportOpen(true)}>
          <Upload size={16} /> Choose archive
        </button>
      </div>
      {importOpen && <ImportDialog close={() => setImportOpen(false)} />}
    </>
  );
}

function ImportDialog({ close }: { close: () => void }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [archive, setArchive] = useState("");
  const [preview, setPreview] = useState<ConversationPortabilityImportResult | null>(null);
  const [result, setResult] = useState<ConversationPortabilityImportResult | null>(null);
  const [status, setStatus] = useState<"idle" | "reading" | "previewing" | "applying">("idle");
  const [error, setError] = useState("");

  const choose = async (next: File | undefined) => {
    if (!next) return;
    const validation = validatePortabilityFile(next);
    setError(validation ?? "");
    setFile(null);
    setArchive("");
    setPreview(null);
    setResult(null);
    if (validation) return;
    idempotencyKey.current = crypto.randomUUID();
    setFile(next);
    setStatus("reading");
    try {
      const text = await next.text();
      JSON.parse(text);
      setArchive(text);
      setStatus("previewing");
      setPreview(await api.importConversationPortability(text, true));
    } catch (caught) {
      setError(
        caught instanceof SyntaxError ? "This file is not valid JSON." : errorMessage(caught),
      );
    } finally {
      setStatus("idle");
    }
  };
  const onInput = (event: ChangeEvent<HTMLInputElement>) => void choose(event.target.files?.[0]);
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  };
  const apply = async () => {
    setStatus("applying");
    setError("");
    try {
      const imported = await api.importConversationPortability(
        archive,
        false,
        idempotencyKey.current,
      );
      setResult(imported);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
        queryClient.invalidateQueries({ queryKey: ["preferences"] }),
      ]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStatus("idle");
    }
  };

  return (
    <Modal
      title={result ? "Import complete" : "Import chat data"}
      close={close}
      dismissible={status === "idle"}
      variant="medium"
    >
      <div className="modal-body portability-dialog">
        {result
          ? (
            <div className="portability-success" role="status">
              <Check size={24} />
              <strong>Your archive was imported.</strong>
              <p>
                {result.replayed
                  ? "This import had already completed; no duplicate data was created."
                  : "New copies were added without changing your existing chats."}
              </p>
              <Summary value={result} />
            </div>
          )
          : (
            <>
              <p>
                DGCHAT v1 .dgchat files up to 16 MiB are accepted. Legacy .json exports also work.
              </p>
              <div
                className={`portability-drop${dragging ? " dragging" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <FileJson size={26} />
                <strong>{file?.name ?? "Drop an export here"}</strong>
                <small>
                  {file
                    ? `${(file.size / 1024).toFixed(1)} KiB`
                    : "or choose a file from this device"}
                </small>
                <button
                  className="secondary"
                  type="button"
                  disabled={status !== "idle"}
                  onClick={() => input.current?.click()}
                >
                  Choose DGCHAT file
                </button>
                <input
                  ref={input}
                  className="visually-hidden"
                  type="file"
                  hidden
                  accept="application/json,.dgchat,.json"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={(event) => {
                    event.currentTarget.value = "";
                  }}
                  onChange={onInput}
                />
              </div>
              {(status === "reading" || status === "previewing") && (
                <p className="portability-progress" role="status">
                  <RefreshCw className="spin" size={15} />{" "}
                  {status === "reading" ? "Reading archive…" : "Checking archive…"}
                </p>
              )}
              {error && <p className="inline-error" role="alert">{error}</p>}
              {preview && (
                <div className="portability-preview">
                  <h3>Ready to import</h3>
                  <Summary value={preview} />
                  <p>
                    This creates new copies. Existing conversations and settings will not be
                    overwritten or deleted.
                  </p>
                </div>
              )}
            </>
          )}
      </div>
      <div className="modal-actions">
        <button className="secondary" type="button" disabled={status !== "idle"} onClick={close}>
          {result ? "Close" : "Cancel"}
        </button>
        {!result && preview && (
          <button
            className="primary"
            type="button"
            disabled={status !== "idle"}
            onClick={() => void apply()}
          >
            {status === "applying" ? "Importing…" : error ? "Retry import" : "Confirm import"}
          </button>
        )}
      </div>
    </Modal>
  );
}
