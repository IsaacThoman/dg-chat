import {
  type ChangeEvent,
  type FormEvent,
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { createPortal } from "react-dom";
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
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
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
  Square,
  Sun,
  Trash2,
  Upload,
  UserCheck,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { api, ApiError } from "./api.ts";
import type { AdminSearch, AdminSection } from "./adminRouting.ts";
import { AdminAnalyticsView, AdminJobsView } from "./AdminOperations.tsx";
import { AdminRetentionView } from "./AdminRetention.tsx";
import { AdminBackupsView } from "./AdminBackups.tsx";
import { PersonalTokenSettings } from "./TokenGovernance.tsx";
import {
  conversationForFirstSend,
  mergeAttachmentIds,
  refreshConversationGraph,
} from "./chatWorkflow.ts";
import {
  chatStreamAdapter,
  enqueuePrompt,
  nextQueuedPrompt,
  type QueuedPrompt,
  removeQueuedPrompt,
  retryQueuedPrompt,
} from "./chatStreaming.ts";
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
  mergeConversationSnapshot,
} from "./conversationLifecycle.ts";
import { Modal } from "./Modal.tsx";
import { drawerShouldHandleEscape, modalOverlayPresent } from "./modalFocus.ts";
import { AdminModels, AdminProviders } from "./AdminRegistry.tsx";
import { AdminResilience } from "./AdminResilience.tsx";
import { AdminTools } from "./AdminTools.tsx";
import { ToolLauncher } from "./ToolLauncher.tsx";
import { ConversationKnowledgePicker, KnowledgeView } from "./Knowledge.tsx";
import { VoiceRecorder } from "./voice/VoiceRecorder.tsx";
import { insertTranscript } from "./voice/voiceState.ts";
import { SpeechPlaybackControl } from "./speech/SpeechPlaybackControl.tsx";
import { speechTextForMarkdown } from "./speech/speechText.ts";
import { useSpeechPlayback } from "./speech/useSpeechPlayback.ts";
import type { SpeechPlaybackController, SpeechPlaybackState } from "./speech/playback.ts";
import {
  type GeneratedAsset,
  type GeneratedAssetFilters,
  GeneratedAssetGallery,
  imageApi,
  ImageGenerationSheet,
  imageMutationBelongsToQuery,
  useImageGeneration,
} from "./images/index.ts";
import { ModelPicker } from "./models/ModelPicker.tsx";
import { focusConversationSearch, useGlobalShortcuts } from "./shortcuts/useGlobalShortcuts.ts";
import {
  AppearancePreferences,
  PersonalizationPreferences,
} from "./preferences/PreferenceControls.tsx";
import {
  useAppliedPreferences,
  usePreferenceMutation,
  usePreferences,
} from "./preferences/usePreferences.ts";
import {
  historyPreferenceWarning,
  temporaryChatUntilPreferencesResolve,
} from "./preferences/chatPrivacy.ts";
import {
  conversationIdsForWorkspace,
  OrganizeConversationDialog,
  useWorkspace,
  WorkspaceNavigation,
} from "./workspace/WorkspaceNavigation.tsx";
import { conversationMenuPosition } from "./workspace/conversationMenu.ts";
import type { Attachment, AuditFilters, Conversation, Message, Model, User } from "./types.ts";

