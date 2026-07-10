import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  FolderPlus,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { Attachment, KnowledgeCollection, KnowledgeMode } from "./types.ts";

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

const ACTIVE_INGESTION_STATES = new Set(["queued", "processing"]);

export function hasActiveIngestion(files: Attachment[] | undefined): boolean {
  return files?.some((file) => ACTIVE_INGESTION_STATES.has(file.ingestionStatus ?? "")) ?? false;
}

export function ingestionStatusText(file: Attachment): string {
  switch (file.ingestionStatus) {
    case "ready":
      return file.ingestedAt
        ? `Extraction ready · completed ${new Date(file.ingestedAt).toLocaleString()}`
        : "Extraction ready";
    case "queued":
      return "Extraction queued — waiting for a worker";
    case "processing":
      return "Extracting and indexing content…";
    case "failed":
      return file.ingestionError
        ? `Extraction failed: ${file.ingestionError}`
        : "Extraction failed. Retry to process this file again.";
    default:
      return `Extraction unavailable · ${file.state.replaceAll("_", " ")}`;
  }
}

export async function retryIngestionAndRefresh(
  attachmentId: string,
  retry: (id: string) => Promise<Attachment>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  await retry(attachmentId);
  await refresh();
}

function AttachmentIngestionStatus(
  { file, retry, busy }: { file: Attachment; retry?: () => void; busy?: boolean },
) {
  const failed = file.ingestionStatus === "failed";
  return (
    <span className={`knowledge-ingestion-status ${failed ? "failed" : ""}`}>
      <small role={failed ? "alert" : "status"}>{ingestionStatusText(file)}</small>
      {failed && retry && (
        <button className="link-button" disabled={busy} onClick={retry}>
          <RefreshCw size={13} /> {busy ? "Retrying…" : "Retry extraction"}
        </button>
      )}
    </span>
  );
}

function StateMessage(
  { title, detail, retry }: { title: string; detail?: string; retry?: () => void },
) {
  return (
    <div className="knowledge-state" role={retry ? "alert" : "status"}>
      <BookOpen size={26} aria-hidden="true" />
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {retry && (
        <button className="secondary" onClick={retry}>
          <RefreshCw size={15} /> Retry
        </button>
      )}
    </div>
  );
}

