import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Link2, RefreshCw, Share2, Shield, X } from "lucide-react";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type {
  Conversation,
  ConversationShareSummary,
  Message,
  ShareAttachmentPolicy,
  ShareIdentityVisibility,
} from "./types.ts";

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "The request failed.";

export function createShareCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function shareState(share: ConversationShareSummary): "active" | "expired" | "revoked" {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

function expirationValue(value: "never" | "day" | "week" | "month"): string | null {
  if (value === "never") return null;
  const days = value === "day" ? 1 : value === "week" ? 7 : 30;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function ConversationShareButton({
  conversation,
  messages,
  disabled,
}: {
  conversation: Conversation;
  messages: Message[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const unavailable = disabled || conversation.temporary || conversation.deleted ||
    !conversation.activeLeafId || conversation.version === undefined;
  const reason = conversation.temporary
    ? "Temporary chats cannot be shared"
    : conversation.deleted
    ? "Restore this conversation before sharing"
    : disabled
    ? "Wait for the current response to finish"
    : !conversation.activeLeafId
    ? "Add a completed message before sharing"
    : "Share an immutable snapshot";
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={reason}
        title={reason}
        disabled={unavailable}
        onClick={() => setOpen(true)}
      >
        <Share2 size={18} />
      </button>
      {open && (
        <ShareDialog
          conversation={conversation}
          messages={messages}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareDialog({
  conversation,
  messages,
  close,
}: {
  conversation: Conversation;
  messages: Message[];
  close: () => void;
}) {
  const queryClient = useQueryClient();
  const shares = useQuery({
    queryKey: ["conversation-shares"],
    queryFn: api.listConversationShares,
  });
  const createOperation = useRef<
    {
      fingerprint: string;
      capability: string;
      idempotencyKey: string;
    } | null
  >(null);
  const [identityVisibility, setIdentityVisibility] = useState<ShareIdentityVisibility>(
    "anonymous",
  );
  const [attachmentPolicy, setAttachmentPolicy] = useState<ShareAttachmentPolicy>("redact");
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<"never" | "day" | "week" | "month">("never");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [error, setError] = useState("");
  const [createdUrl, setCreatedUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const attachments = useMemo(
    () => messages.flatMap((message) => message.attachments ?? []),
    [messages],
  );
  const conversationShares = (shares.data ?? []).filter((share) =>
    share.conversationId === conversation.id
  );

  const create = async () => {
    if (!conversation.activeLeafId || conversation.version === undefined) return;
    const expiresAt = expirationValue(expiry);
    const effectiveAttachmentIds = attachmentPolicy === "selected" ? selectedAttachmentIds : [];
    const fingerprint = JSON.stringify({
      leafId: conversation.activeLeafId,
      expectedConversationVersion: conversation.version,
      identityVisibility,
      attachmentPolicy,
      selectedAttachmentIds: [...effectiveAttachmentIds].sort(),
      expiresAt,
    });
    if (createOperation.current?.fingerprint !== fingerprint) {
      createOperation.current = {
        fingerprint,
        capability: createShareCapability(),
        idempotencyKey: crypto.randomUUID(),
      };
    }
    const operation = createOperation.current;
    setCreating(true);
    setError("");
    try {
      const result = await api.createConversationShare({
        conversationId: conversation.id,
        leafId: conversation.activeLeafId,
        expectedConversationVersion: conversation.version,
        identityVisibility,
        attachmentPolicy,
        selectedAttachmentIds: effectiveAttachmentIds,
        expiresAt,
        capability: operation.capability,
        idempotencyKey: operation.idempotencyKey,
      });
      const url = new URL(result.path, globalThis.location.origin);
      if (url.origin !== globalThis.location.origin || !url.pathname.startsWith("/share/")) {
        throw new Error("The server returned an invalid share link.");
      }
      setCreatedUrl(url.toString());
      await queryClient.cancelQueries({ queryKey: ["conversation-shares"] });
      queryClient.setQueryData<ConversationShareSummary[]>(
        ["conversation-shares"],
        (current = []) => [result.share, ...current.filter((item) => item.id !== result.share.id)],
      );
      void queryClient.invalidateQueries({ queryKey: ["conversation-shares"] });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("Copy failed. Select and copy the link manually.");
    }
  };

  const revoke = async (share: ConversationShareSummary) => {
    if (
      !globalThis.confirm("Revoke this share? Anyone with its link will immediately lose access.")
    ) {
      return;
    }
    setRevokingId(share.id);
    setError("");
    try {
      const updated = await api.revokeConversationShare(share.id, share.version);
      queryClient.setQueryData<ConversationShareSummary[]>(
        ["conversation-shares"],
        (current = []) => current.map((item) => item.id === updated.id ? updated : item),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRevokingId("");
    }
  };

  return (
    <Modal title="Share conversation" close={close} dismissible={!creating && !revokingId}>
      <div className="modal-body share-dialog">
        <div className="share-immutable-note">
          <Shield size={18} />
          <p>
            <strong>This creates an immutable snapshot.</strong>
            Future edits and branches will never change it. You can revoke access at any time.
          </p>
        </div>
        {createdUrl
          ? (
            <section className="share-created" aria-live="polite">
              <Check size={24} />
              <h3>Snapshot ready</h3>
              <p>This link is shown once. Store it before closing.</p>
              <div className="share-link-row">
                <input
                  aria-label="Share link"
                  value={createdUrl}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button type="button" className="secondary" onClick={() => void copy()}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <a href={createdUrl} target="_blank" rel="noreferrer" className="share-preview-link">
                Preview snapshot <ExternalLink size={14} />
              </a>
            </section>
          )
          : (
            <>
              <fieldset className="share-options">
                <legend>Identity</legend>
                <label>
                  <input
                    type="radio"
                    name="share-identity"
                    checked={identityVisibility === "anonymous"}
                    onChange={() => setIdentityVisibility("anonymous")}
                  />
                  <span>
                    <strong>Anonymous</strong>
                    <small>Do not show your account name.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="share-identity"
                    checked={identityVisibility === "owner"}
                    onChange={() => setIdentityVisibility("owner")}
                  />
                  <span>
                    <strong>Show my name</strong>
                    <small>Display your current profile name.</small>
                  </span>
                </label>
              </fieldset>
              <fieldset className="share-options">
                <legend>Attachments</legend>
                <label>
                  <input
                    type="radio"
                    name="share-attachments"
                    checked={attachmentPolicy === "redact"}
                    onChange={() => setAttachmentPolicy("redact")}
                  />
                  <span>
                    <strong>Redact all</strong>
                    <small>Share message text without files.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="share-attachments"
                    checked={attachmentPolicy === "include"}
                    onChange={() => setAttachmentPolicy("include")}
                    disabled={attachments.length === 0}
                  />
                  <span>
                    <strong>Include all</strong>
                    <small>
                      {attachments.length === 0
                        ? "This path has no attachments."
                        : `Include ${attachments.length} file${
                          attachments.length === 1 ? "" : "s"
                        }.`}
                    </small>
                  </span>
                </label>
                {attachments.length > 0 && (
                  <label>
                    <input
                      type="radio"
                      name="share-attachments"
                      checked={attachmentPolicy === "selected"}
                      onChange={() => setAttachmentPolicy("selected")}
                    />
                    <span>
                      <strong>Choose files</strong>
                      <small>Include only selected attachments.</small>
                    </span>
                  </label>
                )}
                {attachmentPolicy === "selected" && (
                  <div className="share-attachment-list" aria-label="Attachments to include">
                    {attachments.map((attachment) => (
                      <label key={attachment.id}>
                        <input
                          type="checkbox"
                          checked={selectedAttachmentIds.includes(attachment.id)}
                          onChange={(event) =>
                            setSelectedAttachmentIds((current) =>
                              event.currentTarget.checked
                                ? [...current, attachment.id]
                                : current.filter((id) => id !== attachment.id)
                            )}
                        />
                        <span>{attachment.filename}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <label className="field share-expiry">
                <span>Link expiry</span>
                <select
                  value={expiry}
                  onChange={(event) => setExpiry(event.currentTarget.value as typeof expiry)}
                >
                  <option value="never">Never</option>
                  <option value="day">24 hours</option>
                  <option value="week">7 days</option>
                  <option value="month">30 days</option>
                </select>
              </label>
            </>
          )}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <section className="existing-shares">
          <h3>Previous snapshots</h3>
          {shares.isLoading && <p role="status">Loading snapshots…</p>}
          {shares.isError && (
            <button
              type="button"
              className="secondary"
              onClick={() => void shares.refetch()}
            >
              <RefreshCw size={15} /> Retry loading snapshots
            </button>
          )}
          {!shares.isLoading && !shares.isError && conversationShares.length === 0 && (
            <p>No previous snapshots for this conversation.</p>
          )}
          {conversationShares.map((share) => {
            const state = shareState(share);
            return (
              <article className="share-row" key={share.id}>
                <span className={`share-state ${state}`}>{state}</span>
                <div>
                  <strong>{new Date(share.createdAt).toLocaleString()}</strong>
                  <small>
                    {share.identityVisibility === "anonymous" ? "Anonymous" : "Name visible"}
                    {" · "}
                    {share.attachmentPolicy === "redact" ? "Files redacted" : "Files shared"}
                    {" · "}
                    {share.messageCount} messages
                  </small>
                </div>
                {state === "active" && (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={Boolean(revokingId)}
                    onClick={() => void revoke(share)}
                  >
                    {revokingId === share.id
                      ? <RefreshCw className="spin" size={14} />
                      : <X size={14} />}
                    Revoke
                  </button>
                )}
              </article>
            );
          })}
        </section>
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="secondary"
          disabled={creating || Boolean(revokingId)}
          onClick={close}
        >
          Close
        </button>
        {!createdUrl && (
          <button
            type="button"
            className="primary"
            disabled={creating ||
              (attachmentPolicy === "selected" && selectedAttachmentIds.length === 0)}
            onClick={() => void create()}
          >
            {creating ? <RefreshCw className="spin" size={15} /> : <Link2 size={15} />}
            {creating ? "Creating snapshot…" : "Create snapshot"}
          </button>
        )}
      </div>
    </Modal>
  );
}
