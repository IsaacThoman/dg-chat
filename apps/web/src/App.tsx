import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Cloud,
  Code2,
  Copy,
  Database,
  Download,
  Ellipsis,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Globe2,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Upload,
  UserCheck,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { api } from "./api.ts";
import {
  beginInFlight,
  conversationForFirstSend,
  endInFlight,
  mergeAttachmentIds,
  operationForMessage,
  refreshConversationGraph,
  type SendOperation,
  tokenScopesFromSelection,
} from "./chatWorkflow.ts";
import {
  activeMessagePath,
  conversationTree,
  type MessageBranch,
  messageBranch,
  type MessageTreeNode,
  preferredLeaf,
} from "./conversationGraph.ts";
import { demoConversations, demoMessages, demoModels, demoUser } from "./demo.ts";
import { setupDestination } from "./setupDiscovery.ts";
import {
  type ConversationListView,
  conversationsForView,
  fallbackConversationId,
} from "./conversationLifecycle.ts";
import type { Attachment, Conversation, Message, Model, Token, User } from "./types.ts";

type View = "chat" | "archived" | "trash" | "settings" | "tokens" | "admin";
type AdminSection =
  | "overview"
  | "applicants"
  | "users"
  | "providers"
  | "models"
  | "usage"
  | "jobs"
  | "audit"
  | "storage";
const cn = (...v: Array<string | false | null | undefined>) => v.filter(Boolean).join(" ");

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Sparkles size={17} />
      </span>
      {!compact && (
        <>
          <strong>DG Chat</strong>
          <span className="beta">SELF-HOSTED</span>
        </>
      )}
    </div>
  );
}

function IconButton(
  { label, children, className, onClick, disabled, ariaHaspopup, ariaExpanded }: {
    label: string;
    children: ReactNode;
    className?: string;
    onClick?: () => void;
    disabled?: boolean;
    ariaHaspopup?: "menu";
    ariaExpanded?: boolean;
  },
) {
  return (
    <button
      type="button"
      className={cn("icon-button", className)}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-haspopup={ariaHaspopup}
      aria-expanded={ariaExpanded}
    >
      {children}
    </button>
  );
}

function Avatar({ user, small = false }: { user: User; small?: boolean }) {
  return (
    <span className={cn("avatar", small && "avatar-small")}>
      {user.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}
    </span>
  );
}

function Sidebar({
  conversations,
  active,
  onOpen,
  view,
  setView,
  mobileOpen,
  closeMobile,
  user,
  onUpdate,
  listError,
  listLoading,
  staleWarning,
  retryList,
}: {
  conversations: Conversation[];
  active: string;
  onOpen: (id: string) => void;
  view: View;
  setView: (v: View) => void;
  mobileOpen: boolean;
  closeMobile: () => void;
  user: User;
  onUpdate: (
    conversation: Conversation,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ) => Promise<void>;
  listError: boolean;
  listLoading: boolean;
  staleWarning: boolean;
  retryList: () => void;
}) {
  const [query, setQuery] = useState("");
  const listView: ConversationListView = view === "archived" || view === "trash" ? view : "chat";
  const visible = conversationsForView(conversations, listView);
  const filtered = visible.filter((c) =>
    `${c.title} ${c.preview}`.toLowerCase().includes(query.toLowerCase())
  );
  const select = (v: View) => {
    setView(v);
    closeMobile();
  };
  return (
    <aside className={cn("sidebar", mobileOpen && "mobile-open")}>
      <div className="sidebar-head">
        <Brand />
        <IconButton label="Close sidebar" className="mobile-only" onClick={closeMobile}>
          <X size={19} />
        </IconButton>
      </div>
      <button
        className="new-chat"
        onClick={() => {
          onOpen("new");
          select("chat");
        }}
      >
        <Plus size={18} /> New chat <kbd>⌘ K</kbd>
      </button>
      <label className="search">
        <Search size={16} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
        />
        <span>⌘F</span>
      </label>
      <nav className="side-nav">
        <button onClick={() => select("chat")} className={view === "chat" ? "selected" : ""}>
          <MessageSquare size={17} /> Chats
        </button>
        <button type="button">
          <Folder size={17} /> Projects <Plus size={15} className="push" />
        </button>
        <button type="button">
          <BookOpen size={17} /> Knowledge
        </button>
        <button
          onClick={() => select("archived")}
          className={view === "archived" ? "selected" : ""}
        >
          <Archive size={17} /> Archived
        </button>
        <button onClick={() => select("trash")} className={view === "trash" ? "selected" : ""}>
          <Trash2 size={17} /> Trash
        </button>
      </nav>
      <div className="conversation-scroll">
        {listLoading && (
          <div className="empty-mini" role="status">
            <div className="typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <span>Loading conversations…</span>
          </div>
        )}
        {listError && (
          <div className="empty-mini" role="alert">
            <span>Conversations are unavailable</span>
            <button className="secondary" onClick={retryList}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        )}
        {staleWarning && (
          <div className="stale-warning" role="status">
            <span>Showing saved conversations. Refresh failed.</span>
            <button onClick={retryList}>Retry</button>
          </div>
        )}
        {!listLoading && !listError && (
          <>
            {filtered.some((c) => c.pinned) && <p className="section-label">PINNED</p>}
            {filtered.filter((c) => c.pinned).map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                active={active === c.id &&
                  (view === "chat" || view === "archived" || view === "trash")}
                onOpen={onOpen}
                listView={listView}
                onUpdate={onUpdate}
              />
            ))}
            <p className="section-label">RECENT</p>
            {filtered.filter((c) => !c.pinned).map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                active={active === c.id &&
                  (view === "chat" || view === "archived" || view === "trash")}
                onOpen={onOpen}
                listView={listView}
                onUpdate={onUpdate}
              />
            ))}
            {!filtered.length && (
              <div className="empty-mini">
                <Search size={20} />
                <span>
                  {listView === "archived"
                    ? "No archived conversations"
                    : listView === "trash"
                    ? "Trash is empty"
                    : "No conversations found"}
                </span>
              </div>
            )}
          </>
        )}
      </div>
      <div className="sidebar-footer">
        {user.role === "admin" && (
          <button
            className={view === "admin" ? "selected" : ""}
            onClick={() => select("admin")}
          >
            <ShieldCheck size={17} /> Admin console
          </button>
        )}
        <button
          className={view === "settings" || view === "tokens" ? "selected" : ""}
          onClick={() => select("settings")}
        >
          <Settings size={17} /> Settings
        </button>
        <button className="user-row" onClick={() => select("settings")}>
          <Avatar user={user} />
          <span>
            <strong>{user.name}</strong>
            <small>${user.balance.toFixed(2)} remaining</small>
          </span>
          <MoreHorizontal size={17} className="push" />
        </button>
      </div>
    </aside>
  );
}