function CollectionDialog(
  { collection, close, saved }: {
    collection?: KnowledgeCollection;
    close: () => void;
    saved: (collection: KnowledgeCollection) => void;
  },
) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(collection?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = collection
        ? await api.updateCollection(collection, clean)
        : await api.createCollection(clean);
      await queryClient.invalidateQueries({ queryKey: ["collections"] });
      await queryClient.invalidateQueries({ queryKey: ["collections", result.id] });
      saved(result);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={collection ? "Rename collection" : "New collection"}
      close={close}
      dismissible={!busy}
    >
      <form className="knowledge-form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input
            data-autofocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Product documentation"
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button disabled={!name.trim() || busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog(
  { collection, close, deleted }: {
    collection: KnowledgeCollection;
    close: () => void;
    deleted: () => void;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Delete collection?" close={close} dismissible={!busy}>
      <p>
        Delete{" "}
        <strong>{collection.name}</strong>? Files remain in your uploads and conversations. This
        cannot be undone.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={close} disabled={busy}>Cancel</button>
        <button
          className="danger-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api.deleteCollection(collection);
              deleted();
            } catch (caught) {
              setError(errorMessage(caught));
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete collection"}
        </button>
      </div>
    </Modal>
  );
}

function AttachmentPicker(
  { collection, current, close, changed }: {
    collection: KnowledgeCollection;
    current: Attachment[];
    close: () => void;
    changed: () => Promise<void>;
  },
) {
  const files = useQuery({
    queryKey: ["attachments"],
    queryFn: api.attachments,
    refetchInterval: (query) => hasActiveIngestion(query.state.data) ? 2_000 : false,
  });
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryingId, setRetryingId] = useState("");
  const [error, setError] = useState("");
  const available = files.data?.filter((file) => !current.some((item) => item.id === file.id)) ??
    [];
  const isReady = (file: Attachment) => file.ingestionStatus === "ready";
  return (
    <Modal title="Add an uploaded file" close={close} dismissible={!busy}>
      {files.isLoading && <StateMessage title="Loading uploads…" />}
      {files.isError && (
        <StateMessage
          title="Uploads unavailable"
          detail={errorMessage(files.error)}
          retry={() => void files.refetch()}
        />
      )}
      {!files.isLoading && !files.isError && !available.length && (
        <StateMessage
          title="No files available"
          detail="Upload a document in a chat, or remove an existing file from this collection."
        />
      )}
      {available.length > 0 && (
        <div className="knowledge-file-picker" role="radiogroup" aria-label="Uploaded files">
          {available.map((file) => (
            <div className="knowledge-file-picker-row" key={file.id}>
              <label
                className={`${selected === file.id ? "selected" : ""} ${
                  isReady(file) ? "" : "disabled"
                }`}
              >
                <input
                  type="radio"
                  name="attachment"
                  value={file.id}
                  checked={selected === file.id}
                  disabled={!isReady(file)}
                  onChange={() => setSelected(file.id)}
                />
                <FileText size={18} />
                <span>
                  <strong>{file.filename}</strong>
                  <AttachmentIngestionStatus file={file} />
                </span>
                {selected === file.id && <Check size={17} className="push" />}
              </label>
              {file.ingestionStatus === "failed" && (
                <button
                  type="button"
                  className="secondary knowledge-picker-retry"
                  disabled={Boolean(retryingId)}
                  aria-label={`Retry extraction for ${file.filename}`}
                  onClick={() => {
                    setRetryingId(file.id);
                    setError("");
                    void retryIngestionAndRefresh(
                      file.id,
                      api.retryAttachmentIngestion,
                      files.refetch,
                    ).catch((caught) => setError(errorMessage(caught))).finally(() =>
                      setRetryingId("")
                    );
                  }}
                >
                  <RefreshCw size={14} /> {retryingId === file.id ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={close} disabled={busy}>Cancel</button>
        <button
          disabled={!selected || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api.addCollectionAttachment(collection, selected);
              await changed();
              close();
            } catch (caught) {
              setError(errorMessage(caught));
              setBusy(false);
            }
          }}
        >
          {busy ? "Adding…" : "Add file"}
        </button>
      </div>
    </Modal>
  );
}

export function KnowledgeView({ onMenu }: { onMenu: () => void }) {
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | "attach" | null>(null);
  const [actionError, setActionError] = useState("");
  const [retryingAttachmentId, setRetryingAttachmentId] = useState("");
  const filtered = (collections.data ?? []).filter((item) =>
    item.name.toLowerCase().includes(query.toLowerCase())
  );
  const selected = collections.data?.find((item) => item.id === selectedId) ??
    collections.data?.[0];
  useEffect(() => {
    if (!selectedId && collections.data?.[0]) setSelectedId(collections.data[0].id);
  }, [collections.data, selectedId]);
  const detail = useQuery({
    queryKey: ["collections", selected?.id],
    queryFn: () => api.collection(selected!.id),
    enabled: Boolean(selected),
    refetchInterval: (query) => hasActiveIngestion(query.state.data?.attachments) ? 2_000 : false,
  });
  const refresh = async () => {
    await Promise.all([collections.refetch(), detail.refetch()]);
  };
  return (
    <main className="knowledge-main">
      <header className="admin-mobile-head">
        <button className="icon-button" aria-label="Open menu" onClick={onMenu}>
          <Menu size={20} />
        </button>
        <strong>Knowledge</strong>
      </header>
      <div className="knowledge-layout">
        <section className="knowledge-list" aria-label="Knowledge collections">
          <div className="knowledge-heading">
            <div>
              <p className="eyebrow">LIBRARY</p>
              <h1>Knowledge</h1>
            </div>
            <button
              className="icon-button"
              aria-label="Create collection"
              onClick={() => setDialog("create")}
            >
              <FolderPlus size={18} />
            </button>
          </div>
          <label className="search">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search collections"
            />
          </label>
          {collections.isLoading && <StateMessage title="Loading collections…" />}
          {collections.isError && (
            <StateMessage
              title="Collections unavailable"
              detail={errorMessage(collections.error)}
              retry={() => void collections.refetch()}
            />
          )}
          {!collections.isLoading && !collections.isError && !filtered.length && (
            <StateMessage
              title={query ? "No matching collections" : "Build your knowledge library"}
              detail={query
                ? "Try a different search."
                : "Group uploaded documents so conversations can retrieve the right context."}
            />
          )}
          <nav>
            {filtered.map((item) => (
              <button
                key={item.id}
                className={selected?.id === item.id ? "active" : ""}
                onClick={() => setSelectedId(item.id)}
              >
                <BookOpen size={17} />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.attachmentCount === undefined
                      ? "Knowledge collection"
                      : `${item.attachmentCount} ${item.attachmentCount === 1 ? "file" : "files"}`}
                  </small>
                </span>
                <ChevronRight size={16} className="push" />
              </button>
            ))}
          </nav>
          <button className="secondary knowledge-create" onClick={() => setDialog("create")}>
            <Plus size={16} /> New collection
          </button>
        </section>
        <section className="knowledge-detail">
          {!selected && !collections.isLoading && (
            <StateMessage
              title="Select or create a collection"
              detail="Collections make uploaded documents available to a conversation."
            />
          )}
          {selected && (
            <>
              <div className="knowledge-detail-head">
                <div>
                  <p className="eyebrow">COLLECTION</p>
                  <h2>{selected.name}</h2>
                  <p>Choose which of your existing uploads belong in this knowledge source.</p>
                </div>
                <div>
                  <button className="secondary" onClick={() => setDialog("rename")}>
                    <Pencil size={15} /> Rename
                  </button>
                  <button
                    className="icon-button danger-icon"
                    aria-label={`Delete ${selected.name}`}
                    onClick={() => setDialog("delete")}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              {actionError && (
                <div className="inline-error" role="alert">
                  {actionError}
                  <button onClick={() => setActionError("")} aria-label="Dismiss error">
                    <X size={15} />
                  </button>
                </div>
              )}
              {detail.isLoading && <StateMessage title="Loading files…" />}
              {detail.isError && (
                <StateMessage
                  title="Collection unavailable"
                  detail={errorMessage(detail.error)}
                  retry={() => void detail.refetch()}
                />
              )}
              {!detail.isLoading && !detail.isError && !detail.data?.attachments.length && (
                <StateMessage
                  title="No files in this collection"
                  detail="Add one of your uploaded documents to start using it as context."
                />
              )}
              <div className="knowledge-files">
                {detail.data?.attachments.map((file) => (
                  <article key={file.id}>
                    <span className="knowledge-file-icon">
                      <FileText size={20} />
                    </span>
                    <span>
                      <strong>{file.filename}</strong>
                      <small>{(file.sizeBytes / 1024).toFixed(0)} KB · {file.mimeType}</small>
                      <AttachmentIngestionStatus
                        file={file}
                        busy={retryingAttachmentId === file.id}
                        retry={() => {
                          setRetryingAttachmentId(file.id);
                          setActionError("");
                          void api.retryAttachmentIngestion(file.id).then(async () => {
                            await refresh();
                          }).catch((caught) => {
                            setActionError(errorMessage(caught));
                          }).finally(() => setRetryingAttachmentId(""));
                        }}
                      />
                    </span>
                    <button
                      className="icon-button push"
                      aria-label={`Remove ${file.filename} from collection`}
                      onClick={async () => {
                        setActionError("");
                        try {
                          await api.removeCollectionAttachment(detail.data!.collection, file.id);
                          await refresh();
                        } catch (caught) {
                          setActionError(errorMessage(caught));
                        }
                      }}
                    >
                      <Unlink size={17} />
                    </button>
                  </article>
                ))}
              </div>
              <button className="secondary add-knowledge-file" onClick={() => setDialog("attach")}>
                <Plus size={16} /> Add uploaded file
              </button>
            </>
          )}
        </section>
      </div>
      {dialog === "create" && (
        <CollectionDialog
          close={() => setDialog(null)}
          saved={(collection) => {
            setSelectedId(collection.id);
            setDialog(null);
          }}
        />
      )}
      {dialog === "rename" && selected && (
        <CollectionDialog
          collection={selected}
          close={() => setDialog(null)}
          saved={(collection) => {
            setSelectedId(collection.id);
            setDialog(null);
          }}
        />
      )}
      {dialog === "delete" && selected && (
        <DeleteDialog
          collection={selected}
          close={() => setDialog(null)}
          deleted={() => {
            setDialog(null);
            setSelectedId("");
            void collections.refetch();
          }}
        />
      )}
      {dialog === "attach" && detail.data && (
        <AttachmentPicker
          collection={detail.data.collection}
          current={detail.data.attachments}
          close={() => setDialog(null)}
          changed={refresh}
        />
      )}
    </main>
  );
}

export function ConversationKnowledgePicker(
  { conversationId, disabled = false }: { conversationId: string; disabled?: boolean },
) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: api.collections,
  });
  const binding = useQuery({
    queryKey: ["conversation-knowledge", conversationId],
    queryFn: () => api.conversationKnowledge(conversationId),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<KnowledgeMode>("retrieval");
  useEffect(() => {
    if (binding.data) {
      setSelected(binding.data.bindings.map((item) => item.collectionId));
      setMode(binding.data.bindings[0]?.mode ?? "retrieval");
    }
  }, [binding.data]);
  const count = binding.data?.bindings.length ?? 0;
  const loaded = collections.isSuccess && binding.isSuccess && !collections.isError &&
    !binding.isError;
  return (
    <>
      <button
        className="knowledge-trigger"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <BookOpen size={15} /> Knowledge{count ? <span>{count}</span> : null}
      </button>
      {open && (
        <Modal
          title="Conversation knowledge"
          close={() => setOpen(false)}
          dismissible={!saving}
        >
          <p className="modal-description">
            Choose collections for this conversation. Retrieval finds relevant chunks; full context
            includes every processed document within model limits.
          </p>
          {(collections.isLoading || binding.isLoading) && (
            <StateMessage title="Loading knowledge…" />
          )}
          {(collections.isError || binding.isError) && (
            <StateMessage
              title="Knowledge unavailable"
              detail={errorMessage(collections.error ?? binding.error)}
              retry={() => void Promise.all([collections.refetch(), binding.refetch()])}
            />
          )}
          {!collections.isLoading && !collections.isError && !collections.data?.length && (
            <StateMessage
              title="No collections yet"
              detail="Create a collection from Knowledge in the sidebar, then return here."
            />
          )}
          <fieldset className="knowledge-mode" disabled={!loaded || saving}>
            <legend>Context mode</legend>
            {([["retrieval", "Retrieval", "Find only relevant passages"], [
              "full_context",
              "Full context",
              "Include all processed content",
            ]] as const).map(([value, label, detail]) => (
              <label key={value} className={mode === value ? "selected" : ""}>
                <input
                  type="radio"
                  name={`${id}-mode`}
                  checked={mode === value}
                  onChange={() =>
                    setMode(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="knowledge-checks">
            {collections.data?.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  disabled={!loaded || saving}
                  onChange={() =>
                    setSelected((value) =>
                      value.includes(item.id)
                        ? value.filter((id) => id !== item.id)
                        : [...value, item.id]
                    )}
                />
                <BookOpen size={17} />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.attachmentCount === undefined
                      ? "Knowledge collection"
                      : `${item.attachmentCount} files`}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button className="secondary" disabled={saving} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              disabled={!loaded || saving}
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  await api.setConversationKnowledge(conversationId, selected, mode);
                  await binding.refetch();
                  setSaving(false);
                  setOpen(false);
                } catch (caught) {
                  setError(errorMessage(caught));
                  setSaving(false);
                }
              }}
            >
              {saving ? "Saving…" : selected.length ? "Use knowledge" : "Remove knowledge"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
