import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Link2, ShieldX, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api } from "./api.ts";
import type { PublicShareAttachment } from "./types.ts";

const capabilityPattern = /^[A-Za-z0-9_-]{43}$/;

function Attachment({ capability, attachment }: {
  capability: string;
  attachment: PublicShareAttachment;
}) {
  const href = `/api/public/shares/${encodeURIComponent(capability)}/attachments/${
    encodeURIComponent(attachment.id)
  }`;
  const image = attachment.mimeType.startsWith("image/");
  return (
    <a
      className={`public-share-attachment${image ? " image" : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {image ? <img src={href} alt={attachment.filename} loading="lazy" /> : (
        <span>
          <FileText size={20} />
        </span>
      )}
      <span>
        <strong>{attachment.filename}</strong>
        <small>
          {attachment.mimeType} · {Math.max(1, Math.ceil(attachment.sizeBytes / 1024))} KB
        </small>
      </span>
    </a>
  );
}

export function PublicConversationShareView({ capability }: { capability: string }) {
  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    const previous = existing?.content;
    const meta = existing ?? document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    if (!existing) document.head.append(meta);
    return () => {
      if (!existing) meta.remove();
      else meta.content = previous ?? "";
    };
  }, []);
  const valid = capabilityPattern.test(capability);
  const share = useQuery({
    queryKey: ["public-conversation-share", capability],
    queryFn: () => api.getPublicConversationShare(capability),
    enabled: valid,
    retry: false,
  });

  if (!valid || share.isError) {
    return (
      <main className="public-share-page public-share-unavailable">
        <ShieldX size={30} />
        <h1>Snapshot unavailable</h1>
        <p>This link is invalid, expired, or has been revoked.</p>
      </main>
    );
  }
  if (share.isLoading || !share.data) {
    return (
      <main className="public-share-page public-share-loading" role="status">
        <span className="typing" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <p>Opening shared snapshot…</p>
      </main>
    );
  }
  const value = share.data;
  return (
    <main className="public-share-page">
      <header className="public-share-header">
        <div className="public-share-brand">
          <Sparkles size={17} />
          <strong>DG Chat</strong>
        </div>
        <span>
          <Link2 size={14} /> Read-only snapshot
        </span>
      </header>
      <article className="public-share-document">
        <header>
          <p>
            {value.identity.displayName
              ? `Shared by ${value.identity.displayName}`
              : "Shared anonymously"}
          </p>
          <h1>{value.title}</h1>
          <small>
            Snapshot created {new Date(value.createdAt).toLocaleString()}
            {value.expiresAt ? ` · Expires ${new Date(value.expiresAt).toLocaleString()}` : ""}
          </small>
        </header>
        <div className="public-share-notice">
          This snapshot is pinned to an exact conversation branch. Later edits are not shown.
        </div>
        <section className="public-share-messages" aria-label="Shared conversation">
          {value.messages.map((message) => (
            <article className={`public-share-message ${message.role}`} key={message.id}>
              <div className="public-share-message-label">
                <span>
                  {message.role === "user"
                    ? "Prompt"
                    : message.role === "tool"
                    ? "Tool"
                    : "Assistant"}
                </span>
                {message.model && <small>{message.model}</small>}
              </div>
              {message.attachmentIds.length > 0 && (
                <div className="public-share-attachments">
                  {message.attachmentIds.map((attachmentId) =>
                    value.attachments.find((attachment) => attachment.id === attachmentId)
                  ).filter((attachment): attachment is PublicShareAttachment =>
                    Boolean(attachment)
                  ).map(
                    (attachment) => (
                      <Attachment
                        key={attachment.id}
                        capability={capability}
                        attachment={attachment}
                      />
                    ),
                  )}
                </div>
              )}
              <div className="markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    a: ({ node: _node, ...props }) => (
                      <a {...props} target="_blank" rel="noopener noreferrer" />
                    ),
                    img: ({ node: _node, alt }) => (
                      <span className="public-share-remote-image">
                        Remote image blocked{alt ? `: ${alt}` : ""}
                      </span>
                    ),
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
            </article>
          ))}
        </section>
      </article>
      <footer className="public-share-footer">
        Shared privately from a self-hosted DG Chat workspace.
      </footer>
    </main>
  );
}