function ConversationRow(
  { c, active, onOpen, listView, onUpdate }: {
    c: Conversation;
    active: boolean;
    onOpen: (id: string) => void;
    listView: ConversationListView;
    onUpdate: (
      conversation: Conversation,
      patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
    ) => Promise<void>;
  },
) {
  const [menu, setMenu] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const [rename, setRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rowRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const closeMenu = () => {
    setMenu(false);
    requestAnimationFrame(() => actionRef.current?.focus());
  };
  const update = async (patch: Parameters<typeof onUpdate>[1]) => {
    setBusy(true);
    setError("");
    try {
      await onUpdate(c, patch);
      if (patch.pinned !== undefined) {
        setMenu(false);
        requestAnimationFrame(() => {
          document.querySelector<HTMLButtonElement>(
            `[data-conversation-actions="${CSS.escape(c.id)}"]`,
          )?.focus();
        });
      } else setMenu(false);
      return true;
    } catch {
      setError("Action failed. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      ref={rowRef}
      className={cn("conversation-row", active && "active")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu) {
          event.preventDefault();
          closeMenu();
        }
      }}
    >
      <button className="conversation-open" onClick={() => onOpen(c.id)}>
        <span>
          <strong>{c.title}</strong>
          <small>{c.preview}</small>
        </span>
        <span className="row-meta">{c.updatedAt}</span>
      </button>
      <button
        ref={actionRef}
        className="icon-button"
        type="button"
        title={`Actions for ${c.title}`}
        aria-label={`Actions for ${c.title}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        data-conversation-actions={c.id}
        onClick={() => {
          if (!menu) {
            const rowBottom = rowRef.current?.getBoundingClientRect().bottom ?? 0;
            setMenuUp(rowBottom + 190 > globalThis.innerHeight);
          }
          setMenu(!menu);
        }}
      >
        <Ellipsis size={16} />
      </button>
      {menu && (
        <div
          className={cn("conversation-menu", menuUp && "menu-up")}
          role="menu"
          onKeyDown={(event) => {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ),
            ];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: HTMLButtonElement | undefined;
            if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
            if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
            if (event.key === "Home") next = items[0];
            if (event.key === "End") {
              next = items.at(-1);
            }
            if (next) {
              event.preventDefault();
              next.focus();
            }
          }}
        >
          {listView === "chat" && (
            <button
              autoFocus
              role="menuitem"
              onClick={() => {
                actionRef.current?.focus();
                setRename(true);
                setMenu(false);
              }}
            >
              <Pencil size={14} /> Rename
            </button>
          )}
          {listView === "chat" && (
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => update({ pinned: !c.pinned })}
            >
              <Pin size={14} /> {c.pinned ? "Unpin" : "Pin"}
            </button>
          )}
          {listView === "chat" && (
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => update({ archived: true })}
            >
              <Archive size={14} /> Archive
            </button>
          )}
          {listView === "archived" && (
            <button
              autoFocus
              role="menuitem"
              disabled={busy}
              onClick={() => update({ archived: false })}
            >
              <RotateCcw size={14} /> Restore to chats
            </button>
          )}
          {listView === "trash" && (
            <button
              autoFocus
              role="menuitem"
              disabled={busy}
              onClick={() => update({ deleted: false })}
            >
              <RotateCcw size={14} /> {c.archived ? "Restore to Archived" : "Restore to Chats"}
            </button>
          )}
          {listView !== "trash" && (
            <button
              className="menu-danger"
              role="menuitem"
              onClick={() => {
                actionRef.current?.focus();
                setConfirmDelete(true);
                setMenu(false);
              }}
            >
              <Trash2 size={14} /> Move to trash
            </button>
          )}
        </div>
      )}
      {error && <span className="conversation-error" role="status">{error}</span>}
      {rename && (
        <RenameConversationDialog
          conversation={c}
          close={() => setRename(false)}
          save={async (title) => {
            const saved = await update({ title });
            if (saved) setRename(false);
            return saved;
          }}
        />
      )}
      {confirmDelete && (
        <Modal
          title="Move conversation to trash?"
          close={() => setConfirmDelete(false)}
          dismissible={!busy}
        >
          <p className="muted">“{c.title}” can be restored later from Trash.</p>
          <div className="modal-actions">
            <button className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                if (await update({ deleted: true })) setConfirmDelete(false);
              }}
            >
              Move to trash
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RenameConversationDialog(
  { conversation, close, save }: {
    conversation: Conversation;
    close: () => void;
    save: (title: string) => Promise<boolean>;
  },
) {
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = title.trim();
    if (!next) return;
    setBusy(true);
    setError("");
    try {
      if (!await save(next)) setError("Rename failed. Try again.");
    } catch {
      setError("Rename failed. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Rename conversation" close={close} dismissible={!busy}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Conversation title</span>
          <input
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error && <p className="form-error" role="status">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ModelPicker(
  { models, selected, setSelected }: {
    models: Model[];
    selected: string;
    setSelected: (id: string) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const model = models.find((m) => m.id === selected) ?? models[0];
  return (
    <div className="model-picker">
      <button className="model-trigger" onClick={() => setOpen(!open)}>
        <span className="model-glyph">{model?.provider[0]}</span>
        <span>
          <strong>{model?.name ?? "Select model"}</strong>
          <small>{model?.provider} · {model?.context}</small>
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="model-popover">
          <div className="popover-title">
            Choose a model <SlidersHorizontal size={15} />
          </div>
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                setSelected(m.id);
                setOpen(false);
              }}
            >
              <span className={cn("health-dot", !m.healthy && "down")} />
              <span>
                <strong>{m.name}</strong>
                <small>{m.provider} · {m.context} context</small>
              </span>
              <span className="capabilities">{m.capabilities.map((c) => <i key={c}>{c}</i>)}</span>
              {selected === m.id && <Check size={17} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BranchControl(
  { branch, onTree, onSelect, busy, readOnly = false }: {
    branch: MessageBranch;
    onTree: () => void;
    onSelect: (messageId: string) => void;
    busy: boolean;
    readOnly?: boolean;
  },
) {
  return (
    <div className="branch-control" aria-label={`Branch ${branch.index} of ${branch.total}`}>
      <IconButton
        label="Previous branch"
        disabled={!branch.previousId || busy || readOnly}
        onClick={() => branch.previousId && onSelect(branch.previousId)}
      >
        <ChevronLeft size={15} />
      </IconButton>
      <span aria-live="polite">{branch.index} / {branch.total}</span>
      <IconButton
        label="Next branch"
        disabled={!branch.nextId || busy || readOnly}
        onClick={() => branch.nextId && onSelect(branch.nextId)}
      >
        <ChevronRight size={15} />
      </IconButton>
      <IconButton label="View conversation tree" onClick={onTree}>
        <GitBranch size={15} />
      </IconButton>
    </div>
  );
}

function MessageItem(
  { message, branch, onTree, onEdit, onSelectBranch, branchBusy, readOnly = false }: {
    message: Message;
    branch: MessageBranch | null;
    onTree: () => void;
    onEdit: (m: Message) => void;
    onSelectBranch: (messageId: string) => void;
    branchBusy: boolean;
    readOnly?: boolean;
  },
) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  if (message.role === "user") {
    return (
      <article className="message user-message">
        <div className="message-inner">
          <div className="user-bubble">
            {message.attachments?.map((a) => (
              <a
                className="attachment"
                key={a.id}
                href={`/api/messages/${message.id}/attachments/${a.id}/content`}
              >
                <span>
                  <FileText size={19} />
                </span>
                <div>
                  <strong>{a.filename}</strong>
                  <small>{a.mimeType} · {Math.max(1, Math.ceil(a.sizeBytes / 1024))} KB</small>
                </div>
              </a>
            ))}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
          <div className="message-actions user-actions">
            <span>{message.createdAt}</span>
            <IconButton label="Copy" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </IconButton>
            {!readOnly && (
              <IconButton
                label="Edit without overwriting"
                onClick={() => onEdit(message)}
              >
                <Pencil size={15} />
              </IconButton>
            )}
            {branch && (
              <BranchControl
                branch={branch}
                onTree={onTree}
                onSelect={onSelectBranch}
                busy={branchBusy}
                readOnly={readOnly}
              />
            )}
          </div>
        </div>
      </article>
    );
  }
  return (
    <article className="message assistant-message">
      <div className="message-inner">
        <div className="assistant-label">
          <span className="assistant-avatar">
            <Sparkles size={16} />
          </span>
          <strong>{message.model ?? "Assistant"}</strong>
        </div>
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {message.content}
          </ReactMarkdown>
        </div>
        <div className="message-actions">
          <IconButton label="Copy response" onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
          <IconButton label="Read aloud (not available yet)" disabled>
            <Volume2 size={15} />
          </IconButton>
          {!readOnly && (
            <IconButton label="Regenerate response (not available yet)" disabled>
              <RefreshCw size={15} />
            </IconButton>
          )}
          <IconButton label="More response actions (not available yet)" disabled>
            <MoreHorizontal size={15} />
          </IconButton>
          {branch && (
            <BranchControl
              branch={branch}
              onTree={onTree}
              onSelect={onSelectBranch}
              busy={branchBusy}
              readOnly={readOnly}
            />
          )}
          <span className="response-meta">{message.latency}</span>
        </div>
      </div>
    </article>
  );
}

function Composer(
  { onSend, edit, cancelEdit, disabled }: {
    onSend: (value: string, attachmentIds: string[]) => Promise<boolean>;
    edit?: Message;
    cancelEdit: () => void;
    disabled: boolean;
  },
) {
  const [value, setValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  type UploadState =
    | "uploading"
    | "ready"
    | "failed"
    | "cancelled"
    | "not-ready"
    | "removing"
    | "delete-failed";
  type UploadItem = {
    key: string;
    file: File;
    status: UploadState;
    progress: number;
    attachment?: Attachment;
    error?: string;
  };
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [excludedEditAttachments, setExcludedEditAttachments] = useState<Set<string>>(new Set());
  const uploadControllers = useRef(new Map<string, AbortController>());
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => {
    for (const controller of uploadControllers.current.values()) controller.abort();
    uploadControllers.current.clear();
  }, []);
  useEffect(() => {
    setExcludedEditAttachments(new Set());
    if (edit) setValue(edit.content);
  }, [edit]);
  const retainedAttachments = (edit?.attachments ?? []).filter((attachment) =>
    !excludedEditAttachments.has(attachment.id)
  );
  const beginUpload = (key: string, file: File) => {
    const controller = new AbortController();
    uploadControllers.current.set(key, controller);
    setUploads((current) =>
      current.map((item) =>
        item.key === key ? { ...item, status: "uploading", progress: 0, error: undefined } : item
      )
    );
    void api.uploadAttachment(
      file,
      (progress) =>
        setUploads((current) =>
          current.map((item) => item.key === key ? { ...item, progress } : item)
        ),
      controller.signal,
    ).then((attachment) => {
      uploadControllers.current.delete(key);
      setUploads((current) =>
        current.map((item) =>
          item.key === key
            ? attachment.state === "ready"
              ? { ...item, status: "ready", progress: 100, attachment }
              : {
                ...item,
                status: "not-ready",
                progress: 100,
                attachment,
                error: `Upload is ${attachment.state}; it is not ready to send.`,
              }
            : item
        )
      );
    }).catch((error: unknown) => {
      uploadControllers.current.delete(key);
      setUploads((current) =>
        current.map((item) =>
          item.key === key
            ? {
              ...item,
              status: controller.signal.aborted ? "cancelled" : "failed",
              error: controller.signal.aborted
                ? "Upload cancelled."
                : error instanceof Error
                ? error.message
                : "Upload failed.",
            }
            : item
        )
      );
    });
  };
  const addFiles = (files: File[]) => {
    if (disabled || !files.length) return;
    const allowed = files.filter((file) => file.size <= 25 * 1024 * 1024);
    const selected = allowed.slice(
      0,
      Math.max(0, 10 - uploads.length - retainedAttachments.length),
    );
    if (allowed.length !== files.length) {
      setSelectionError("Each attachment must be 25 MB or smaller.");
    } else if (selected.length !== files.length) {
      setSelectionError("You can attach up to 10 files to one message.");
    } else {
      setSelectionError("");
    }
    for (const file of selected) {
      const key = crypto.randomUUID();
      setUploads((current) => [
        ...current,
        { key, file, status: "uploading", progress: 0 },
      ]);
      queueMicrotask(() => beginUpload(key, file));
    }
  };
  const removeUpload = async (item: UploadItem) => {
    if (item.status === "uploading") {
      uploadControllers.current.get(item.key)?.abort();
      return;
    }
    if (!item.attachment) {
      setUploads((current) => current.filter((candidate) => candidate.key !== item.key));
      return;
    }
    setUploads((current) =>
      current.map((candidate) =>
        candidate.key === item.key
          ? { ...candidate, status: "removing", error: undefined }
          : candidate
      )
    );
    try {
      await api.deleteAttachment(item.attachment.id);
      setUploads((current) => current.filter((candidate) => candidate.key !== item.key));
    } catch {
      setUploads((current) =>
        current.map((candidate) =>
          candidate.key === item.key
            ? { ...candidate, status: "delete-failed", error: "Couldn’t remove this upload." }
            : candidate
        )
      );
    }
  };
  const blockedByUpload = uploads.some((item) => item.status !== "ready");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || disabled || blockedByUpload) return;
    const attachmentIds = mergeAttachmentIds(
      retainedAttachments.map((attachment) => attachment.id),
      uploads.flatMap((item) => item.attachment ? [item.attachment.id] : []),
    );
    if (await onSend(value.trim(), attachmentIds)) {
      setValue("");
      setUploads([]);
    }
  };
  return (
    <div
      className={cn("composer-wrap", dragging && "dragging")}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        addFiles([...event.dataTransfer.files]);
      }}
    >
      {edit && (
        <div className="edit-banner">
          <GitBranch size={16} />
          <span>
            <strong>Create a new branch</strong>
            <small>The original message and every response after it will stay intact.</small>
          </span>
          <IconButton label="Cancel edit" onClick={cancelEdit}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {(retainedAttachments.length > 0 || uploads.length > 0) && (
        <div className="upload-list" aria-label="Selected attachments" aria-live="polite">
          {retainedAttachments.map((attachment) => (
            <div className="upload-chip upload-ready" key={`retained-${attachment.id}`}>
              <FileText size={18} aria-hidden="true" />
              <span>
                <strong>{attachment.filename}</strong>
                <small>Retained from the original branch</small>
              </span>
              <IconButton
                label={`Exclude attachment ${attachment.filename} from edited branch`}
                onClick={() =>
                  setExcludedEditAttachments((current) =>
                    new Set(current).add(attachment.id)
                  )}
              >
                <X size={15} />
              </IconButton>
            </div>
          ))}
          {uploads.map((item) => (
            <div className={cn("upload-chip", `upload-${item.status}`)} key={item.key}>
              <FileText size={18} aria-hidden="true" />
              <span>
                <strong>{item.file.name}</strong>
                <small>
                  {item.status === "ready"
                    ? `${Math.max(1, Math.ceil(item.file.size / 1024))} KB · Ready`
                    : item.status === "uploading"
                    ? `Uploading ${item.progress}%`
                    : item.status === "removing"
                    ? "Removing…"
                    : item.error}
                </small>
                {item.status === "uploading" && (
                  <progress
                    max="100"
                    value={item.progress}
                    aria-label={`Upload ${item.file.name}`}
                  />
                )}
              </span>
              {(item.status === "failed" || item.status === "cancelled") && (
                <IconButton
                  label={`Retry upload ${item.file.name}`}
                  onClick={() => beginUpload(item.key, item.file)}
                >
                  <RefreshCw size={15} />
                </IconButton>
              )}
              {item.status === "delete-failed" && (
                <IconButton
                  label={`Retry removing ${item.file.name}`}
                  onClick={() => removeUpload(item)}
                >
                  <RefreshCw size={15} />
                </IconButton>
              )}
              <IconButton
                label={item.status === "uploading"
                  ? `Cancel upload ${item.file.name}`
                  : `Remove attachment ${item.file.name}`}
                disabled={item.status === "removing"}
                onClick={() =>
                  void removeUpload(item)}
              >
                <X size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {selectionError && <p className="form-error" role="alert">{selectionError}</p>}
      <form className="composer" onSubmit={submit}>
        <textarea
          rows={1}
          disabled={disabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) void submit(e);
          }}
          placeholder="Message DG Chat…"
          aria-label="Message"
        />
        <div className="composer-tools">
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <IconButton
            label="Attach files"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={19} />
          </IconButton>
          <button
            type="button"
            className="tool-pill"
            disabled
            aria-label="Web search (not available yet)"
            title="Web search (not available yet)"
          >
            <Globe2 size={16} /> Search
          </button>
          <button
            type="button"
            className="tool-pill"
            disabled
            aria-label="Tools (not available yet)"
            title="Tools (not available yet)"
          >
            <Code2 size={16} /> Tools
          </button>
          <span className="push" />
          <IconButton
            label="Voice input (not available yet)"
            disabled
          >
            <Mic size={19} />
          </IconButton>
          <button
            className="send-button"
            aria-label="Send"
            disabled={!value.trim() || disabled || blockedByUpload}
          >
            <ArrowDown size={19} />
          </button>
        </div>
      </form>
      <p className="composer-note">
        AI can make mistakes. Check important information. <span>Shift + Enter for new line</span>
      </p>
    </div>
  );
}

function TreePanel({
  messages,
  activeLeafId,
  close,
  onSelect,
  busy,
  readOnly = false,
  returnFocus,
}: {
  messages: Message[];
  activeLeafId?: string | null;
  close: () => void;
  onSelect: (messageId: string) => void;
  busy: boolean;
  readOnly?: boolean;
  returnFocus?: HTMLElement | null;
}) {
  const roots = conversationTree(messages, activeLeafId);
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const busyRef = useRef(busy);
  const previousFocus = useRef<HTMLElement | null>(null);
  closeRef.current = close;
  busyRef.current = busy;
  useEffect(() => {
    previousFocus.current = returnFocus ?? document.activeElement as HTMLElement;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [role="treeitem"]:not([aria-disabled="true"])',
        ),
      ];
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      requestAnimationFrame(() => previousFocus.current?.focus());
    };
  }, []);
  return (
    <div className="drawer-overlay" onClick={() => !busyRef.current && closeRef.current()}>
      <aside
        ref={panelRef}
        className="tree-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <div>
            <p className="eyebrow">IMMUTABLE HISTORY</p>
            <h2 id={titleId}>Conversation tree</h2>
          </div>
          <IconButton label="Close" disabled={busy} onClick={close}>
            <X size={19} />
          </IconButton>
        </div>
        <p className="muted">
          Every edit creates a new path. Your original messages and responses are always
          recoverable.
        </p>
        <div
          className="tree"
          role="tree"
          aria-label="Conversation branches"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>(
              '[role="treeitem"]:not([aria-disabled="true"])',
            )];
            const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
            const index = current ? items.indexOf(current) : -1;
            const next = event.key === "Home"
              ? items[0]
              : event.key === "End"
              ? items.at(-1)
              : event.key === "ArrowDown"
              ? items[Math.min(items.length - 1, index + 1)]
              : items[Math.max(0, index - 1)];
            if (next) {
              event.preventDefault();
              next.focus();
            }
          }}
        >
          {roots.length
            ? roots.map((root) => (
              <TreeNode
                key={root.message.id}
                node={root}
                onSelect={onSelect}
                busy={busy}
                readOnly={readOnly}
              />
            ))
            : <p className="muted">This conversation does not have any messages yet.</p>}
        </div>
        <div className="info-card">
          <Lock size={18} />
          <span>
            <strong>Nothing is overwritten</strong>
            <small>Branches retain attachments, timing, model, and generation metadata.</small>
          </span>
        </div>
      </aside>
    </div>
  );
}
function TreeNode(
  { node, onSelect, busy, readOnly }: {
    node: MessageTreeNode;
    onSelect: (messageId: string) => void;
    busy: boolean;
    readOnly: boolean;
  },
) {
  const disabled = busy || readOnly;
  return (
    <div
      className="tree-subtree"
      role="treeitem"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-current={node.active ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onSelect(node.message.id);
      }}
      onKeyDown={(event) => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopPropagation();
          onSelect(node.message.id);
        }
      }}
    >
      <div className={cn("tree-node", node.active && "active")}>
        <span>{node.message.role === "user" ? "I" : <Sparkles size={13} />}</span>
        <div>
          <small>{node.message.role === "user" ? "You" : "Assistant"}</small>
          <strong>{node.message.content || "Empty message"}</strong>
        </div>
        {node.active && <Check size={14} />}
      </div>
      {node.children.length > 0 && (
        <div className="tree-children" role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.message.id}
              node={child}
              onSelect={onSelect}
              busy={busy}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatView({
  conversations,
  activeId,
  messages,
  models,
  selectedModel,
  setSelectedModel,
  onMenu,
  balance,
  onConversationCreated,
  onUpdateConversation,
  readOnly = false,
}: {
  conversations: Conversation[];
  activeId: string;
  messages: Message[];
  models: Model[];
  selectedModel: string;
  setSelectedModel: (id: string) => void;
  onMenu: () => void;
  balance: number;
  onConversationCreated: (id: string) => Promise<void>;
  onUpdateConversation: (
    conversation: Conversation,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ) => Promise<void>;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [localMessages, setLocalMessages] = useState(messages);
  const [tree, setTree] = useState(false);
  const treeReturnFocusRef = useRef<HTMLElement | null>(null);
  const [edit, setEdit] = useState<Message>();
  const [streaming, setStreaming] = useState(false);
  const sendInFlightRef = useRef(false);
  const pendingOperationRef = useRef<SendOperation | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [sendError, setSendError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const initialConversation = conversations.find((c) => c.id === activeId);
  const [conversation, setConversation] = useState(initialConversation);
  useEffect(() => setLocalMessages(messages), [messages]);
  useEffect(() => setConversation(initialConversation), [initialConversation]);
  const activePath = useMemo(
    () => activeMessagePath(localMessages, conversation?.activeLeafId),
    [localMessages, conversation?.activeLeafId],
  );
  const selectBranch = async (messageId: string) => {
    if (!conversation || branchBusy || readOnly) return;
    const leafId = preferredLeaf(localMessages, messageId);
    if (leafId === conversation.activeLeafId) return;
    setBranchBusy(true);
    setSendError("");
    try {
      setConversation(await api.setActiveLeaf(conversation, leafId));
    } catch {
      const refreshed = await refreshConversationGraph(conversation.id, {
        load: api.conversationGraph,
      });
      queryClient.setQueryData(["messages", conversation.id], refreshed.messages);
      setConversation(refreshed.conversation);
      setLocalMessages(refreshed.messages);
      setSendError("That branch changed in another tab. The latest conversation has been loaded.");
    } finally {
      setBranchBusy(false);
    }
  };
  const send = async (content: string, attachmentIds: string[]): Promise<boolean> => {
    if (!beginInFlight(sendInFlightRef)) return false;
    const fingerprint = JSON.stringify({
      content,
      attachmentIds,
      model: selectedModel,
      parentId: edit ? edit.parentId : conversation?.activeLeafId ?? null,
      supersedesId: edit?.id ?? null,
    });
    const operation = operationForMessage(pendingOperationRef.current, fingerprint);
    pendingOperationRef.current = operation;
    const edited = edit;
    setStreaming(true);
    setSendError("");
    try {
      const resolved = await conversationForFirstSend(activeId, conversation, {
        load: api.conversation,
        create: () => api.createConversation("New chat", operation.id),
      });
      const target = resolved.conversation;
      if (resolved.created) setConversation(target);
      const result = await api.generate(
        target,
        content,
        selectedModel,
        edited,
        operation.id,
        attachmentIds,
      );
      setLocalMessages((current) => {
        const next = [...current, result.user, result.assistant];
        queryClient.setQueryData(["messages", result.conversation.id], next);
        return next;
      });
      setConversation(result.conversation);
      setEdit(undefined);
      if (resolved.created) await onConversationCreated(result.conversation.id);
      pendingOperationRef.current = null;
      return true;
    } catch {
      if (activeId) {
        const [refreshedMessages, refreshedConversation] = await Promise.all([
          api.messages(activeId),
          api.conversation(activeId),
        ]);
        queryClient.setQueryData(["messages", activeId], refreshedMessages);
        setLocalMessages(refreshedMessages);
        setConversation(refreshedConversation);
      }
      setSendError("The message could not be sent. Refresh the conversation and try again.");
      return false;
    } finally {
      endInFlight(sendInFlightRef);
      setStreaming(false);
    }
  };
  return (
    <main className="chat-main">
      <header className="chat-header">
        <IconButton label="Open menu" className="mobile-only" onClick={onMenu}>
          <Menu size={20} />
        </IconButton>
        <ModelPicker models={models} selected={selectedModel} setSelected={setSelectedModel} />
        <div className="header-actions">
          <span className="balance-pill">
            <CircleDollarSign size={15} /> ${balance.toFixed(2)}
          </span>
          <IconButton label="Share conversation (not available yet)" disabled>
            <Upload size={18} />
          </IconButton>
          <IconButton label="Conversation options (not available yet)" disabled>
            <MoreHorizontal size={19} />
          </IconButton>
        </div>
      </header>
      <div className="chat-scroll">
        <div className="chat-title">
          <h1>{conversation?.title ?? "New conversation"}</h1>
          <button onClick={() => setRenaming(true)} disabled={!conversation || readOnly}>
            <Pencil size={14} /> Rename
          </button>
        </div>
        {activePath.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            branch={messageBranch(localMessages, m.id)}
            onTree={() => {
              treeReturnFocusRef.current = document.activeElement as HTMLElement;
              setTree(true);
            }}
            onEdit={setEdit}
            onSelectBranch={selectBranch}
            branchBusy={branchBusy}
            readOnly={readOnly}
          />
        ))}
        {streaming && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
        {sendError && <p className="form-error">{sendError}</p>}
      </div>
      {readOnly
        ? (
          <div className="read-only-banner" role="status">
            <Lock size={16} /> Restore this conversation to Chats before editing or continuing it.
          </div>
        )
        : (
          <Composer
            onSend={send}
            edit={edit}
            cancelEdit={() => setEdit(undefined)}
            disabled={streaming}
          />
        )}
      {tree && (
        <TreePanel
          messages={localMessages}
          activeLeafId={conversation?.activeLeafId}
          close={() => setTree(false)}
          onSelect={selectBranch}
          busy={branchBusy}
          readOnly={readOnly}
          returnFocus={treeReturnFocusRef.current}
        />
      )}
      {renaming && conversation && (
        <RenameConversationDialog
          conversation={conversation}
          close={() => setRenaming(false)}
          save={async (title) => {
            await onUpdateConversation(conversation, { title });
            setRenaming(false);
            return true;
          }}
        />
      )}
    </main>
  );
}

const settingsNav = [
  { id: "account", label: "Account", icon: Users },
  { id: "appearance", label: "Appearance", icon: Sun },
  { id: "personalization", label: "Personalization", icon: SlidersHorizontal },
  { id: "data", label: "Data & privacy", icon: Database },
  { id: "tokens", label: "API tokens", icon: KeyRound },
  { id: "usage", label: "Usage & credits", icon: CircleDollarSign },
];
function SettingsView(
  { user, initial = "account", onMenu }: { user: User; initial?: string; onMenu: () => void },
) {
  const [section, setSection] = useState(initial);
  const [theme, setTheme] = useState("System");
  return (
    <main className="page-main">
      <header className="admin-mobile-head">
        <IconButton label="Open menu" onClick={onMenu}>
          <Menu size={20} />
        </IconButton>
        <strong>Settings</strong>
      </header>
      <PageHeader title="Settings" subtitle="Manage your account and workspace preferences" />
      <div className="settings-layout">
        <nav className="settings-nav">
          {settingsNav.map(({ id, label, icon: Icon }) => (
            <button
              className={section === id ? "active" : ""}
              key={id}
              onClick={() => setSection(id)}
            >
              <Icon size={18} />
              {label}
              <ChevronRight size={15} className="push" />
            </button>
          ))}
        </nav>
        <section className="settings-content">
          {section === "account" && (
            <>
              <SectionTitle title="Account" subtitle="Your profile and sign-in information" />
              <div className="profile-row">
                <Avatar user={user} />
                <div>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </div>
                <button className="secondary push">Change avatar</button>
              </div>
              <Field label="Display name" value={user.name} />
              <Field label="Email address" value={user.email} />
              <div className="setting-row">
                <span>
                  <strong>Password</strong>
                  <small>Last changed 3 months ago</small>
                </span>
                <button className="secondary">Change password</button>
              </div>
              <div className="danger-zone">
                <h3>Danger zone</h3>
                <div className="setting-row">
                  <span>
                    <strong>Delete account</strong>
                    <small>Schedule your account and data for deletion.</small>
                  </span>
                  <button className="danger-button">Delete account</button>
                </div>
              </div>
            </>
          )}
          {section === "appearance" && (
            <>
              <SectionTitle title="Appearance" subtitle="Choose how DG Chat looks on this device" />
              <div className="theme-grid">
                {["Light", "Dark", "System"].map((t) => (
                  <button
                    key={t}
                    className={theme === t ? "selected" : ""}
                    onClick={() => setTheme(t)}
                  >
                    <div className={`theme-preview ${t.toLowerCase()}`}>
                      <span />
                      <i />
                      <i />
                    </div>
                    <span>{t}{theme === t && <Check size={15} />}</span>
                  </button>
                ))}
              </div>
              <ToggleRow
                title="Compact conversations"
                subtitle="Show more conversations in the sidebar"
              />
              <ToggleRow title="Reduce motion" subtitle="Minimize non-essential animations" />
            </>
          )}
          {section === "personalization" && (
            <>
              <SectionTitle
                title="Personalization"
                subtitle="Shape how assistants respond to you"
              />
              <label className="field">
                <span>Custom instructions</span>
                <textarea
                  rows={6}
                  defaultValue="Prefer direct, technically precise answers. Ask before making destructive changes."
                />
              </label>
              <ToggleRow
                title="Use conversation memory"
                subtitle="Allow relevant details to carry between conversations"
                on
              />
            </>
          )}
          {section === "data" && (
            <>
              <SectionTitle
                title="Data & privacy"
                subtitle="Control storage, exports, and retention"
              />
              <ToggleRow
                title="Save conversation history"
                subtitle="Temporary chats are never included"
                on
              />
              <ToggleRow
                title="Store provider payloads"
                subtitle="Off by default; intended for debugging only"
              />
              <div className="setting-row">
                <span>
                  <strong>Export your data</strong>
                  <small>Download conversations, files, and settings as JSON.</small>
                </span>
                <button className="secondary">
                  <Download size={16} /> Export
                </button>
              </div>
            </>
          )}
          {section === "tokens" && <TokenSettings />}
          {section === "usage" && <UsageSettings />}
        </section>
      </div>
    </main>
  );
}
function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </div>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input defaultValue={value} />
    </label>
  );
}
function ToggleRow(
  { title, subtitle, on = false }: { title: string; subtitle: string; on?: boolean },
) {
  const [enabled, setEnabled] = useState(on);
  return (
    <div className="setting-row">
      <span>
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
      <button
        aria-label={title}
        className={cn("toggle", enabled && "on")}
        onClick={() => setEnabled(!enabled)}
      >
        <i />
      </button>
    </div>
  );
}

function TokenSettings() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [modal, setModal] = useState(false);
  const [revealed, setRevealed] = useState("");
  const [name, setName] = useState("");
  const [chatScope, setChatScope] = useState(true);
  const [modelsScope, setModelsScope] = useState(true);
  const [filesReadScope, setFilesReadScope] = useState(false);
  const [filesWriteScope, setFilesWriteScope] = useState(false);
  useEffect(() => {
    api.tokens().then(setTokens).catch(() => setTokens([]));
  }, []);
  const create = async () => {
    const scopes = tokenScopesFromSelection({
      chat: chatScope,
      models: modelsScope,
      filesRead: filesReadScope,
      filesWrite: filesWriteScope,
    });
    if (!scopes.length) return;
    const result = await api.createToken(name || "New token", scopes);
    setTokens((
      x,
    ) => [...x, {
      id: crypto.randomUUID(),
      name: name || "New token",
      preview: "dg_sk_••••" + result.token.slice(-4).toUpperCase(),
      scopes: [
        ...(chatScope ? ["chat"] : []),
        ...(modelsScope ? ["models"] : []),
        ...(filesReadScope ? ["files:read"] : []),
        ...(filesWriteScope ? ["files:write"] : []),
      ],
      createdAt: "Just now",
    }]);
    setRevealed(result.token);
  };
  return (
    <>
      <div className="title-action">
        <SectionTitle
          title="API tokens"
          subtitle="Use the OpenAI-compatible API from your own tools"
        />
        <button
          className="primary"
          onClick={() => {
            setModal(true);
            setRevealed("");
          }}
        >
          <Plus size={16} /> Create token
        </button>
      </div>
      <div className="api-hint">
        <Terminal size={20} />
        <div>
          <strong>OpenAI-compatible endpoint</strong>
          <code>{location.origin}/v1</code>
        </div>
        <IconButton
          label="Copy endpoint"
          onClick={() => navigator.clipboard?.writeText(`${location.origin}/v1`)}
        >
          <Copy size={16} />
        </IconButton>
      </div>
      <div className="token-list">
        {tokens.map((t) => (
          <div className="token-row" key={t.id}>
            <span className="token-icon">
              <KeyRound size={18} />
            </span>
            <div>
              <strong>{t.name}</strong>
              <code>{t.preview}</code>
              <small>Created {t.createdAt}{t.lastUsed ? ` · Used ${t.lastUsed}` : ""}</small>
            </div>
            <span className="scope-list">{t.scopes.map((s) => <i key={s}>{s}</i>)}</span>
            <IconButton label="Token options (not available yet)" disabled>
              <MoreHorizontal size={17} />
            </IconButton>
          </div>
        ))}
      </div>
      {modal && (
        <Modal
          title={revealed ? "Token created" : "Create API token"}
          close={() => setModal(false)}
        >
          {revealed
            ? (
              <div className="secret-created">
                <div className="success-icon">
                  <Check size={22} />
                </div>
                <p>Copy this token now. For your security, it will never be shown again.</p>
                <div className="secret">
                  <code>{revealed}</code>
                  <IconButton
                    label="Copy token"
                    onClick={() => navigator.clipboard?.writeText(revealed)}
                  >
                    <Copy size={17} />
                  </IconButton>
                </div>
                <button className="primary wide" onClick={() => setModal(false)}>Done</button>
              </div>
            )
            : (
              <div>
                <label className="field">
                  <span>Name</span>
                  <input
                    autoFocus
                    placeholder="e.g. Local scripts"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <p className="form-label">SCOPES</p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={chatScope}
                    onChange={(event) => setChatScope(event.target.checked)}
                  />{" "}
                  Chat completions
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={modelsScope}
                    onChange={(event) => setModelsScope(event.target.checked)}
                  />{" "}
                  List models
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={filesReadScope}
                    onChange={(event) => setFilesReadScope(event.target.checked)}
                  />{" "}
                  Read files
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={filesWriteScope}
                    onChange={(event) => setFilesWriteScope(event.target.checked)}
                  />{" "}
                  Upload and delete files
                </label>
                <div className="modal-actions">
                  <button className="secondary" onClick={() => setModal(false)}>Cancel</button>
                  <button
                    className="primary"
                    disabled={!chatScope && !modelsScope && !filesReadScope && !filesWriteScope}
                    onClick={create}
                  >
                    Create token
                  </button>
                </div>
              </div>
            )}
        </Modal>
      )}
    </>
  );
}
function UsageSettings() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const data = usage.data;
  const balance = (data?.balanceMicros ?? 0) / 1_000_000;
  const spent = (data?.spentMicros ?? 0) / 1_000_000;
  const tokens = (data?.inputTokens ?? 0) + (data?.outputTokens ?? 0);
  return (
    <>
      <SectionTitle
        title="Usage & credits"
        subtitle="Credits are shared across web and API usage"
      />
      <div className="balance-card">
        <div>
          <p>AVAILABLE BALANCE</p>
          <strong>${balance.toFixed(2)}</strong>
          <small>Credit enforcement is active</small>
        </div>
        <div className="mini-chart">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="setting-row">
        <span>
          <strong>All-time usage</strong>
          <small>{data?.calls ?? 0} requests · {tokens.toLocaleString()} tokens</small>
        </span>
        <strong>${spent.toFixed(4)}</strong>
      </div>
      <progress
        className="usage-bar-progress"
        value={Math.min(100, spent / Math.max(0.01, balance + spent) * 100)}
        max="100"
        aria-label="Share of credits used"
      />
    </>
  );
}

function PageHeader(
  { title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode },
) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </header>
  );
}
const adminNav: { id: AdminSection; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "applicants", label: "Applicants", icon: UserCheck },
  { id: "users", label: "Users", icon: Users },
  { id: "providers", label: "Providers", icon: Cloud },
  { id: "models", label: "Models & pricing", icon: Bot },
  { id: "usage", label: "Usage analytics", icon: BarChart3 },
  { id: "jobs", label: "Background jobs", icon: Boxes },
  { id: "audit", label: "Audit log", icon: Shield },
  { id: "storage", label: "Storage & backups", icon: HardDrive },
];
function AdminView({ onMenu }: { onMenu: () => void }) {
  const [section, setSection] = useState<AdminSection>("overview");
  return (
    <main className="admin-main">
      <header className="admin-mobile-head">
        <IconButton label="Open menu" onClick={onMenu}>
          <Menu size={20} />
        </IconButton>
        <select
          className="admin-mobile-section"
          aria-label="Admin section"
          value={section}
          onChange={(event) => setSection(event.target.value as AdminSection)}
        >
          {adminNav.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </header>
      <div className="admin-layout">
        <nav className="admin-nav">
          <div>
            <p className="eyebrow">ADMIN CONSOLE</p>
            <h2>Workspace</h2>
          </div>
          {adminNav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={section === id ? "active" : ""}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <section className="admin-content">
          <AdminSectionContent section={section} setSection={setSection} />
        </section>
      </div>
    </main>
  );
}

function AdminSectionContent(
  { section, setSection }: { section: AdminSection; setSection: (s: AdminSection) => void },
) {
  if (section === "overview") {
    return <AdminOverview setSection={setSection} />;
  }
  if (section === "applicants") {
    return (
      <>
        <PageHeader title="Applicants" subtitle="Review people waiting to join your workspace">
          <button className="secondary">
            <SlidersHorizontal size={16} /> Filter
          </button>
        </PageHeader>
        <div className="table-card full">
          <Applicants />
        </div>
      </>
    );
  }
  if (section === "providers") {
    return <ProviderManagement />;
  }
  if (section === "models") {
    return (
      <GenericAdmin
        title="Models & pricing"
        subtitle="Manage capabilities, aliases, access, and effective pricing"
        icon={Bot}
      />
    );
  }
  if (section === "users") {
    return <UserManagement />;
  }
  if (section === "usage") {
    return (
      <GenericAdmin
        title="Usage analytics"
        subtitle="Explore request volume, latency, tokens, and provider cost"
        icon={BarChart3}
      />
    );
  }
  if (section === "jobs") {
    return (
      <GenericAdmin
        title="Background jobs"
        subtitle="Monitor document ingestion, retention, and retry queues"
        icon={Boxes}
      />
    );
  }
  if (section === "audit") {
    return (
      <GenericAdmin
        title="Audit log"
        subtitle="Review immutable security and administration events"
        icon={Shield}
      />
    );
  }
  return (
    <GenericAdmin
      title="Storage & backups"
      subtitle="Manage object storage, retention, exports, and restore points"
      icon={HardDrive}
    />
  );
}
function AdminOverview({ setSection }: { setSection: (section: AdminSection) => void }) {
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const usage = useQuery({ queryKey: ["admin-usage"], queryFn: api.adminUsage });
  const providers = useQuery({ queryKey: ["admin-providers"], queryFn: api.adminProviders });
  const activeUsers = users.data?.filter((user) => user.status === "approved").length;
  const pendingUsers = users.data?.filter((user) => user.status === "pending").length;
  const value = (number: number | undefined) =>
    number === undefined ? "—" : number.toLocaleString();
  return (
    <>
      <PageHeader
        title="Workspace overview"
        subtitle="Current values reported by this installation"
      />
      <div className="stats-grid">
        <Stat
          icon={Users}
          label="Approved users"
          value={value(activeUsers)}
          trend="Current accounts"
        />
        <Stat
          icon={MessageSquare}
          label="Total requests"
          value={value(usage.data?.calls)}
          trend="All recorded usage"
        />
        <Stat
          icon={UserCheck}
          label="Pending applicants"
          value={value(pendingUsers)}
          trend="Awaiting a decision"
        />
        <Stat
          icon={CircleDollarSign}
          label="Available credits"
          value={usage.data ? `$${(usage.data.balanceMicros / 1_000_000).toFixed(2)}` : "—"}
          trend="Across all users"
        />
      </div>
      <div className="admin-grid">
        <div className="chart-card unavailable-card">
          <BarChart3 size={24} />
          <h3>Historical request chart unavailable</h3>
          <p>The administration API currently reports totals, not time-series data.</p>
        </div>
        <div className="health-card">
          <div className="card-title">
            <div>
              <h3>Provider configuration</h3>
              <p>Current API-reported status</p>
            </div>
            <Activity size={18} />
          </div>
          {providers.isLoading && <div className="empty-mini">Loading providers…</div>}
          {providers.isError && <div className="empty-mini">Provider status is unavailable</div>}
          {!providers.isLoading && !providers.isError && !providers.data?.length && (
            <div className="empty-mini">No providers configured</div>
          )}
          {providers.data?.map((provider) => (
            <div className="provider-health" key={provider.id}>
              <span className={cn("provider-logo", !provider.configured && "warning")}>
                {provider.id[0]?.toUpperCase()}
              </span>
              <span>
                <strong>{provider.id}</strong>
                <small>{provider.configured ? "Configured" : "Not configured"}</small>
              </span>
              <span className="push right">
                <strong>{provider.status}</strong>
              </span>
              <span className={cn("health-dot", provider.status !== "healthy" && "down")} />
            </div>
          ))}
        </div>
      </div>
      <div className="admin-grid lower">
        <div className="table-card">
          <div className="card-title">
            <div>
              <h3>Pending applicants</h3>
              <p>Review account requests awaiting a decision</p>
            </div>
            <button className="link-button" onClick={() => setSection("applicants")}>
              View all <ArrowRight size={15} />
            </button>
          </div>
          <Applicants compact />
        </div>
        <div className="activity-card unavailable-card">
          <Shield size={24} />
          <h3>Recent activity unavailable</h3>
          <p>The API does not expose audit events yet. No example activity is shown.</p>
        </div>
      </div>
    </>
  );
}

function ProviderManagement() {
  const providers = useQuery({ queryKey: ["admin-providers"], queryFn: api.adminProviders });
  return (
    <>
      <PageHeader title="Providers" subtitle="OpenAI-compatible endpoints reported by the server" />
      {providers.isLoading && (
        <div className="generic-admin">
          <p>Loading providers…</p>
        </div>
      )}
      {providers.isError && (
        <div className="generic-admin">
          <Cloud size={28} />
          <h3>Provider status unavailable</h3>
          <p>The server did not return provider configuration data.</p>
        </div>
      )}
      {!providers.isLoading && !providers.isError && !providers.data?.length && (
        <div className="generic-admin">
          <Cloud size={28} />
          <h3>No providers configured</h3>
          <p>Add provider configuration on the server to make models available.</p>
        </div>
      )}
      <div className="provider-grid">
        {providers.data?.map((provider) => (
          <div className="provider-card" key={provider.id}>
            <div>
              <span className="provider-logo">{provider.id[0]?.toUpperCase()}</span>
              <span className={cn("status-chip", provider.status !== "healthy" && "warning")}>
                {provider.status}
              </span>
            </div>
            <h3>{provider.id}</h3>
            <p>
              {provider.configured
                ? "Configured on this installation"
                : "Credentials are not configured"}
            </p>
            <div className="provider-stats">
              <span>
                <small>Configuration</small>
                <strong>{provider.configured ? "Enabled" : "Disabled"}</strong>
              </span>
              <span>
                <small>Latency</small>
                <strong>Unavailable</strong>
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Stat(
  { icon: Icon, label, value, trend }: {
    icon: typeof Users;
    label: string;
    value: string;
    trend: string;
  },
) {
  return (
    <div className="stat-card">
      <span className="stat-icon">
        <Icon size={19} />
      </span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{trend}</small>
      </div>
    </div>
  );
}
function Applicants({ compact = false }: { compact?: boolean }) {
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const applicants = users.data?.filter((user) => user.status === "pending") ?? [];
  const decide = async (id: string, status: "approved" | "rejected") => {
    await api.approveUser(id, status);
    await users.refetch();
  };
  return (
    <div className="data-table">
      {!compact && (
        <div className="table-head">
          <span>APPLICANT</span>
          <span>DETAILS</span>
          <span>REQUESTED</span>
          <span>ACTIONS</span>
        </div>
      )}
      {users.isError && <div className="empty-mini">Applicant data is unavailable</div>}
      {!users.isLoading && !users.isError && !applicants.length && (
        <div className="empty-mini">No pending applicants</div>
      )}
      {applicants.map((applicant) => (
        <div className="applicant-row" key={applicant.id}>
          <Avatar user={applicant} small />
          <span>
            <strong>{applicant.name}</strong>
            <small>{applicant.email}</small>
          </span>
          {!compact && (
            <span className="applicant-detail">
              <small>Intended use</small>
              <strong>Chat and API access</strong>
            </span>
          )}
          <time>Pending</time>
          <span className="applicant-actions">
            <button className="approve" onClick={() => decide(applicant.id, "approved")}>
              <Check size={15} /> Approve
            </button>
            <IconButton label="Reject" onClick={() => decide(applicant.id, "rejected")}>
              <X size={16} />
            </IconButton>
          </span>
        </div>
      ))}
    </div>
  );
}
function UserManagement() {
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const updateState = async (user: User) => {
    await api.setUserState(user.id, user.status === "suspended" ? "active" : "suspended");
    await users.refetch();
  };
  return (
    <>
      <PageHeader title="Users" subtitle="Manage approval, access, roles, and balances" />
      <div className="table-card full data-table">
        <div className="table-head">
          <span>USER</span>
          <span>STATUS</span>
          <span>BALANCE</span>
          <span>ACTIONS</span>
        </div>
        {users.data?.map((user) => (
          <div className="applicant-row" key={user.id}>
            <Avatar user={user} small />
            <span>
              <strong>{user.name}</strong>
              <small>{user.email} · {user.role}</small>
            </span>
            <span className="status-chip">{user.status}</span>
            <strong>${user.balance.toFixed(2)}</strong>
            <button
              className="secondary"
              disabled={user.role === "admin"}
              onClick={() => updateState(user)}
            >
              {user.status === "suspended" ? "Restore" : "Suspend"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
function GenericAdmin(
  { title, subtitle, icon: Icon }: { title: string; subtitle: string; icon: typeof Users },
) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle}>
        <button className="secondary">
          <Download size={16} /> Export CSV
        </button>
      </PageHeader>
      <div className="generic-admin">
        <span>
          <Icon size={28} />
        </span>
        <h3>{title} workspace</h3>
        <p>
          Search, filtering, bulk actions, and detailed controls are ready to connect to the typed
          administration API.
        </p>
        <div className="generic-toolbar">
          <label className="search">
            <Search size={16} />
            <input placeholder={`Search ${title.toLowerCase()}`} />
          </label>
          <button className="primary">
            <Plus size={16} /> Add new
          </button>
        </div>
        <div className="skeleton-table">{[1, 2, 3, 4, 5].map((x) => <i key={x} />)}</div>
      </div>
    </>
  );
}

function Modal(
  { title, close, children, dismissible = true }: {
    title: string;
    close: () => void;
    children: ReactNode;
    dismissible?: boolean;
  },
) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  const dismissibleRef = useRef(dismissible);
  closeRef.current = close;
  dismissibleRef.current = dismissible;
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("[autofocus], input, button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissibleRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      requestAnimationFrame(() => previousFocus.current?.focus());
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={() => dismissibleRef.current && closeRef.current()}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Close" disabled={!dismissible} onClick={close}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const setupQuery = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const userQuery = useQuery({ queryKey: ["me"], queryFn: api.me });
  const conversationQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations });
  const deletedConversationQuery = useQuery({
    queryKey: ["conversations", "deleted"],
    queryFn: api.deletedConversations,
  });
  const modelQuery = useQuery({ queryKey: ["models"], queryFn: api.models });
  const demoMode = import.meta.env.VITE_DEMO_MODE === "true";
  const user = userQuery.data ?? (demoMode ? demoUser : undefined);
  const conversations = conversationQuery.data ?? (demoMode ? demoConversations : []);
  const deletedConversations = deletedConversationQuery.data ?? [];
  const allConversations = [
    ...conversations,
    ...deletedConversations.filter((deleted) =>
      !conversations.some((conversation) => conversation.id === deleted.id)
    ),
  ];
  const models = modelQuery.data ?? (demoMode ? demoModels : []);
  const [activeId, setActiveId] = useState("");
  const [view, setView] = useState<View>("chat");
  const lifecycleQuery = view === "trash" ? deletedConversationQuery : conversationQuery;
  const lifecycleLoading = lifecycleQuery.isLoading;
  const lifecycleBlockingError = lifecycleQuery.isError && lifecycleQuery.data === undefined;
  const lifecycleStaleWarning = lifecycleQuery.isError && lifecycleQuery.data !== undefined;
  const [mobile, setMobile] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [selectedModel, setSelectedModel] = useState(models[0]?.id ?? "openai/gpt-4.1");
  const messagesQuery = useQuery({
    queryKey: ["messages", activeId],
    queryFn: () => api.messages(activeId),
    enabled: Boolean(activeId),
  });
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
  }, []);
  useEffect(() => {
    if (demoMode) return;
    const destination = setupDestination("/", setupQuery.data, userQuery.isError);
    if (destination) location.replace(destination);
  }, [userQuery.isError, setupQuery.data, demoMode]);
  useEffect(() => {
    if (view !== "chat" && view !== "archived" && view !== "trash") return;
    const visible = conversationsForView(allConversations, view);
    if (!visible.some((conversation) => conversation.id === activeId)) {
      setActiveId(visible[0]?.id ?? "");
    }
  }, [activeId, allConversations, view]);
  useEffect(() => {
    if (models.length && !models.some((model) => model.id === selectedModel)) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);
  const open = async (id: string) => {
    if (id !== "new") {
      setActiveId(id);
      setMobile(false);
      return;
    }
    setCreatingConversation(true);
    setView("chat");
    setMobile(false);
    try {
      const resolved = await api.createConversation();
      queryClient.setQueryData<Conversation[]>(
        ["conversations"],
        (current = []) => [resolved, ...current.filter((item) => item.id !== resolved.id)],
      );
      setActiveId(resolved.id);
      await conversationQuery.refetch();
    } finally {
      setCreatingConversation(false);
    }
  };
  const conversationCreated = async (id: string) => {
    await conversationQuery.refetch();
    setActiveId(id);
  };
  const updateConversation = async (
    conversation: Conversation,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ) => {
    const updated = await api.updateConversation(conversation.id, patch);
    const replace = (current: Conversation[] = []) =>
      current.some((item) => item.id === updated.id)
        ? current.map((item) => item.id === updated.id ? updated : item)
        : [updated, ...current];
    queryClient.setQueryData<Conversation[]>(
      ["conversations"],
      (current = []) =>
        updated.deleted ? current.filter((item) => item.id !== updated.id) : replace(current),
    );
    queryClient.setQueryData<Conversation[]>(
      ["conversations", "deleted"],
      (current = []) =>
        updated.deleted ? replace(current) : current.filter((item) => item.id !== updated.id),
    );
    await Promise.allSettled([conversationQuery.refetch(), deletedConversationQuery.refetch()]);
    if (
      conversation.id !== activeId || view === "settings" || view === "tokens" || view === "admin"
    ) return;
    const regular = queryClient.getQueryData<Conversation[]>(["conversations"]) ?? [];
    const deleted = queryClient.getQueryData<Conversation[]>(["conversations", "deleted"]) ?? [];
    const refreshed = [
      ...regular,
      ...deleted.filter((item) => !regular.some((candidate) => candidate.id === item.id)),
    ];
    const listView: ConversationListView = view;
    if (!conversationsForView(refreshed, listView).some((item) => item.id === activeId)) {
      const nextId = fallbackConversationId(refreshed, listView, conversation.id);
      setActiveId(nextId);
      requestAnimationFrame(() => {
        const nextAction = nextId
          ? document.querySelector<HTMLButtonElement>(
            `[data-conversation-actions="${CSS.escape(nextId)}"]`,
          )
          : undefined;
        const fallbacks = [
          ...document.querySelectorAll<HTMLButtonElement>(".lifecycle-empty button, .new-chat"),
        ];
        (nextAction ?? fallbacks.find((button) => button.offsetParent !== null))?.focus();
      });
    }
  };
  if (!user) {
    return <DiscoveryLoading unavailable={setupQuery.isError && userQuery.isError} />;
  }
  return (
    <div className="app-shell">
      <Sidebar
        conversations={allConversations}
        active={activeId}
        onOpen={open}
        view={view}
        setView={setView}
        mobileOpen={mobile}
        closeMobile={() => setMobile(false)}
        user={user}
        onUpdate={updateConversation}
        listError={lifecycleBlockingError}
        listLoading={lifecycleLoading}
        staleWarning={lifecycleStaleWarning}
        retryList={() => {
          void (view === "trash"
            ? deletedConversationQuery.refetch()
            : conversationQuery.refetch());
        }}
      />
      {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
      {(view === "chat" || view === "archived" || view === "trash") && creatingConversation && (
        <main className="chat-main auth-page" aria-label="Creating conversation">
          <div className="typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </main>
      )}
      {(view === "chat" || view === "archived" || view === "trash") && !creatingConversation &&
        activeId && (
        <ChatView
          key={activeId}
          conversations={allConversations}
          activeId={activeId}
          messages={messagesQuery.data ?? (demoMode ? demoMessages : [])}
          models={models}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          onMenu={() => setMobile(true)}
          balance={user.balance}
          onConversationCreated={conversationCreated}
          onUpdateConversation={updateConversation}
          readOnly={view !== "chat"}
        />
      )}
      {(view === "chat" || view === "archived" || view === "trash") && !creatingConversation &&
        !activeId && lifecycleLoading && (
        <main className="chat-main lifecycle-empty" role="status">
          <div className="typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p>Loading conversations…</p>
        </main>
      )}
      {(view === "chat" || view === "archived" || view === "trash") && !creatingConversation &&
        !activeId &&
        !lifecycleLoading && lifecycleBlockingError && (
        <main className="chat-main lifecycle-empty" role="alert">
          <header className="admin-mobile-head lifecycle-mobile-head">
            <IconButton
              label="Open menu"
              onClick={() =>
                setMobile(true)}
            >
              <Menu size={20} />
            </IconButton>
            <strong>Conversations unavailable</strong>
          </header>
          <RefreshCw size={28} />
          <h2>Couldn’t load conversations</h2>
          <p>Check your connection and try again.</p>
          <button
            className="secondary"
            onClick={() =>
              void (view === "trash"
                ? deletedConversationQuery.refetch()
                : conversationQuery.refetch())}
          >
            Retry
          </button>
        </main>
      )}
      {(view === "chat" || view === "archived" || view === "trash") && !creatingConversation &&
        !activeId &&
        !lifecycleLoading && !lifecycleBlockingError && (
        <main className="chat-main lifecycle-empty">
          <header className="admin-mobile-head lifecycle-mobile-head">
            <IconButton label="Open menu" onClick={() => setMobile(true)}>
              <Menu size={20} />
            </IconButton>
            <strong>
              {view === "chat" ? "Chats" : view === "archived" ? "Archived" : "Trash"}
            </strong>
          </header>
          <Archive size={28} />
          <h2>
            {view === "trash"
              ? "Trash is empty"
              : view === "archived"
              ? "No archived conversations"
              : "Start a new conversation"}
          </h2>
          <p>
            {view === "chat"
              ? "Choose New chat to begin."
              : "Conversations moved here will appear in this view."}
          </p>
        </main>
      )}
      {view === "settings" && <SettingsView user={user} onMenu={() => setMobile(true)} />}
      {view === "tokens" && (
        <SettingsView
          user={user}
          initial="tokens"
          onMenu={() => setMobile(true)}
        />
      )}
      {view === "admin" && <AdminView onMenu={() => setMobile(true)} />}
    </div>
  );
}

function AuthCard(
  { children, title, subtitle }: { children: ReactNode; title: string; subtitle: string },
) {
  return (
    <main className="auth-page">
      <div className="auth-ambient one" />
      <div className="auth-ambient two" />
      <div className="auth-card">
        <Brand />
        <div className="auth-title">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {children}
        <p className="auth-footer">
          <Lock size={13} /> Hosted privately on your infrastructure
        </p>
      </div>
    </main>
  );
}
function DiscoveryLoading({ unavailable = false }: { unavailable?: boolean }) {
  return (
    <main className="auth-page" aria-live="polite">
      <div className="auth-card discovery-card">
        <Brand />
        {unavailable
          ? (
            <>
              <h1>Workspace unavailable</h1>
              <p>DG Chat could not reach the server. Check the deployment and try again.</p>
              <button className="secondary wide" onClick={() => location.reload()}>
                <RefreshCw size={16} /> Retry
              </button>
            </>
          )
          : (
            <>
              <div className="typing" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p>Opening your workspace…</p>
            </>
          )}
      </div>
    </main>
  );
}
export function AuthScreen() {
  const setupQuery = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const [signup, setSignup] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const destination = setupDestination("/login", setupQuery.data);
    if (destination) location.replace(destination);
  }, [setupQuery.data]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = signup
        ? await api.signUp(name, email, password)
        : await api.signIn(email, password);
      location.assign(user.status === "approved" ? "/" : "/pending");
    } catch {
      setError("We couldn't sign you in. Check your details and try again.");
    } finally {
      setBusy(false);
    }
  };
  if (setupQuery.isLoading || setupQuery.data?.bootstrapRequired) return <DiscoveryLoading />;
  return (
    <AuthCard
      title={signup ? "Create your account" : "Welcome back"}
      subtitle={signup
        ? "Submit a request to join this workspace."
        : "Sign in to continue to your workspace."}
    >
      <form className="auth-form" onSubmit={submit}>
        {signup && (
          <label>
            <span>Name</span>
            <input
              required
              autoComplete="name"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <label>
          <span>Email address</span>
          <input
            required
            autoComplete="email"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            required
            minLength={8}
            autoComplete={signup ? "new-password" : "current-password"}
            type="password"
            placeholder="••••••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary wide" type="submit" disabled={busy}>
          {busy ? "Please wait…" : signup ? "Request access" : "Continue"}
          <ArrowRight size={17} />
        </button>
      </form>
      {setupQuery.data?.oidcEnabled && (
        <>
          <div className="divider">
            <span>or</span>
          </div>
          <button className="oidc-button" type="button">
            <span>SSO</span> Continue with organization SSO
          </button>
        </>
      )}
      <p className="switch-auth">
        {signup ? "Already have an account?" : "New to this workspace?"}{" "}
        <button onClick={() => setSignup(!signup)}>{signup ? "Sign in" : "Request access"}</button>
      </p>
    </AuthCard>
  );
}
export function SetupScreen() {
  const setupQuery = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const [setupToken, setSetupToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const destination = setupDestination("/setup", setupQuery.data);
    if (destination) location.replace(destination);
  }, [setupQuery.data]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.setup(setupToken, name, email, password);
      location.assign("/login");
    } catch {
      setError("Setup failed. Verify the one-time token and account details.");
    } finally {
      setBusy(false);
    }
  };
  if (setupQuery.isLoading || setupQuery.data && !setupQuery.data.bootstrapRequired) {
    return <DiscoveryLoading />;
  }
  if (setupQuery.data && !setupQuery.data.setupEnabled) {
    return (
      <AuthCard
        title="Setup is not enabled"
        subtitle="This workspace needs an administrator, but bootstrap is disabled."
      >
        <div className="setup-note">
          <ShieldCheck size={20} />
          <span>
            <strong>Configure the server</strong>
            <small>Set the one-time setup token, restart the API, and reload this page.</small>
          </span>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Set up your workspace"
      subtitle="Create the first administrator using your one-time setup token."
    >
      <div className="setup-note">
        <ShieldCheck size={20} />
        <span>
          <strong>Secure bootstrap</strong>
          <small>The first public registrant is never promoted automatically.</small>
        </span>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <label>
          <span>Setup token</span>
          <input
            required
            type="password"
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            placeholder="Paste the token from your environment"
          />
        </label>
        <label>
          <span>Administrator name</span>
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name"
          />
        </label>
        <label>
          <span>Email address</span>
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@company.com"
          />
        </label>
        <label>
          <span>Password</span>
          <input
            required
            minLength={10}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 10 characters"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary wide" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create workspace"} <ArrowRight size={17} />
        </button>
      </form>
    </AuthCard>
  );
}
export function PendingScreen() {
  const me = useQuery({ queryKey: ["pending-me"], queryFn: api.me, refetchInterval: 5000 });
  const status = useQuery({
    queryKey: ["approval-status"],
    queryFn: api.status,
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (status.data?.approvalStatus === "approved" && status.data.state === "active") {
      location.assign("/");
    }
    if (status.isError) location.assign("/login");
  }, [status.data, status.isError]);
  const signOut = async () => {
    await api.signOut();
    location.assign("/login");
  };
  return (
    <AuthCard
      title="Your request is pending"
      subtitle="An administrator needs to approve your account before you can enter the workspace."
    >
      <div className="pending-visual">
        <div>
          <UserCheck size={29} />
        </div>
        <span className="pulse-ring" />
      </div>
      <div className="pending-card">
        <span className="status-chip">Waiting for approval</span>
        <p>
          Signed in as <strong>{me.data?.email ?? "your account"}</strong>
        </p>
        <small>This page will update automatically.</small>
      </div>
      <button className="secondary wide" onClick={() => status.refetch()}>
        <RefreshCw size={16} /> Check status
      </button>
      <button className="text-button" onClick={signOut}>
        <LogOut size={15} /> Sign out
      </button>
    </AuthCard>
  );
}