type View = "chat" | "archived" | "trash" | "knowledge" | "settings" | "tokens" | "admin";
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
  searchInputRef,
  busyConversationId,
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
  searchInputRef: RefObject<HTMLInputElement | null>;
  busyConversationId: string;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeMobileRef = useRef(closeMobile);
  closeMobileRef.current = closeMobile;
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const workspace = useWorkspace();
  const listView: ConversationListView = view === "archived" || view === "trash" ? view : "chat";
  const visible = conversationsForView(conversations, listView);
  const scopedIds = new Set(conversationIdsForWorkspace(
    visible,
    workspace.folders.data,
    workspace.tags.data,
    listView === "chat" ? selectedFolder : null,
    listView === "chat" ? selectedTags : [],
  ));
  const filtered = visible.filter((c) =>
    scopedIds.has(c.id) &&
    `${c.title} ${c.preview}`.toLowerCase().includes(query.toLowerCase())
  );
  const select = (v: View) => {
    setView(v);
    closeMobile();
  };
  useEffect(() => {
    if (!mobileOpen) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const panel = sidebarRef.current;
    panel?.querySelector<HTMLButtonElement>('[aria-label="Close sidebar"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (drawerShouldHandleEscape(event, modalOverlayPresent())) {
        event.preventDefault();
        closeMobileRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )];
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
  }, [mobileOpen]);
  return (
    <aside
      ref={sidebarRef}
      className={cn("sidebar", mobileOpen && "mobile-open")}
      aria-label="Workspace navigation"
      aria-modal={mobileOpen || undefined}
      role={mobileOpen ? "dialog" : undefined}
    >
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
      <div className="search" role="search">
        <label className="sr-only" htmlFor={searchId}>Search conversations</label>
        <Search size={16} aria-hidden="true" />
        <input
          id={searchId}
          ref={searchInputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
        {query
          ? (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear conversation search"
              onClick={() => {
                setQuery("");
                searchInputRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          )
          : <kbd>⌘F</kbd>}
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {query ? `${filtered.length} conversation${filtered.length === 1 ? "" : "s"} found` : ""}
      </span>
      <nav className="side-nav">
        <button onClick={() => select("chat")} className={view === "chat" ? "selected" : ""}>
          <MessageSquare size={17} /> Chats
        </button>
        <button
          type="button"
          onClick={() => select("knowledge")}
          className={view === "knowledge" ? "selected" : ""}
        >
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
      {listView === "chat" && (
        <WorkspaceNavigation
          folders={workspace.folders.data}
          tags={workspace.tags.data}
          selectedFolder={selectedFolder}
          selectedTags={selectedTags}
          onSelectFolder={setSelectedFolder}
          onToggleTag={(id) =>
            setSelectedTags((current) =>
              current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
            )}
          foldersError={workspace.folders.isError}
          tagsError={workspace.tags.isError}
          retryFolders={() => void workspace.folders.refetch()}
          retryTags={() => void workspace.tags.refetch()}
        />
      )}
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
                folders={workspace.folders.data}
                tags={workspace.tags.data}
                mutationLocked={busyConversationId === c.id}
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
                folders={workspace.folders.data}
                tags={workspace.tags.data}
                mutationLocked={busyConversationId === c.id}
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
  { c, active, onOpen, listView, onUpdate, folders, tags, mutationLocked }: {
    c: Conversation;
    active: boolean;
    onOpen: (id: string) => void;
    listView: ConversationListView;
    onUpdate: (
      conversation: Conversation,
      patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
    ) => Promise<void>;
    folders?: import("./workspace/WorkspaceNavigation.tsx").FolderData;
    tags?: import("./workspace/WorkspaceNavigation.tsx").TagData;
    mutationLocked: boolean;
  },
) {
  const [menu, setMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const [rename, setRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [organize, setOrganize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rowRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !rowRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) setMenu(false);
    };
    const reposition = () => {
      const trigger = actionRef.current?.getBoundingClientRect();
      if (!trigger) return;
      setMenuPosition(conversationMenuPosition(
        trigger,
        { width: globalThis.innerWidth, height: globalThis.innerHeight },
        {
          width: menuRef.current?.offsetWidth ?? 180,
          height: menuRef.current?.offsetHeight ?? 210,
        },
      ));
    };
    reposition();
    document.addEventListener("pointerdown", dismiss);
    globalThis.addEventListener("resize", reposition);
    globalThis.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      globalThis.removeEventListener("resize", reposition);
      globalThis.removeEventListener("scroll", reposition, true);
    };
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
        title={mutationLocked
          ? "Conversation actions are available after the current response finishes"
          : `Actions for ${c.title}`}
        aria-label={`Actions for ${c.title}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        data-conversation-actions={c.id}
        disabled={mutationLocked}
        onClick={() => {
          if (!menu) {
            const trigger = actionRef.current?.getBoundingClientRect();
            if (trigger) {
              setMenuPosition(conversationMenuPosition(
                trigger,
                { width: globalThis.innerWidth, height: globalThis.innerHeight },
                { width: 180, height: 210 },
              ));
            }
          }
          setMenu(!menu);
        }}
      >
        <Ellipsis size={16} />
      </button>
      {menu && createPortal(
        <div
          ref={menuRef}
          className="conversation-menu conversation-menu-portal"
          style={{ left: menuPosition.left, top: menuPosition.top }}
          role="menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
              return;
            }
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
          {listView === "chat" && folders && tags && (
            <button
              role="menuitem"
              onClick={() => {
                actionRef.current?.focus();
                setOrganize(true);
                setMenu(false);
              }}
            >
              <Folder size={14} /> Organize
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
        </div>,
        document.body,
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
      {organize && folders && tags && (
        <OrganizeConversationDialog
          conversation={c}
          folders={folders}
          tags={tags}
          close={() => setOrganize(false)}
        />
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
  {
    message,
    branch,
    onTree,
    onEdit,
    onSelectBranch,
    onRegenerate,
    onContinue,
    branchBusy,
    generationBusy,
    speech,
    readOnly = false,
  }: {
    message: Message;
    branch: MessageBranch | null;
    onTree: () => void;
    onEdit: (m: Message) => void;
    onSelectBranch: (messageId: string) => void;
    onRegenerate: (message: Message) => void;
    onContinue: (message: Message) => void;
    branchBusy: boolean;
    generationBusy: boolean;
    speech?: {
      model: string;
      voice: string;
      controller: SpeechPlaybackController;
      state: SpeechPlaybackState;
      disabledReason?: string;
    };
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
              <Fragment key={a.id}>
                <a
                  className={cn(
                    "attachment",
                    a.mimeType.startsWith("image/") && "image-attachment",
                  )}
                  href={`/api/messages/${message.id}/attachments/${a.id}/content`}
                  target={a.mimeType.startsWith("image/") ? "_blank" : undefined}
                  rel={a.mimeType.startsWith("image/") ? "noreferrer" : undefined}
                >
                  {a.mimeType.startsWith("image/")
                    ? (
                      <img
                        src={`/api/messages/${message.id}/attachments/${a.id}/content`}
                        alt={a.filename}
                        loading="lazy"
                      />
                    )
                    : (
                      <span>
                        <FileText size={19} />
                      </span>
                    )}
                  <div>
                    <strong>{a.filename}</strong>
                    <small>{a.mimeType} · {Math.max(1, Math.ceil(a.sizeBytes / 1024))} KB</small>
                  </div>
                </a>
                <AttachmentIngestionBadge attachment={a} />
              </Fragment>
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
                disabled={generationBusy || branchBusy}
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
                busy={branchBusy || generationBusy}
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
          {message.status === "stopped" && <span className="terminal-badge">Stopped</span>}
          {message.status === "error" && <span className="terminal-badge error">Error</span>}
        </div>
        {message.reasoning && (
          <details className="reasoning-panel">
            <summary>Reasoning</summary>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.reasoning}</ReactMarkdown>
          </details>
        )}
        {message.toolStatus && <p className="tool-status">{message.toolStatus}</p>}
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {message.content}
          </ReactMarkdown>
        </div>
        {message.knowledgeSources?.length
          ? (
            <details className="reasoning-panel">
              <summary>Sources ({message.knowledgeSources.length})</summary>
              <ul>
                {message.knowledgeSources.map((source) => (
                  <li key={source.label}>
                    <strong>[{source.label}]</strong> {source.collectionName} / {source.filename}
                  </li>
                ))}
              </ul>
            </details>
          )
          : null}
        <div className="message-actions">
          <IconButton label="Copy response" onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
          {speech
            ? (
              <SpeechPlaybackControl
                messageId={message.id}
                input={{
                  model: speech.model,
                  input: speechTextForMarkdown(message.content),
                  voice: speech.voice,
                  responseFormat: "mp3",
                }}
                controller={speech.controller}
                state={speech.state}
                disabledReason={speech.disabledReason}
                icon={speech.state.messageId === message.id && speech.state.phase === "loading"
                  ? <X size={15} />
                  : <Volume2 size={15} />}
              />
            )
            : (
              <IconButton label="Read aloud unavailable: no speech model" disabled>
                <Volume2 size={15} />
              </IconButton>
            )}
          {!readOnly && (
            <IconButton
              label="Regenerate response in a new branch"
              disabled={generationBusy}
              onClick={() => onRegenerate(message)}
            >
              <RefreshCw size={15} />
            </IconButton>
          )}
          {!readOnly && (
            <IconButton
              label="Continue response"
              disabled={generationBusy}
              onClick={() => onContinue(message)}
            >
              <ArrowRight size={15} />
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
              busy={branchBusy || generationBusy}
              readOnly={readOnly}
            />
          )}
          <span className="response-meta">{message.latency}</span>
        </div>
      </div>
    </article>
  );
}

function AttachmentIngestionBadge({ attachment }: { attachment: Attachment }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState(attachment.ingestionStatus);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState(false);
  useEffect(() => setStatus(attachment.ingestionStatus), [attachment.ingestionStatus]);
  useEffect(() => {
    if (status !== "queued" && status !== "processing") return;
    const timer = setInterval(
      () => void queryClient.invalidateQueries({ queryKey: ["messages"] }),
      2000,
    );
    return () => clearInterval(timer);
  }, [queryClient, status]);
  if (!status || status === "not_applicable") return null;
  if (status !== "failed") return <small role="status">Knowledge: {status}</small>;
  return (
    <span>
      <small>Knowledge ingestion failed.</small>{" "}
      <button
        type="button"
        className="link-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setRetryError(false);
          void api.retryAttachmentIngestion(attachment.id).then((updated) => {
            setStatus(updated.ingestionStatus);
          }).catch(() => setRetryError(true)).finally(() => setBusy(false));
        }}
      >
        {busy ? "Retrying…" : "Retry knowledge ingestion"}
      </button>
      {retryError && <small role="alert">Retry failed. Try again.</small>}
    </span>
  );
}

export function Composer(
  {
    onSend,
    edit,
    cancelEdit,
    disabled,
    streaming,
    stopping,
    queuedCount,
    onStop,
    transcriptionModels,
    transcriptionModel,
    setTranscriptionModel,
    imageModels,
    imageEditModels,
    disabledReason,
  }: {
    onSend: (
      value: string,
      attachmentIds: string[],
      toolExecutionIds: string[],
    ) => Promise<boolean>;
    edit?: Message;
    cancelEdit: () => void;
    disabled: boolean;
    streaming: boolean;
    stopping: boolean;
    queuedCount: number;
    onStop: () => void;
    transcriptionModels: Model[];
    transcriptionModel?: string;
    setTranscriptionModel: (id: string) => void;
    imageModels: Model[];
    imageEditModels: Model[];
    disabledReason?: string;
  },
) {
  const [value, setValue] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolContexts, setToolContexts] = useState<Array<{ id: string }>>([]);
  const [dragging, setDragging] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [imagePanel, setImagePanel] = useState<"create" | "gallery" | null>(null);
  const [imageEditSource, setImageEditSource] = useState<GeneratedAsset>();
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
  const [selectedGeneratedAssets, setSelectedGeneratedAssets] = useState<GeneratedAsset[]>([]);
  const [imageHistoryLoading, setImageHistoryLoading] = useState(false);
  const [imageHistoryError, setImageHistoryError] = useState("");
  const [imageHistoryCursor, setImageHistoryCursor] = useState<string | null>(null);
  const [imageHistoryFilters, setImageHistoryFilters] = useState<GeneratedAssetFilters>({
    deleted: false,
  });
  const [imageMutationIds, setImageMutationIds] = useState<ReadonlySet<string>>(new Set());
  const imageHistoryRequest = useRef(0);
  const imageHistoryQueryGeneration = useRef(0);
  const imageHistoryFiltersRef = useRef<GeneratedAssetFilters>(imageHistoryFilters);
  const imageHistoryAbort = useRef<AbortController | null>(null);
  const imageMutationRef = useRef(new Set<string>());
  const imageModalHandoff = useRef(false);
  const imageGeneration = useImageGeneration();
  imageHistoryFiltersRef.current = imageHistoryFilters;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => {
    for (const controller of uploadControllers.current.values()) controller.abort();
    uploadControllers.current.clear();
  }, []);
  useEffect(() => {
    setExcludedEditAttachments(new Set());
    if (edit) {
      setValue(edit.content);
      setToolContexts((edit.toolExecutionIds ?? []).map((id) => ({ id })));
    }
  }, [edit]);
  const retainedAttachments = (edit?.attachments ?? []).filter((attachment) =>
    !excludedEditAttachments.has(attachment.id)
  );
  const loadImageHistory = (
    filters = imageHistoryFilters,
    cursor?: string,
    replace = false,
  ) => {
    const requestId = ++imageHistoryRequest.current;
    imageHistoryAbort.current?.abort();
    const controller = new AbortController();
    imageHistoryAbort.current = controller;
    setImageHistoryLoading(true);
    setImageHistoryError("");
    void imageApi.list({ ...filters, limit: 24, cursor }, controller.signal).then((page) => {
      if (requestId !== imageHistoryRequest.current) return;
      setGeneratedAssets((current) => {
        const merged = replace ? page.data : [...current, ...page.data];
        return [...new Map(merged.map((asset) => [asset.id, asset])).values()];
      });
      setImageHistoryCursor(page.nextCursor);
    }).catch((error: unknown) => {
      if (requestId !== imageHistoryRequest.current) return;
      if (controller.signal.aborted) return;
      setImageHistoryError(error instanceof Error ? error.message : "Couldn’t load image history.");
    }).finally(() => {
      if (requestId === imageHistoryRequest.current) setImageHistoryLoading(false);
    });
  };
  const openImageGallery = () => {
    setImagePanel("gallery");
    setImageHistoryCursor(null);
    loadImageHistory(imageHistoryFilters, undefined, true);
  };
  useEffect(() => () => imageHistoryAbort.current?.abort(), []);
  const mutateImage = async (asset: GeneratedAsset, operation: "delete" | "restore") => {
    if (imageMutationRef.current.has(asset.id)) return;
    imageMutationRef.current.add(asset.id);
    setImageMutationIds(new Set(imageMutationRef.current));
    setImageHistoryError("");
    const queryGeneration = imageHistoryQueryGeneration.current;
    try {
      if (operation === "delete") {
        await imageApi.remove(asset.id);
        setSelectedGeneratedAssets((current) => current.filter((item) => item.id !== asset.id));
        if (
          !imageMutationBelongsToQuery(queryGeneration, imageHistoryQueryGeneration.current)
        ) {
          loadImageHistory(imageHistoryFiltersRef.current, undefined, true);
          return;
        }
        setGeneratedAssets((current) =>
          imageHistoryFilters.deleted
            ? current.map((item) =>
              item.id === asset.id
                ? {
                  ...item,
                  contentUrl: null,
                  thumbnailUrl: null,
                  status: "deleted" as const,
                  deletedAt: new Date().toISOString(),
                }
                : item
            )
            : current.filter((item) => item.id !== asset.id)
        );
      } else {
        const restored = await imageApi.restore(asset.id);
        if (
          !imageMutationBelongsToQuery(queryGeneration, imageHistoryQueryGeneration.current)
        ) {
          loadImageHistory(imageHistoryFiltersRef.current, undefined, true);
          return;
        }
        setGeneratedAssets((current) =>
          imageHistoryFilters.deleted
            ? current.filter((item) => item.id !== restored.id)
            : current.map((item) => item.id === restored.id ? restored : item)
        );
      }
    } catch (error) {
      setImageHistoryError(
        error instanceof Error
          ? error.message
          : operation === "delete"
          ? "Couldn’t delete image."
          : "Couldn’t restore image.",
      );
    } finally {
      imageMutationRef.current.delete(asset.id);
      setImageMutationIds(new Set(imageMutationRef.current));
    }
  };
  const addGeneratedAsset = (asset: GeneratedAsset) => {
    if (!asset.attachmentId || asset.status !== "ready") return;
    setSelectedGeneratedAssets((current) =>
      current.some((item) => item.id === asset.id) ? current : [...current, asset]
    );
  };
  const openImageEditorFromGallery = (asset?: GeneratedAsset) => {
    imageModalHandoff.current = true;
    document.querySelector<HTMLButtonElement>('[aria-label="Open image history"]')?.focus();
    imageGeneration.reset();
    setImageEditSource(asset);
    setImagePanel("create");
  };
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
  const readyAttachmentIds = mergeAttachmentIds(
    retainedAttachments.map((attachment) => attachment.id),
    [
      ...uploads.flatMap((item) =>
        item.status === "ready" && item.attachment ? [item.attachment.id] : []
      ),
      ...selectedGeneratedAssets.flatMap((asset) => asset.attachmentId ? [asset.attachmentId] : []),
    ],
  );
  const canSubmit =
    (value.trim().length > 0 || readyAttachmentIds.length > 0 || toolContexts.length > 0) &&
    !disabled && !blockedByUpload;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (await onSend(value.trim(), readyAttachmentIds, toolContexts.map((context) => context.id))) {
      setValue("");
      setUploads([]);
      setSelectedGeneratedAssets([]);
      setToolContexts([]);
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
      {(retainedAttachments.length > 0 || uploads.length > 0 ||
        selectedGeneratedAssets.length > 0) && (
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
          {selectedGeneratedAssets.map((asset) => (
            <div className="upload-chip upload-ready generated-attachment-chip" key={asset.id}>
              {asset.thumbnailUrl || asset.contentUrl
                ? <img src={asset.thumbnailUrl ?? asset.contentUrl ?? ""} alt="" />
                : <ImageIcon size={18} aria-hidden="true" />}
              <span>
                <strong>Generated image</strong>
                <small>Ready · remains in image history</small>
              </span>
              <IconButton
                label="Remove generated image from this message"
                onClick={() =>
                  setSelectedGeneratedAssets((current) =>
                    current.filter((item) =>
                      item.id !== asset.id
                    )
                  )}
              >
                <X size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {toolContexts.length > 0 && (
        <div className="upload-list" aria-label="Approved tool results" aria-live="polite">
          {toolContexts.map((context) => (
            <div className="upload-chip upload-ready" key={context.id}>
              <Globe2 size={18} aria-hidden="true" />
              <span>
                <strong>Approved web search</strong>
                <small>Will be added to this new branch</small>
              </span>
              <IconButton
                label="Remove approved web search result"
                onClick={() =>
                  setToolContexts((current) =>
                    current.filter((item) => item.id !== context.id)
                  )}
              >
                <X size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {selectionError && <p className="form-error" role="alert">{selectionError}</p>}
      {disabledReason && <p className="composer-status" role="status">{disabledReason}</p>}
      <form className="composer" onSubmit={submit}>
        <textarea
          ref={textareaRef}
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
            disabled={disabled}
            aria-label="Open web search"
            onClick={() => setToolsOpen(true)}
          >
            <Globe2 size={16} /> Search
          </button>
          {imageModels.length > 0 && (
            <button
              type="button"
              className="tool-pill"
              aria-label="Create images"
              onClick={() => {
                imageGeneration.reset();
                setImageEditSource(undefined);
                setImagePanel("create");
              }}
            >
              <ImageIcon size={16} /> Create image
            </button>
          )}
          <button
            type="button"
            className="tool-pill"
            aria-label="Open image history"
            onClick={openImageGallery}
          >
            <Boxes size={16} /> Images
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
          {transcriptionModels.length > 1 && (
            <select
              className="voice-model-select"
              aria-label="Voice transcription model"
              value={transcriptionModel}
              onChange={(event) => setTranscriptionModel(event.target.value)}
            >
              {transcriptionModels.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          )}
          <VoiceRecorder
            model={transcriptionModel}
            disabled={disabled}
            onTranscript={(transcript) => {
              const textarea = textareaRef.current;
              const selectionStart = textarea?.selectionStart;
              const selectionEnd = textarea?.selectionEnd;
              let caret = selectionStart ?? 0;
              setValue((current) => {
                const result = insertTranscript(
                  current,
                  transcript,
                  selectionStart ?? current.length,
                  selectionEnd ?? current.length,
                );
                caret = result.caret;
                return result.value;
              });
              requestAnimationFrame(() => {
                textarea?.focus();
                textarea?.setSelectionRange(caret, caret);
              });
            }}
          />
          {streaming && (
            <button
              type="button"
              className="stop-button"
              aria-label={stopping ? "Stopping generation" : "Stop generating"}
              disabled={stopping}
              onClick={onStop}
            >
              <Square size={14} fill="currentColor" /> {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          <button
            className="send-button"
            aria-label={streaming ? "Queue message" : "Send"}
            disabled={!canSubmit}
          >
            <ArrowDown size={19} />
          </button>
        </div>
      </form>
      <ToolLauncher
        open={toolsOpen}
        close={() => setToolsOpen(false)}
        insert={(execution) => setToolContexts((current) => [...current, { id: execution.id }])}
      />
      {imagePanel === "create" && (
        <ImageGenerationSheet
          models={(imageEditSource ? imageEditModels : imageModels).map((model) => ({
            id: model.id,
            name: model.name,
          }))}
          source={imageEditSource}
          state={imageGeneration.state}
          close={() => {
            imageModalHandoff.current = false;
            imageGeneration.cancel();
            setImagePanel(null);
          }}
          submit={(input) => {
            void imageGeneration.run(input).then((result) => {
              if (!result) return;
              setGeneratedAssets((current) => [
                ...result.assets,
                ...current.filter((item) => !result.assets.some((asset) => asset.id === item.id)),
              ]);
            });
          }}
          cancel={imageGeneration.cancel}
          add={addGeneratedAsset}
          selectedIds={new Set(selectedGeneratedAssets.map((asset) => asset.id))}
          uploadMask={(file, progress, signal) => api.uploadAttachment(file, progress, signal)}
          removeMask={(attachmentId) => api.deleteAttachment(attachmentId).then(() => undefined)}
        />
      )}
      {imagePanel === "gallery" && (
        <Modal
          title="Image history"
          close={() => setImagePanel(null)}
          variant="wide"
          restoreFocus={() => !imageModalHandoff.current}
        >
          <GeneratedAssetGallery
            assets={generatedAssets}
            filters={imageHistoryFilters}
            models={[...new Set(imageModels.map((model) => model.id))]}
            loading={imageHistoryLoading}
            error={imageHistoryError}
            hasMore={imageHistoryCursor !== null}
            loadMore={() => {
              if (imageHistoryCursor && !imageHistoryLoading) {
                loadImageHistory(imageHistoryFilters, imageHistoryCursor);
              }
            }}
            changeFilters={(filters) => {
              imageHistoryQueryGeneration.current++;
              imageHistoryFiltersRef.current = filters;
              setImageHistoryFilters(filters);
              setImageHistoryCursor(null);
              setGeneratedAssets([]);
              loadImageHistory(filters, undefined, true);
            }}
            pendingIds={imageMutationIds}
            selectedIds={new Set(selectedGeneratedAssets.map((asset) => asset.id))}
            add={(asset) => {
              addGeneratedAsset(asset);
            }}
            remove={(asset) => {
              void mutateImage(asset, "delete");
            }}
            restore={(asset) => {
              void mutateImage(asset, "restore");
            }}
            edit={imageEditModels.length > 0
              ? (asset) => {
                openImageEditorFromGallery(asset);
              }
              : undefined}
            retry={() => {
              imageHistoryQueryGeneration.current++;
              setImageHistoryCursor(null);
              setGeneratedAssets([]);
              loadImageHistory(imageHistoryFiltersRef.current, undefined, true);
            }}
          />
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => setImagePanel(null)}>
              Close
            </button>
            {imageModels.length > 0 && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  openImageEditorFromGallery();
                }}
              >
                <Plus size={16} /> Create image
              </button>
            )}
          </div>
        </Modal>
      )}
      <p className="composer-note">
        AI can make mistakes. Check important information.{" "}
        <span>
          {queuedCount > 0 ? `${queuedCount} queued · ` : ""}Shift + Enter for new line
        </span>
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
  const restoreFrame = useRef<number | null>(null);
  closeRef.current = close;
  busyRef.current = busy;
  useEffect(() => {
    if (restoreFrame.current !== null) {
      cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = null;
    }
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
      restoreFrame.current = requestAnimationFrame(() => {
        restoreFrame.current = null;
        previousFocus.current?.focus();
      });
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
  readOnly: readOnlyProp = false,
  saveHistory = true,
  modelPreferenceError = "",
  historyPreferenceWarning = "",
  onGenerationBusyChange,
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
  saveHistory?: boolean;
  modelPreferenceError?: string;
  historyPreferenceWarning?: string;
  onGenerationBusyChange: (conversationId: string, busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const chatModels = useMemo(
    () => models.filter((model) => model.capabilities.includes("chat")),
    [models],
  );
  const transcriptionModels = useMemo(
    () => models.filter((model) => model.capabilities.includes("transcription")),
    [models],
  );
  const speechModels = useMemo(
    () => models.filter((model) => model.capabilities.includes("speech")),
    [models],
  );
  const imageModels = useMemo(
    () => models.filter((model) => model.capabilities.includes("image_generation")),
    [models],
  );
  const imageEditModels = useMemo(
    () => models.filter((model) => model.capabilities.includes("image_editing")),
    [models],
  );
  const speechVoices = [
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "fable",
    "nova",
    "onyx",
    "sage",
    "shimmer",
    "verse",
  ] as const;
  const [speechModel, setSpeechModel] = useState(() => {
    try {
      return localStorage.getItem("dg-chat.speech-model") ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (models.length === 0) return;
    const selected = speechModels.some((model) => model.id === speechModel)
      ? speechModel
      : speechModels[0]?.id ?? "";
    if (selected !== speechModel) setSpeechModel(selected);
    try {
      if (selected) localStorage.setItem("dg-chat.speech-model", selected);
      else localStorage.removeItem("dg-chat.speech-model");
    } catch {
      // Private browser contexts retain the valid in-memory fallback.
    }
  }, [models.length, speechModel, speechModels]);
  const [speechVoice, setSpeechVoice] = useState(() => {
    try {
      const stored = localStorage.getItem("dg-chat.speech-voice");
      return speechVoices.includes(stored as (typeof speechVoices)[number]) ? stored! : "alloy";
    } catch {
      return "alloy";
    }
  });
  const chooseSpeechVoice = (voice: string) => {
    if (!speechVoices.includes(voice as (typeof speechVoices)[number])) return;
    setSpeechVoice(voice);
    try {
      localStorage.setItem("dg-chat.speech-voice", voice);
    } catch {
      // The validated in-memory preference remains available in private contexts.
    }
  };
  const speechPlayback = useSpeechPlayback();
  const [transcriptionModel, setTranscriptionModelState] = useState(() => {
    try {
      return localStorage.getItem("dg-chat.transcription-model") ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    // Preserve the stored preference while the asynchronous catalog is still loading.
    if (models.length === 0) return;
    const selected = transcriptionModels.some((model) => model.id === transcriptionModel)
      ? transcriptionModel
      : transcriptionModels[0]?.id ?? "";
    if (selected !== transcriptionModel) setTranscriptionModelState(selected);
    try {
      if (selected) localStorage.setItem("dg-chat.transcription-model", selected);
      else localStorage.removeItem("dg-chat.transcription-model");
    } catch {
      // Hardened/private browser contexts can use the in-memory selection.
    }
  }, [models.length, transcriptionModel, transcriptionModels]);
  const setTranscriptionModel = (id: string) => {
    if (transcriptionModels.some((model) => model.id === id)) setTranscriptionModelState(id);
  };
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const followStreamRef = useRef(true);
  const [localMessages, setLocalMessages] = useState(messages);
  const [tree, setTree] = useState(false);
  const treeReturnFocusRef = useRef<HTMLElement | null>(null);
  const [edit, setEdit] = useState<Message>();
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [activeStream, setActiveStream] = useState<{
    item: QueuedPrompt;
    user: Message;
    assistant: Message;
    phase: "connecting" | "streaming" | "stopping";
  }>();
  const [failedPrompt, setFailedPrompt] = useState<QueuedPrompt>();
  const streamAbortRef = useRef<AbortController | null>(null);
  const runPromptRef = useRef<(item: QueuedPrompt) => Promise<void>>(() => Promise.resolve());
  const branchInFlightRef = useRef(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [sendError, setSendError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const initialConversation = conversations.find((c) => c.id === activeId);
  const [conversation, setConversation] = useState(initialConversation);
  const syncConversation = (next: Conversation) => {
    setConversation(next);
    for (const queryKey of [["conversations"], ["conversations", "deleted"]] as const) {
      queryClient.setQueryData<Conversation[]>(
        queryKey,
        (current) => mergeConversationSnapshot(current, next),
      );
    }
  };
  const readOnly = readOnlyProp || Boolean(conversation?.archived || conversation?.deleted);
  useEffect(() => setLocalMessages(messages), [messages]);
  useEffect(() => setConversation(initialConversation), [initialConversation]);
  const activePath = useMemo(
    () => activeMessagePath(localMessages, conversation?.activeLeafId),
    [localMessages, conversation?.activeLeafId],
  );
  const streaming = Boolean(activeStream);
  const generationBusy = streaming || queue.length > 0;
  useEffect(() => {
    onGenerationBusyChange(activeId, generationBusy);
    return () => onGenerationBusyChange(activeId, false);
  }, [activeId, generationBusy, onGenerationBusyChange]);
  const speechContentFingerprint = useMemo(
    () => localMessages.map((message) => `${message.id}:${message.content}`).join("\u0000"),
    [localMessages],
  );
  useEffect(() => speechPlayback.controller.cancel(), [
    activeId,
    conversation?.activeLeafId,
    speechContentFingerprint,
    speechModel,
    speechVoice,
    speechPlayback.controller,
  ]);
  useEffect(() => {
    if (!activeStream || !followStreamRef.current) return;
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [activeStream?.assistant.content]);
  const selectBranch = async (messageId: string) => {
    if (!conversation || branchInFlightRef.current || readOnly) return;
    const leafId = preferredLeaf(localMessages, messageId);
    if (leafId === conversation.activeLeafId) return;
    branchInFlightRef.current = true;
    setBranchBusy(true);
    setSendError("");
    try {
      syncConversation(await api.setActiveLeaf(conversation, leafId));
    } catch (error) {
      let refreshed: Awaited<ReturnType<typeof api.conversationGraph>>;
      try {
        refreshed = await refreshConversationGraph(conversation.id, {
          load: api.conversationGraph,
        });
      } catch (refreshError) {
        setSendError(
          refreshError instanceof Error
            ? refreshError.message
            : "The latest conversation could not be loaded. Try again.",
        );
        return;
      }
      queryClient.setQueryData(["messages", conversation.id], refreshed.messages);
      syncConversation(refreshed.conversation);
      setLocalMessages(refreshed.messages);
      if (error instanceof ApiError && error.code !== "version_conflict") {
        setSendError(error.message);
        return;
      }
      if (error instanceof ApiError && error.code === "version_conflict") {
        const refreshedLeafId = preferredLeaf(refreshed.messages, messageId);
        if (refreshedLeafId === refreshed.conversation.activeLeafId) return;
        try {
          syncConversation(await api.setActiveLeaf(refreshed.conversation, refreshedLeafId));
          return;
        } catch (retryError) {
          if (retryError instanceof ApiError && retryError.code !== "version_conflict") {
            setSendError(retryError.message);
            return;
          }
        }
      }
      setSendError("That branch changed in another tab. The latest conversation has been loaded.");
    } finally {
      branchInFlightRef.current = false;
      setBranchBusy(false);
    }
  };
  runPromptRef.current = async (item: QueuedPrompt) => {
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const optimisticUser: Message = {
      id: `pending-user-${item.id}`,
      parentId: item.edit ? item.edit.parentId : conversation?.activeLeafId ?? null,
      supersedesId: item.edit?.id ?? null,
      role: "user",
      content: item.content,
      model: item.model,
      createdAt: "Sending…",
    };
    const optimisticAssistant: Message = {
      id: `pending-assistant-${item.id}`,
      parentId: optimisticUser.id,
      role: "assistant",
      content: "",
      model: item.model,
      createdAt: "",
    };
    setActiveStream({
      item,
      user: optimisticUser,
      assistant: optimisticAssistant,
      phase: "connecting",
    });
    setSendError("");
    setFailedPrompt(undefined);
    let acceptedUserId: string | undefined;
    let terminalAssistant: Message | undefined;
    let targetConversationId = conversation?.id ?? activeId;
    try {
      const resolved = await conversationForFirstSend(activeId, conversation, {
        load: api.conversation,
        create: () => api.createConversation("New chat", item.operationId, !saveHistory),
      });
      const target = resolved.conversation;
      targetConversationId = target.id;
      if (resolved.created) setConversation(target);
      for await (
        const event of chatStreamAdapter.stream({
          conversation: target,
          content: item.content,
          model: item.model,
          edit: item.edit,
          sourceMessageId: item.sourceMessageId,
          operationId: item.operationId,
          attachmentIds: item.attachmentIds,
          toolExecutionIds: item.toolExecutionIds ?? [],
          mode: item.mode,
        }, controller.signal)
      ) {
        if (event.type === "accepted") {
          acceptedUserId = event.user.id;
          setActiveStream((current) =>
            current && current.item.id === item.id
              ? {
                ...current,
                user: event.user,
                assistant: { ...event.assistant, content: "" },
                phase: "streaming",
              }
              : current
          );
        } else if (event.type === "delta") {
          setActiveStream((current) =>
            current && current.item.id === item.id
              ? {
                ...current,
                assistant: {
                  ...current.assistant,
                  content: current.assistant.content + event.text,
                },
                phase: "streaming",
              }
              : current
          );
        } else if (event.type === "reasoning") {
          setActiveStream((current) =>
            current && current.item.id === item.id
              ? {
                ...current,
                assistant: {
                  ...current.assistant,
                  reasoning: (current.assistant.reasoning ?? "") + event.text,
                },
                phase: "streaming",
              }
              : current
          );
        } else if (event.type === "tool") {
          setActiveStream((current) =>
            current && current.item.id === item.id
              ? {
                ...current,
                assistant: {
                  ...current.assistant,
                  toolStatus: event.name
                    ? `Calling ${event.name}…`
                    : `Receiving tool call ${event.index + 1}…`,
                },
                phase: "streaming",
              }
              : current
          );
        } else if (event.type === "usage") {
          setActiveStream((current) =>
            current && current.item.id === item.id
              ? {
                ...current,
                assistant: {
                  ...current.assistant,
                  latency: `${event.outputTokens} output tokens`,
                },
              }
              : current
          );
        } else {
          terminalAssistant = event.assistant;
          setLocalMessages((current) => {
            const nextById = new Map(current.map((message) => [message.id, message]));
            nextById.set(event.user.id, event.user);
            nextById.set(event.assistant.id, event.assistant);
            const next = [...nextById.values()];
            queryClient.setQueryData(["messages", event.conversation.id], next);
            return next;
          });
          syncConversation(event.conversation);
          setEdit(undefined);
          if (resolved.created) await onConversationCreated(event.conversation.id);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setSendError(
          "Generation stopped. Your saved conversation and previous branches are intact.",
        );
      } else {
        let retryPrompt = terminalAssistant
          ? {
            ...item,
            edit: undefined,
            sourceMessageId: terminalAssistant.id,
            attachmentIds: [],
            toolExecutionIds: [],
            mode: "regenerate" as const,
            reuseOperationOnRetry: false,
          }
          : acceptedUserId
          ? undefined
          : { ...item, reuseOperationOnRetry: true };
        let refreshedAfterFailure = false;
        if (targetConversationId) {
          try {
            const refreshed = await api.conversationGraph(targetConversationId);
            refreshedAfterFailure = true;
            queryClient.setQueryData(["messages", targetConversationId], refreshed.messages);
            setLocalMessages(refreshed.messages);
            syncConversation(refreshed.conversation);
            const recovered = acceptedUserId
              ? refreshed.messages.find((message) =>
                message.id === refreshed.conversation.activeLeafId &&
                message.role === "assistant" && message.parentId === acceptedUserId
              )
              : undefined;
            if (recovered) {
              retryPrompt = {
                ...item,
                edit: undefined,
                sourceMessageId: recovered.id,
                attachmentIds: [],
                toolExecutionIds: [],
                mode: "regenerate",
                reuseOperationOnRetry: false,
              };
            }
          } catch {
            // Keep the local immutable path visible when recovery is temporarily unavailable.
          }
        }
        if (
          error instanceof ApiError && error.code === "version_conflict" && !acceptedUserId &&
          refreshedAfterFailure && (item.versionRetryCount ?? 0) < 1
        ) {
          setQueue((current) => [{
            ...item,
            id: crypto.randomUUID(),
            reuseOperationOnRetry: true,
            versionRetryCount: (item.versionRetryCount ?? 0) + 1,
          }, ...current]);
          return;
        }
        setFailedPrompt(retryPrompt);
        setSendError(
          retryPrompt
            ? "Generation was interrupted before it finished. Retry to create a new branch."
            : "Generation was interrupted. Reload the conversation to recover its saved terminal branch.",
        );
        return;
      }
      if (targetConversationId) {
        try {
          const refreshed = await api.conversationGraph(targetConversationId);
          queryClient.setQueryData(["messages", targetConversationId], refreshed.messages);
          setLocalMessages(refreshed.messages);
          syncConversation(refreshed.conversation);
        } catch {
          // Keep the local immutable path visible when recovery is temporarily unavailable.
        }
      }
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
      setActiveStream((current) => current?.item.id === item.id ? undefined : current);
    }
  };
  useEffect(() => {
    if (activeStream || queue.length === 0 || readOnly) return;
    const { next, remaining } = nextQueuedPrompt(queue);
    setQueue(remaining);
    if (next) void runPromptRef.current(next);
  }, [activeStream, queue, readOnly]);
  useEffect(() => () => streamAbortRef.current?.abort(), []);

  const send = (
    content: string,
    attachmentIds: string[],
    toolExecutionIds: string[],
  ): Promise<boolean> => {
    const item: QueuedPrompt = {
      id: crypto.randomUUID(),
      content,
      model: selectedModel,
      edit,
      attachmentIds,
      toolExecutionIds,
      mode: "send",
      operationId: crypto.randomUUID(),
    };
    setQueue((current) => enqueuePrompt(current, item));
    setEdit(undefined);
    return Promise.resolve(true);
  };
  const queueSpecialPrompt = (
    content: string,
    mode: "regenerate" | "continue",
    sourceMessageId: string,
  ) => {
    const operationId = crypto.randomUUID();
    setQueue((current) =>
      enqueuePrompt(current, {
        id: crypto.randomUUID(),
        content,
        model: selectedModel,
        sourceMessageId,
        attachmentIds: [],
        toolExecutionIds: [],
        mode,
        operationId,
      })
    );
    setSendError("");
  };
  return (
    <main className="chat-main">
      <header className="chat-header">
        <IconButton label="Open menu" className="mobile-only" onClick={onMenu}>
          <Menu size={20} />
        </IconButton>
        <ModelPicker models={chatModels} selected={selectedModel} setSelected={setSelectedModel} />
        {modelPreferenceError && (
          <span className="model-preference-error" role="alert">{modelPreferenceError}</span>
        )}
        {historyPreferenceWarning && (
          <span className="model-preference-error" role="alert">{historyPreferenceWarning}</span>
        )}
        <div className="header-actions">
          {speechModels.length > 0 && (
            <div className="speech-preferences" aria-label="Read aloud settings">
              <label>
                <span className="sr-only">Speech model</span>
                <select
                  aria-label="Speech model"
                  value={speechModel}
                  onChange={(event) =>
                    setSpeechModel(event.currentTarget.value)}
                >
                  {speechModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">Speech voice</span>
                <select
                  aria-label="Speech voice"
                  value={speechVoice}
                  onChange={(event) =>
                    chooseSpeechVoice(event.currentTarget.value)}
                >
                  {speechVoices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
                </select>
              </label>
            </div>
          )}
          {conversation && (
            <ConversationKnowledgePicker
              conversationId={conversation.id}
              disabled={readOnly || streaming || queue.length > 0}
            />
          )}
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
      <div
        className="chat-scroll"
        ref={chatScrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followStreamRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
              120;
        }}
      >
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
            onRegenerate={(assistant) => {
              const source = localMessages.find((message) => message.id === assistant.parentId);
              if (source?.role === "user") {
                queueSpecialPrompt(source.content, "regenerate", assistant.id);
              }
            }}
            onContinue={(assistant) =>
              queueSpecialPrompt(
                "Continue from where you left off without repeating the previous response.",
                "continue",
                assistant.id,
              )}
            branchBusy={branchBusy}
            generationBusy={streaming || queue.length > 0}
            speech={speechModel
              ? {
                model: speechModel,
                voice: speechVoice,
                controller: speechPlayback.controller,
                state: speechPlayback.state,
                disabledReason: streaming || queue.length > 0
                  ? "a response is being generated"
                  : m.status === "error" || m.status === "stopped"
                  ? "the response is incomplete"
                  : !speechTextForMarkdown(m.content)
                  ? "the response has no readable text"
                  : undefined,
              }
              : undefined}
            readOnly={readOnly}
          />
        ))}
        {activeStream && (
          <div className="streaming-turn" aria-busy="true">
            <span className="sr-only" role="status" aria-live="polite">
              {activeStream.phase === "stopping"
                ? "Stopping generation"
                : activeStream.phase === "connecting"
                ? "Connecting to the model"
                : "Assistant response is streaming"}
            </span>
            {activeStream.item.mode === "send" && (
              <MessageItem
                message={activeStream.user}
                branch={null}
                onTree={() => setTree(true)}
                onEdit={() => undefined}
                onSelectBranch={() => undefined}
                onRegenerate={() => undefined}
                onContinue={() => undefined}
                branchBusy
                generationBusy
                speech={undefined}
              />
            )}
            <MessageItem
              message={activeStream.assistant}
              branch={null}
              onTree={() => setTree(true)}
              onEdit={() => undefined}
              onSelectBranch={() => undefined}
              onRegenerate={() => undefined}
              onContinue={() => undefined}
              branchBusy
              generationBusy
              speech={speechModel
                ? {
                  model: speechModel,
                  voice: speechVoice,
                  controller: speechPlayback.controller,
                  state: speechPlayback.state,
                  disabledReason: "the response is still streaming",
                }
                : undefined}
            />
            {!activeStream.assistant.content && (
              <div className="typing" role="status" aria-label="Assistant is thinking">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        )}
        {sendError && (
          <div className="stream-error" role="alert">
            <span>{sendError}</span>
            {failedPrompt && (
              <button
                type="button"
                onClick={() => {
                  setQueue((current) => enqueuePrompt(current, retryQueuedPrompt(failedPrompt)));
                  setFailedPrompt(undefined);
                  setSendError("");
                }}
              >
                <RefreshCw size={14} /> Retry
              </button>
            )}
          </div>
        )}
      </div>
      {readOnly
        ? (
          <div className="read-only-banner" role="status">
            <Lock size={16} /> Restore this conversation to Chats before editing or continuing it.
          </div>
        )
        : (
          <>
            {queue.length > 0 && (
              <div className="prompt-queue" aria-label="Queued messages" aria-live="polite">
                <div>
                  <strong>{queue.length} queued</strong>
                  <small>Messages run in order on the latest saved branch.</small>
                </div>
                <ol>
                  {queue.map((item, index) => (
                    <li key={item.id}>
                      <span>{index + 1}</span>
                      <p>
                        {item.content ||
                          `${item.attachmentIds.length} attachment${
                            item.attachmentIds.length === 1 ? "" : "s"
                          }`}
                      </p>
                      <IconButton
                        label={`Cancel queued message ${index + 1}`}
                        onClick={() =>
                          setQueue((current) => removeQueuedPrompt(current, item.id))}
                      >
                        <X size={15} />
                      </IconButton>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <Composer
              onSend={send}
              edit={edit}
              cancelEdit={() => setEdit(undefined)}
              disabled={chatModels.length === 0}
              disabledReason={chatModels.length === 0
                ? "No chat-capable model is available."
                : undefined}
              streaming={streaming}
              stopping={activeStream?.phase === "stopping"}
              queuedCount={queue.length}
              transcriptionModels={transcriptionModels}
              transcriptionModel={transcriptionModel}
              setTranscriptionModel={setTranscriptionModel}
              imageModels={imageModels}
              imageEditModels={imageEditModels}
              onStop={() => {
                if (activeStream?.phase === "stopping") return;
                setActiveStream((current) => current ? { ...current, phase: "stopping" } : current);
                const stop = activeStream && !activeStream.user.id.startsWith("pending-user-")
                  ? chatStreamAdapter.stop?.({
                    conversationId: conversation?.id ?? activeId,
                    userMessageId: activeStream.user.id,
                    operationId: activeStream.item.operationId,
                  })
                  : undefined;
                if (stop) {
                  void stop.catch(() =>
                    streamAbortRef.current?.abort(
                      new DOMException("Stopped by user", "AbortError"),
                    )
                  );
                } else {
                  streamAbortRef.current?.abort(
                    new DOMException("Stopped by user", "AbortError"),
                  );
                }
              }}
            />
          </>
        )}
      {tree && (
        <TreePanel
          messages={localMessages}
          activeLeafId={conversation?.activeLeafId}
          close={() => setTree(false)}
          onSelect={selectBranch}
          busy={branchBusy || streaming || queue.length > 0}
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
                <button
                  className="secondary push"
                  disabled
                  title="Avatar editing is not available yet"
                >
                  Change avatar
                </button>
              </div>
              <Field label="Display name" value={user.name} />
              <Field label="Email address" value={user.email} />
              <div className="setting-row">
                <span>
                  <strong>Password</strong>
                  <small>Last changed 3 months ago</small>
                </span>
                <button
                  className="secondary"
                  disabled
                  title="Password changes are not available in the app yet"
                >
                  Change password
                </button>
              </div>
              <div className="danger-zone">
                <h3>Danger zone</h3>
                <div className="setting-row">
                  <span>
                    <strong>Delete account</strong>
                    <small>Schedule your account and data for deletion.</small>
                  </span>
                  <button
                    className="danger-button"
                    disabled
                    title="Self-service account deletion is not available yet"
                  >
                    Delete account
                  </button>
                </div>
              </div>
            </>
          )}
          {section === "appearance" && (
            <>
              <SectionTitle title="Appearance" subtitle="Choose how DG Chat looks on this device" />
              <AppearancePreferences />
            </>
          )}
          {section === "personalization" && (
            <>
              <SectionTitle
                title="Personalization"
                subtitle="Shape how assistants respond to you"
              />
              <PersonalizationPreferences />
            </>
          )}
          {section === "data" && (
            <>
              <SectionTitle
                title="Data & privacy"
                subtitle="Control storage, exports, and retention"
              />
              <div className="setting-row">
                <span>
                  <strong>Provider payload storage</strong>
                  <small>Managed by your administrator and off by default.</small>
                </span>
                <span className="status muted">Administrator controlled</span>
              </div>
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
          {section === "tokens" && <PersonalTokenSettings />}
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
      <input value={value} readOnly aria-readonly="true" />
    </label>
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
  { id: "resilience", label: "Routing resilience", icon: GitBranch },
  { id: "tools", label: "Tools & search", icon: Globe2 },
  { id: "usage", label: "Usage analytics", icon: BarChart3 },
  { id: "jobs", label: "Background jobs", icon: Boxes },
  { id: "audit", label: "Audit log", icon: Shield },
  { id: "retention", label: "Retention", icon: Database },
  { id: "storage", label: "Storage & backups", icon: HardDrive },
];
function AdminView(
  { onMenu, section, setSection, search, setSearch }: {
    onMenu: () => void;
    section: AdminSection;
    setSection: (section: AdminSection) => void;
    search: AdminSearch;
    setSearch: (search: AdminSearch) => void;
  },
) {
  const currentLabel = adminNav.find((item) => item.id === section)?.label ?? "Admin";
  useEffect(() => {
    document.title = `${currentLabel} · DG Chat Admin`;
  }, [currentLabel]);
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
            <Link
              key={id}
              to="/admin/$section"
              params={{ section: id }}
              search={{}}
              className={section === id ? "active" : ""}
              aria-current={section === id ? "page" : undefined}
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <section className="admin-content">
          <AdminSectionContent
            section={section}
            setSection={setSection}
            search={search}
            setSearch={setSearch}
          />
        </section>
      </div>
    </main>
  );
}

function AdminSectionContent(
  { section, setSection, search, setSearch }: {
    section: AdminSection;
    setSection: (s: AdminSection) => void;
    search: AdminSearch;
    setSearch: (search: AdminSearch) => void;
  },
) {
  if (section === "overview") {
    return <AdminOverview setSection={setSection} />;
  }
  if (section === "applicants") {
    return (
      <>
        <PageHeader title="Applicants" subtitle="Review people waiting to join your workspace" />
        <div className="table-card full">
          <Applicants />
        </div>
      </>
    );
  }
  if (section === "providers") {
    return <AdminProviders />;
  }
  if (section === "models") {
    return <AdminModels />;
  }
  if (section === "resilience") {
    return <AdminResilience />;
  }
  if (section === "tools") {
    return <AdminTools />;
  }
  if (section === "users") {
    return <UserManagement />;
  }
  if (section === "usage") {
    return <AdminAnalyticsView search={search} onSearch={setSearch} />;
  }
  if (section === "jobs") {
    return <AdminJobsView search={search} onSearch={setSearch} />;
  }
  if (section === "audit") {
    return <AuditLog />;
  }
  if (section === "retention") {
    return <AdminRetentionView search={search} onSearch={setSearch} />;
  }
  return <AdminBackupsView />;
}
function AdminOverview({ setSection }: { setSection: (section: AdminSection) => void }) {
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const usage = useQuery({ queryKey: ["admin-usage"], queryFn: api.adminUsage });
  const providers = useQuery({ queryKey: ["admin-providers"], queryFn: api.adminProviders });
  const audit = useQuery({
    queryKey: ["admin-audit-overview"],
    queryFn: () => api.adminAudit({}, undefined, 3),
  });
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
        <div className="chart-card">
          <BarChart3 size={24} />
          <h3>Usage analytics</h3>
          <p>Explore request volume, token classes, cost, latency, and provider distributions.</p>
          <button className="secondary" onClick={() => setSection("usage")}>Open analytics</button>
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
              <span className={cn("provider-logo", !provider.hasCredential && "warning")}>
                {provider.displayName[0]?.toUpperCase()}
              </span>
              <span>
                <strong>{provider.displayName}</strong>
                <small>{provider.hasCredential ? "Credential stored" : "Credential missing"}</small>
              </span>
              <span className="push right">
                <strong>{provider.enabled ? provider.healthStatus : "disabled"}</strong>
              </span>
              <span
                className={cn(
                  "health-dot",
                  (!provider.enabled || provider.healthStatus !== "healthy") && "down",
                )}
              />
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
        <div className="activity-card">
          <div className="card-title">
            <div>
              <h3>Recent audit activity</h3>
              <p>Latest immutable security and administration events</p>
            </div>
            <button className="link-button" onClick={() => setSection("audit")}>
              View all <ArrowRight size={15} />
            </button>
          </div>
          {audit.isLoading && <div className="empty-mini">Loading activity…</div>}
          {audit.isError && <div className="empty-mini">Recent activity is unavailable</div>}
          {audit.data?.data.map((event) => (
            <div className="activity-row" key={event.id}>
              <Shield size={15} />
              <span>
                <strong>{event.action}</strong>
                <small>{event.targetType}</small>
              </span>
              <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
            </div>
          ))}
          {!audit.isLoading && !audit.isError && !audit.data?.data.length && (
            <div className="empty-mini">No audit events recorded yet</div>
          )}
        </div>
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
      <PageHeader title="Users" subtitle="Review access state, roles, and current balances" />
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

type AuditFilterDraft = {
  action: string;
  actorId: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
};
const emptyAuditFilters: AuditFilterDraft = {
  action: "",
  actorId: "",
  targetType: "",
  targetId: "",
  from: "",
  to: "",
};
function appliedAuditFilters(draft: AuditFilterDraft): AuditFilters {
  return {
    action: draft.action.trim() || undefined,
    actorId: draft.actorId.trim() || undefined,
    targetType: draft.targetType.trim() || undefined,
    targetId: draft.targetId.trim() || undefined,
    from: draft.from ? new Date(draft.from).toISOString() : undefined,
    to: draft.to ? new Date(draft.to).toISOString() : undefined,
  };
}
function AuditLog() {
  const [draft, setDraft] = useState<AuditFilterDraft>(emptyAuditFilters);
  const [filters, setFilters] = useState<AuditFilters>({});
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors.at(-1);
  const events = useQuery({
    queryKey: ["admin-audit", filters, cursor],
    queryFn: () => api.adminAudit(filters, cursor),
  });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilters(appliedAuditFilters(draft));
    setCursors([undefined]);
  };
  const reset = () => {
    setDraft(emptyAuditFilters);
    setFilters({});
    setCursors([undefined]);
  };
  const update = (field: keyof AuditFilterDraft) => (event: ChangeEvent<HTMLInputElement>) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  return (
    <>
      <PageHeader title="Audit log" subtitle="Review immutable security and administration events">
        <a
          className="secondary"
          href={api.adminAuditCsvUrl(filters, cursor)}
          download="dg-chat-audit.csv"
        >
          <Download size={16} /> Export page CSV
        </a>
      </PageHeader>
      <form className="audit-filters" onSubmit={apply} aria-label="Audit filters">
        <label>
          <span>Action</span>
          <input
            value={draft.action}
            onChange={update("action")}
            placeholder="user.state.suspended"
          />
        </label>
        <label>
          <span>Actor ID</span>
          <input value={draft.actorId} onChange={update("actorId")} placeholder="UUID" />
        </label>
        <label>
          <span>Target type</span>
          <input value={draft.targetType} onChange={update("targetType")} placeholder="user" />
        </label>
        <label>
          <span>Target ID</span>
          <input value={draft.targetId} onChange={update("targetId")} placeholder="Identifier" />
        </label>
        <label>
          <span>From</span>
          <input type="datetime-local" value={draft.from} onChange={update("from")} />
        </label>
        <label>
          <span>To</span>
          <input type="datetime-local" value={draft.to} onChange={update("to")} />
        </label>
        <div className="audit-filter-actions">
          <button className="primary" type="submit">Apply filters</button>
          <button className="secondary" type="button" onClick={reset}>Reset</button>
        </div>
      </form>
      <div className="table-card full audit-table-card">
        {events.isLoading && <div className="empty-mini" role="status">Loading audit events…</div>}
        {events.isError && (
          <div className="empty-mini" role="alert">
            Audit events could not be loaded. Check the filters and try again.
          </div>
        )}
        {!events.isLoading && !events.isError && !events.data?.data.length && (
          <div className="empty-mini">No audit events match these filters.</div>
        )}
        {!!events.data?.data.length && (
          <table className="audit-table" aria-label="Audit events">
            <thead>
              <tr>
                <th>TIME</th>
                <th>ACTION</th>
                <th>ACTOR</th>
                <th>TARGET</th>
                <th>DETAILS</th>
              </tr>
            </thead>
            <tbody>
              {events.data.data.map((item) => {
                const metadata = Object.keys(item.metadata).length
                  ? JSON.stringify(item.metadata)
                  : "—";
                return (
                  <tr key={item.id}>
                    <td>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString()}
                      </time>
                    </td>
                    <td>
                      <strong>{item.action}</strong>
                    </td>
                    <td>
                      <code title={item.actorId ?? "System"}>{item.actorId ?? "System"}</code>
                    </td>
                    <td>
                      <strong>{item.targetType}</strong>
                      <code title={item.targetId ?? "—"}>{item.targetId ?? "—"}</code>
                    </td>
                    <td>
                      <code className="audit-metadata" title={metadata}>{metadata}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="audit-pagination" aria-label="Audit pagination">
        <button
          className="secondary"
          disabled={cursors.length === 1 || events.isFetching}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          <ChevronLeft size={15} /> Previous
        </button>
        <span>Page {cursors.length}</span>
        <button
          className="secondary"
          disabled={!events.data?.nextCursor || events.isFetching}
          onClick={() => {
            const next = events.data?.nextCursor;
            if (next) setCursors((current) => [...current, next]);
          }}
        >
          Next <ChevronRight size={15} />
        </button>
      </div>
    </>
  );
}
export function App(
  { initialView = "chat", initialAdminSection = "overview", initialAdminSearch = {} }: {
    initialView?: View;
    initialAdminSection?: AdminSection;
    initialAdminSearch?: AdminSearch;
  } = {},
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setupQuery = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const userQuery = useQuery({ queryKey: ["me"], queryFn: api.me });
  const conversationQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations });
  const deletedConversationQuery = useQuery({
    queryKey: ["conversations", "deleted"],
    queryFn: api.deletedConversations,
  });
  const modelQuery = useQuery({ queryKey: ["models"], queryFn: api.models });
  const preferencesQuery = usePreferences();
  const preferenceMutation = usePreferenceMutation();
  const [modelPreferenceError, setModelPreferenceError] = useState("");
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
  const [activeId, setActiveId] = useState(() => {
    try {
      return sessionStorage.getItem("dg-chat.active-conversation") ?? "";
    } catch {
      return "";
    }
  });
  const [busyConversationId, setBusyConversationId] = useState("");
  const updateGenerationBusy = useCallback((conversationId: string, busy: boolean) => {
    setBusyConversationId((current) =>
      busy ? conversationId : current === conversationId ? "" : current
    );
  }, []);
  const [view, setViewState] = useState<View>(initialView);
  const [adminSection, setAdminSectionState] = useState<AdminSection>(initialAdminSection);
  useEffect(() => setViewState(initialView), [initialView]);
  useEffect(() => setAdminSectionState(initialAdminSection), [initialAdminSection]);
  const setView = (next: View) => {
    if (next === "admin") {
      void navigate({ to: "/admin/$section", params: { section: adminSection } });
      return;
    }
    if (view === "admin") {
      void navigate({ to: "/" });
    }
    setViewState(next);
  };
  const setAdminSection = (next: AdminSection) => {
    setAdminSectionState(next);
    void navigate({ to: "/admin/$section", params: { section: next }, search: {} });
  };
  const setAdminSearch = (search: AdminSearch) => {
    void navigate({ to: "/admin/$section", params: { section: adminSection }, search });
  };
  const lifecycleQuery = view === "trash" ? deletedConversationQuery : conversationQuery;
  const lifecycleLoading = lifecycleQuery.isLoading;
  const lifecycleBlockingError = lifecycleQuery.isError && lifecycleQuery.data === undefined;
  const lifecycleStaleWarning = lifecycleQuery.isError && lifecycleQuery.data !== undefined;
  const [mobile, setMobile] = useState(false);
  const conversationSearchRef = useRef<HTMLInputElement>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [selectedModel, setSelectedModel] = useState(models[0]?.id ?? "openai/gpt-4.1");
  const preferredModelApplied = useRef(false);
  const messagesQuery = useQuery({
    queryKey: ["messages", activeId],
    queryFn: () => api.messages(activeId),
    enabled: Boolean(activeId),
  });
  useAppliedPreferences(preferencesQuery.data);
  useEffect(() => {
    if (demoMode) return;
    const destination = setupDestination("/", setupQuery.data, userQuery.isError);
    if (destination) location.replace(destination);
  }, [userQuery.isError, setupQuery.data, demoMode]);
  useEffect(() => {
    if (view !== "chat" && view !== "archived" && view !== "trash") return;
    if (lifecycleQuery.isLoading) return;
    const visible = conversationsForView(allConversations, view);
    if (!visible.some((conversation) => conversation.id === activeId)) {
      setActiveId(visible[0]?.id ?? "");
    }
  }, [activeId, allConversations, lifecycleQuery.isLoading, view]);
  useEffect(() => {
    try {
      if (activeId) sessionStorage.setItem("dg-chat.active-conversation", activeId);
      else if (!lifecycleQuery.isLoading) sessionStorage.removeItem("dg-chat.active-conversation");
    } catch {
      // Storage can be unavailable in hardened/private browser contexts; in-memory selection works.
    }
  }, [activeId, lifecycleQuery.isLoading]);
  useEffect(() => {
    const chatModels = models.filter((model) => model.capabilities.includes("chat"));
    if (!chatModels.length) return;
    const preferred = preferencesQuery.data?.preferredModelId;
    if (!preferredModelApplied.current && preferencesQuery.data) {
      preferredModelApplied.current = true;
      setSelectedModel(
        preferred && chatModels.some((model) => model.id === preferred)
          ? preferred
          : chatModels[0].id,
      );
    } else if (!chatModels.some((model) => model.id === selectedModel)) {
      setSelectedModel(chatModels[0].id);
    }
  }, [models, preferencesQuery.data?.preferredModelId, selectedModel]);
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
      const resolved = await api.createConversation(
        "New chat",
        crypto.randomUUID(),
        temporaryChatUntilPreferencesResolve(demoMode, preferencesQuery.data),
      );
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
  useGlobalShortcuts({
    newChat: () => void open("new"),
    focusSearch: () =>
      focusConversationSearch({
        openDrawer: () => setMobile(true),
        focus: () => conversationSearchRef.current?.focus(),
      }),
  });
  const conversationCreated = async (id: string) => {
    await conversationQuery.refetch();
    setActiveId(id);
  };
  const updateConversation = async (
    conversation: Conversation,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ) => {
    const updated = await api.updateConversation(conversation, patch);
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
      conversation.id !== activeId || view === "settings" || view === "tokens" ||
      view === "admin" || view === "knowledge"
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
        searchInputRef={conversationSearchRef}
        busyConversationId={busyConversationId}
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
          setSelectedModel={(modelId) => {
            setSelectedModel(modelId);
            setModelPreferenceError("");
            if (preferencesQuery.data) {
              preferenceMutation.mutate({
                current: preferencesQuery.data,
                patch: { preferredModelId: modelId },
              }, {
                onError: () => {
                  setModelPreferenceError(
                    "Model selected for this chat, but the default could not be saved.",
                  );
                  void queryClient.invalidateQueries({ queryKey: ["preferences"] });
                },
              });
            }
          }}
          onMenu={() => setMobile(true)}
          balance={user.balance}
          onConversationCreated={conversationCreated}
          onUpdateConversation={updateConversation}
          readOnly={view !== "chat"}
          saveHistory={!temporaryChatUntilPreferencesResolve(demoMode, preferencesQuery.data)}
          modelPreferenceError={modelPreferenceError}
          historyPreferenceWarning={historyPreferenceWarning(demoMode, preferencesQuery.isError)}
          onGenerationBusyChange={updateGenerationBusy}
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
              ? "Create a chat to start a conversation."
              : "Conversations moved here will appear in this view."}
          </p>
          {view === "chat" && (
            <button
              className="primary"
              type="button"
              onClick={() => void open("new")}
            >
              <Plus size={16} aria-hidden="true" />
              New chat
            </button>
          )}
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
      {view === "admin" && (
        <AdminView
          onMenu={() => setMobile(true)}
          section={adminSection}
          setSection={setAdminSection}
          search={initialAdminSearch}
          setSearch={setAdminSearch}
        />
      )}
      {view === "knowledge" && <KnowledgeView onMenu={() => setMobile(true)} />}
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
  const oidcError = new URLSearchParams(location.search).get("error");
  const [error, setError] = useState(() =>
    oidcError
      ? oidcError === "oidc_account_not_linked"
        ? "That SSO identity is not linked to this account. Sign in with your existing method."
        : "Organization SSO could not complete. Please try again or use email and password."
      : ""
  );
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
  const startOidc = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.startOidc();
      location.assign(result.url);
    } catch {
      setError("Organization SSO is temporarily unavailable. Please try again.");
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
          <button className="oidc-button" type="button" onClick={startOidc} disabled={busy}>
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
