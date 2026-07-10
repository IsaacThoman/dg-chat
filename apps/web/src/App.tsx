import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Terminal,
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
  operationForMessage,
  refreshConversationGraph,
  type SendOperation,
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
import type { Conversation, Message, Model, Token, User } from "./types.ts";

type View = "chat" | "settings" | "tokens" | "admin";
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
  { label, children, className, onClick, disabled }: {
    label: string;
    children: ReactNode;
    className?: string;
    onClick?: () => void;
    disabled?: boolean;
  },
) {
  return (
    <button
      className={cn("icon-button", className)}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
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
}: {
  conversations: Conversation[];
  active: string;
  onOpen: (id: string) => void;
  view: View;
  setView: (v: View) => void;
  mobileOpen: boolean;
  closeMobile: () => void;
  user: User;
}) {
  const [query, setQuery] = useState("");
  const filtered = conversations.filter((c) =>
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
        <button>
          <Folder size={17} /> Projects <Plus size={15} className="push" />
        </button>
        <button>
          <BookOpen size={17} /> Knowledge
        </button>
        <button>
          <Archive size={17} /> Archived
        </button>
      </nav>
      <div className="conversation-scroll">
        {filtered.some((c) => c.pinned) && <p className="section-label">PINNED</p>}
        {filtered.filter((c) => c.pinned).map((c) => (
          <ConversationRow
            key={c.id}
            c={c}
            active={active === c.id && view === "chat"}
            onOpen={onOpen}
          />
        ))}
        <p className="section-label">RECENT</p>
        {filtered.filter((c) => !c.pinned).map((c) => (
          <ConversationRow
            key={c.id}
            c={c}
            active={active === c.id && view === "chat"}
            onOpen={onOpen}
          />
        ))}
        {!filtered.length && (
          <div className="empty-mini">
            <Search size={20} />
            <span>No conversations found</span>
          </div>
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
  { c, active, onOpen }: { c: Conversation; active: boolean; onOpen: (id: string) => void },
) {
  return (
    <button
      className={cn("conversation-row", active && "active")}
      onClick={() => onOpen(c.id)}
    >
      <span>
        <strong>{c.title}</strong>
        <small>{c.preview}</small>
      </span>
      <span className="row-meta">{c.updatedAt}{active && <Ellipsis size={16} />}</span>
    </button>
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
  { branch, onTree, onSelect, busy }: {
    branch: MessageBranch;
    onTree: () => void;
    onSelect: (messageId: string) => void;
    busy: boolean;
  },
) {
  return (
    <div className="branch-control" aria-label={`Branch ${branch.index} of ${branch.total}`}>
      <IconButton
        label="Previous branch"
        disabled={!branch.previousId || busy}
        onClick={() => branch.previousId && onSelect(branch.previousId)}
      >
        <ChevronLeft size={15} />
      </IconButton>
      <span aria-live="polite">{branch.index} / {branch.total}</span>
      <IconButton
        label="Next branch"
        disabled={!branch.nextId || busy}
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
  { message, branch, onTree, onEdit, onSelectBranch, branchBusy }: {
    message: Message;
    branch: MessageBranch | null;
    onTree: () => void;
    onEdit: (m: Message) => void;
    onSelectBranch: (messageId: string) => void;
    branchBusy: boolean;
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
              <div className="attachment" key={a.name}>
                <span>
                  <FileText size={19} />
                </span>
                <div>
                  <strong>{a.name}</strong>
                  <small>{a.type} · {a.size}</small>
                </div>
              </div>
            ))}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
          <div className="message-actions user-actions">
            <span>{message.createdAt}</span>
            <IconButton label="Copy" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </IconButton>
            <IconButton label="Edit without overwriting" onClick={() => onEdit(message)}>
              <Pencil size={15} />
            </IconButton>
            {branch && (
              <BranchControl
                branch={branch}
                onTree={onTree}
                onSelect={onSelectBranch}
                busy={branchBusy}
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
          <IconButton label="Read aloud">
            <Volume2 size={15} />
          </IconButton>
          <IconButton label="Regenerate">
            <RefreshCw size={15} />
          </IconButton>
          <IconButton label="More">
            <MoreHorizontal size={15} />
          </IconButton>
          {branch && (
            <BranchControl
              branch={branch}
              onTree={onTree}
              onSelect={onSelectBranch}
              busy={branchBusy}
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
    onSend: (value: string) => Promise<boolean>;
    edit?: Message;
    cancelEdit: () => void;
    disabled: boolean;
  },
) {
  const [value, setValue] = useState("");
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (edit) setValue(edit.content.replaceAll("**", ""));
  }, [edit]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || disabled) return;
    if (await onSend(value.trim())) setValue("");
  };
  return (
    <div className="composer-wrap">
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
      <form className="composer" onSubmit={submit}>
        <textarea
          rows={1}
          disabled={disabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) void submit(e);
          }}
          placeholder="Message DG Chat…"
          aria-label="Message"
        />
        <div className="composer-tools">
          <input ref={fileRef} type="file" hidden multiple />
          <IconButton
            label="Attach files"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={19} />
          </IconButton>
          <button type="button" className="tool-pill" disabled={disabled}>
            <Globe2 size={16} /> Search
          </button>
          <button type="button" className="tool-pill" disabled={disabled}>
            <Code2 size={16} /> Tools
          </button>
          <span className="push" />
          <IconButton
            label={recording ? "Stop recording" : "Voice input"}
            className={recording ? "recording" : ""}
            disabled={disabled}
            onClick={() => setRecording(!recording)}
          >
            {recording ? <Square size={17} /> : <Mic size={19} />}
          </IconButton>
          <button className="send-button" aria-label="Send" disabled={!value.trim() || disabled}>
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

function TreePanel({ messages, activeLeafId, close, onSelect, busy }: {
  messages: Message[];
  activeLeafId?: string | null;
  close: () => void;
  onSelect: (messageId: string) => void;
  busy: boolean;
}) {
  const roots = conversationTree(messages, activeLeafId);
  return (
    <div className="drawer-overlay" onClick={close}>
      <aside className="tree-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div>
            <p className="eyebrow">IMMUTABLE HISTORY</p>
            <h2>Conversation tree</h2>
          </div>
          <IconButton label="Close" onClick={close}>
            <X size={19} />
          </IconButton>
        </div>
        <p className="muted">
          Every edit creates a new path. Your original messages and responses are always
          recoverable.
        </p>
        <div className="tree" role="tree" aria-label="Conversation branches">
          {roots.length
            ? roots.map((root) => (
              <TreeNode
                key={root.message.id}
                node={root}
                onSelect={onSelect}
                busy={busy}
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
  { node, onSelect, busy }: {
    node: MessageTreeNode;
    onSelect: (messageId: string) => void;
    busy: boolean;
  },
) {
  return (
    <div
      className="tree-subtree"
      role="treeitem"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy || undefined}
      aria-current={node.active ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (!busy) onSelect(node.message.id);
      }}
      onKeyDown={(event) => {
        if (!busy && (event.key === "Enter" || event.key === " ")) {
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
}) {
  const [localMessages, setLocalMessages] = useState(messages);
  const [tree, setTree] = useState(false);
  const [edit, setEdit] = useState<Message>();
  const [streaming, setStreaming] = useState(false);
  const sendInFlightRef = useRef(false);
  const pendingOperationRef = useRef<SendOperation | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [sendError, setSendError] = useState("");
  const initialConversation = conversations.find((c) => c.id === activeId);
  const [conversation, setConversation] = useState(initialConversation);
  useEffect(() => setLocalMessages(messages), [messages]);
  useEffect(() => setConversation(initialConversation), [initialConversation]);
  useEffect(() => {
    // Never carry a previous conversation's optimistic UI into a newly selected chat
    // while its query is still resolving.
    setLocalMessages([]);
    setEdit(undefined);
    setSendError("");
  }, [activeId]);
  const activePath = useMemo(
    () => activeMessagePath(localMessages, conversation?.activeLeafId),
    [localMessages, conversation?.activeLeafId],
  );
  const selectBranch = async (messageId: string) => {
    if (!conversation || branchBusy) return;
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
      setConversation(refreshed.conversation);
      setLocalMessages(refreshed.messages);
      setSendError("That branch changed in another tab. The latest conversation has been loaded.");
    } finally {
      setBranchBusy(false);
    }
  };
  const send = async (content: string): Promise<boolean> => {
    if (!beginInFlight(sendInFlightRef)) return false;
    const operation = operationForMessage(pendingOperationRef.current, content);
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
      const result = await api.generate(target, content, selectedModel, edited, operation.id);
      setLocalMessages((current) => [...current, result.user, result.assistant]);
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
          <IconButton label="Share">
            <Upload size={18} />
          </IconButton>
          <IconButton label="Conversation options">
            <MoreHorizontal size={19} />
          </IconButton>
        </div>
      </header>
      <div className="chat-scroll">
        <div className="chat-title">
          <h1>{conversation?.title ?? "New conversation"}</h1>
          <button>
            <Pencil size={14} /> Rename
          </button>
        </div>
        {activePath.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            branch={messageBranch(localMessages, m.id)}
            onTree={() => setTree(true)}
            onEdit={setEdit}
            onSelectBranch={selectBranch}
            branchBusy={branchBusy}
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
      <Composer
        onSend={send}
        edit={edit}
        cancelEdit={() => setEdit(undefined)}
        disabled={streaming}
      />
      {tree && (
        <TreePanel
          messages={localMessages}
          activeLeafId={conversation?.activeLeafId}
          close={() => setTree(false)}
          onSelect={selectBranch}
          busy={branchBusy}
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
function SettingsView({ user, initial = "account" }: { user: User; initial?: string }) {
  const [section, setSection] = useState(initial);
  const [theme, setTheme] = useState("System");
  return (
    <main className="page-main">
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
  useEffect(() => {
    api.tokens().then(setTokens).catch(() => setTokens([]));
  }, []);
  const create = async () => {
    const result = await api.createToken(name || "New token");
    setTokens((
      x,
    ) => [...x, {
      id: crypto.randomUUID(),
      name: name || "New token",
      preview: "dg_sk_••••" + result.token.slice(-4).toUpperCase(),
      scopes: ["chat", "models"],
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
        <IconButton label="Copy endpoint">
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
            <IconButton label="Token options">
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
                  <input type="checkbox" defaultChecked /> Chat completions
                </label>
                <label className="check-row">
                  <input type="checkbox" defaultChecked /> List models
                </label>
                <label className="check-row">
                  <input type="checkbox" /> Files
                </label>
                <div className="modal-actions">
                  <button className="secondary" onClick={() => setModal(false)}>Cancel</button>
                  <button className="primary" onClick={create}>Create token</button>
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
        <strong>Admin console</strong>
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
  { title, close, children }: { title: string; close: () => void; children: ReactNode },
) {
  return (
    <div className="modal-overlay" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton label="Close" onClick={close}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function App() {
  const setupQuery = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const userQuery = useQuery({ queryKey: ["me"], queryFn: api.me });
  const conversationQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations });
  const modelQuery = useQuery({ queryKey: ["models"], queryFn: api.models });
  const demoMode = import.meta.env.VITE_DEMO_MODE === "true";
  const user = userQuery.data ?? (demoMode ? demoUser : undefined);
  const conversations = conversationQuery.data ?? (demoMode ? demoConversations : []);
  const models = modelQuery.data ?? (demoMode ? demoModels : []);
  const [activeId, setActiveId] = useState("");
  const [view, setView] = useState<View>("chat");
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
    if (!activeId && conversations[0]) setActiveId(conversations[0].id);
  }, [activeId, conversations]);
  useEffect(() => {
    if (models.length && !models.some((model) => model.id === selectedModel)) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);
  const open = async (id: string) => {
    if (id !== "new") {
      setActiveId(id);
      setView("chat");
      setMobile(false);
      return;
    }
    setCreatingConversation(true);
    setView("chat");
    setMobile(false);
    try {
      const resolved = await api.createConversation();
      setActiveId(resolved.id);
      await conversationQuery.refetch();
    } finally {
      setCreatingConversation(false);
    }
  };
  const conversationCreated = async (id: string) => {
    setActiveId(id);
    await conversationQuery.refetch();
  };
  if (!user) {
    return <DiscoveryLoading unavailable={setupQuery.isError && userQuery.isError} />;
  }
  return (
    <div className="app-shell">
      <Sidebar
        conversations={conversations}
        active={activeId}
        onOpen={open}
        view={view}
        setView={setView}
        mobileOpen={mobile}
        closeMobile={() => setMobile(false)}
        user={user}
      />
      {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
      {view === "chat" && creatingConversation && (
        <main className="chat-main auth-page" aria-label="Creating conversation">
          <div className="typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </main>
      )}
      {view === "chat" && !creatingConversation && (
        <ChatView
          key={activeId}
          conversations={conversations}
          activeId={activeId}
          messages={messagesQuery.isFetching
            ? []
            : messagesQuery.data ?? (demoMode ? demoMessages : [])}
          models={models}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          onMenu={() => setMobile(true)}
          balance={user.balance}
          onConversationCreated={conversationCreated}
        />
      )}
      {view === "settings" && <SettingsView user={user} />}
      {view === "tokens" && <SettingsView user={user} initial="tokens" />}
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
