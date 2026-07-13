import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, Ellipsis, Folder, Plus, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../api.ts";
import type {
  Conversation,
  ConversationFolder,
  ConversationFolderMembership,
  ConversationTag,
  ConversationTagBinding,
  ConversationTagSet,
} from "../types.ts";
import { Modal } from "../Modal.tsx";

export const foldersKey = ["folders"] as const;
export const tagsKey = ["tags"] as const;
export type FolderData = {
  data: ConversationFolder[];
  memberships: ConversationFolderMembership[];
};
export type TagData = {
  data: ConversationTag[];
  bindings: ConversationTagBinding[];
  tagSets: ConversationTagSet[];
};
export type WorkspaceCreateAttempt = { kind: "folder" | "tag"; name: string; key: string };

export function workspaceCreateAttempt(
  previous: WorkspaceCreateAttempt | null,
  kind: "folder" | "tag",
  name: string,
  createId: () => string = () => crypto.randomUUID(),
): WorkspaceCreateAttempt {
  return previous?.kind === kind && previous.name === name
    ? previous
    : { kind, name, key: createId() };
}

export function useWorkspace() {
  const folders = useQuery({ queryKey: foldersKey, queryFn: api.folders });
  const tags = useQuery({ queryKey: tagsKey, queryFn: api.tags });
  return { folders, tags };
}

export function conversationIdsForWorkspace(
  conversations: Conversation[],
  folderData: FolderData | undefined,
  tagData: TagData | undefined,
  folderId: string | null,
  tagIds: string[],
) {
  const folderConversationIds = folderId
    ? new Set(
      folderData?.memberships.filter((item) => item.folderId === folderId).map((item) =>
        item.conversationId
      ),
    )
    : null;
  const tagConversationIds = tagIds.map((tagId) =>
    new Set(
      tagData?.bindings.filter((item) => item.tagId === tagId).map((item) => item.conversationId),
    )
  );
  return conversations.filter((conversation) =>
    (!folderConversationIds || folderConversationIds.has(conversation.id)) &&
    tagConversationIds.every((ids) => ids.has(conversation.id))
  ).map((conversation) => conversation.id);
}

export function WorkspaceNavigation({
  folders,
  tags,
  selectedFolder,
  selectedTags,
  onSelectFolder,
  onToggleTag,
  foldersError = false,
  tagsError = false,
  retryFolders,
  retryTags,
}: {
  folders?: FolderData;
  tags?: TagData;
  selectedFolder: string | null;
  selectedTags: string[];
  onSelectFolder: (id: string | null) => void;
  onToggleTag: (id: string) => void;
  foldersError?: boolean;
  tagsError?: boolean;
  retryFolders: () => void;
  retryTags: () => void;
}) {
  const client = useQueryClient();
  const [creating, setCreating] = useState<"folder" | "tag" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ConversationFolder | null>(null);
  const [editingTag, setEditingTag] = useState<ConversationTag | null>(null);
  const [tagColor, setTagColor] = useState("#7660bf");
  const createAttempt = useRef<WorkspaceCreateAttempt | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const createFolder = useMutation({
    mutationFn: ({ name, key }: { name: string; key: string }) => api.createFolder(name, key),
    onSuccess: async (folder) => {
      await client.invalidateQueries({ queryKey: foldersKey });
      setCreating(null);
      setName("");
      onSelectFolder(folder.id);
    },
    onError: () => setError("Couldn’t create the project."),
  });
  const createTag = useMutation({
    mutationFn: ({ name, key }: { name: string; key: string }) =>
      api.createTag(name, "#7660bf", key),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: tagsKey });
      setCreating(null);
      setName("");
    },
    onError: () => setError("Couldn’t create the tag."),
  });
  const updateFolder = useMutation({
    mutationFn: () => api.updateFolder(editing!, name.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: foldersKey });
      setEditing(null);
      setName("");
    },
    onError: () => setError("Couldn’t rename the project. Refresh and try again."),
  });
  const deleteFolder = useMutation({
    mutationFn: (folder: ConversationFolder) => api.deleteFolder(folder),
    onSuccess: async (_, folder) => {
      if (selectedFolder === folder.id) onSelectFolder(null);
      await client.invalidateQueries({ queryKey: foldersKey });
      setEditing(null);
    },
    onError: () => setError("Couldn’t delete the project. Refresh and try again."),
  });
  const reorderFolders = useMutation({
    mutationFn: (ordered: ConversationFolder[]) => api.reorderFolders(ordered),
    onSuccess: () => {
      setWorkspaceError("");
      return client.invalidateQueries({ queryKey: foldersKey });
    },
    onError: () => setWorkspaceError("Couldn’t reorder projects. Refresh and try again."),
  });
  const updateTag = useMutation({
    mutationFn: () => api.updateTag(editingTag!, { name: name.trim(), color: tagColor }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: tagsKey });
      setEditingTag(null);
      setName("");
    },
    onError: () => setError("Couldn’t update the tag. Refresh and try again."),
  });
  const deleteTag = useMutation({
    mutationFn: (tag: ConversationTag) => api.deleteTag(tag),
    onSuccess: async (_, tag) => {
      if (selectedTags.includes(tag.id)) onToggleTag(tag.id);
      await client.invalidateQueries({ queryKey: tagsKey });
      setEditingTag(null);
    },
    onError: () => setError("Couldn’t delete the tag. Refresh and try again."),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setError("");
    if (editingTag) updateTag.mutate();
    else if (editing) updateFolder.mutate();
    else if (creating) {
      const trimmed = name.trim();
      const attempt = workspaceCreateAttempt(createAttempt.current, creating, trimmed);
      createAttempt.current = attempt;
      if (creating === "folder") createFolder.mutate(attempt);
      else createTag.mutate(attempt);
    }
  };
  return (
    <div className="workspace-navigation">
      <div className="workspace-heading">
        <span>PROJECTS</span>
        <button
          type="button"
          aria-label="Create project"
          onClick={() => {
            setName("");
            setError("");
            createAttempt.current = null;
            setCreating("folder");
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      <button
        type="button"
        className={selectedFolder === null ? "selected" : ""}
        aria-current={selectedFolder === null ? "page" : undefined}
        onClick={() => onSelectFolder(null)}
      >
        <Folder size={15} /> All chats
      </button>
      {folders?.data.map((folder) => (
        <div className="workspace-folder-row" key={folder.id}>
          <button
            type="button"
            className={selectedFolder === folder.id ? "selected" : ""}
            aria-current={selectedFolder === folder.id ? "page" : undefined}
            onClick={() => onSelectFolder(folder.id)}
          >
            <Folder size={15} /> <span>{folder.name}</span>
          </button>
          <button
            type="button"
            aria-label={`Manage ${folder.name}`}
            onClick={() => {
              setName(folder.name);
              setError("");
              setEditing(folder);
            }}
          >
            <Ellipsis size={14} />
          </button>
          <button
            type="button"
            aria-label={`Move ${folder.name} up`}
            disabled={folders.data[0]?.id === folder.id || reorderFolders.isPending}
            onClick={() => {
              const index = folders.data.findIndex((item) => item.id === folder.id);
              const ordered = [...folders.data];
              [ordered[index - 1], ordered[index]] = [ordered[index], ordered[index - 1]];
              reorderFolders.mutate(ordered);
            }}
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            aria-label={`Move ${folder.name} down`}
            disabled={folders.data.at(-1)?.id === folder.id || reorderFolders.isPending}
            onClick={() => {
              const index = folders.data.findIndex((item) => item.id === folder.id);
              const ordered = [...folders.data];
              [ordered[index], ordered[index + 1]] = [ordered[index + 1], ordered[index]];
              reorderFolders.mutate(ordered);
            }}
          >
            <ArrowDown size={13} />
          </button>
        </div>
      ))}
      <div className="workspace-heading">
        <span>TAGS</span>
        <button
          type="button"
          aria-label="Create tag"
          onClick={() => {
            setName("");
            setError("");
            createAttempt.current = null;
            setCreating("tag");
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="tag-filter-list" aria-label="Filter conversations by tag">
        {tags?.data.map((tag) => {
          const selected = selectedTags.includes(tag.id);
          return (
            <span className="tag-filter-item" key={tag.id}>
              <button type="button" aria-pressed={selected} onClick={() => onToggleTag(tag.id)}>
                <i style={{ backgroundColor: tag.color }} aria-hidden="true" />
                {tag.name}
                {selected && <Check size={13} />}
              </button>
              <button
                type="button"
                aria-label={`Manage ${tag.name}`}
                onClick={() => {
                  setEditingTag(tag);
                  setName(tag.name);
                  setTagColor(tag.color);
                  setError("");
                }}
              >
                <Ellipsis size={12} />
              </button>
            </span>
          );
        })}
        {selectedTags.length > 0 && (
          <button
            type="button"
            className="clear-tags"
            onClick={() => selectedTags.forEach(onToggleTag)}
          >
            <X size={13} /> Clear
          </button>
        )}
      </div>
      {(foldersError || tagsError) && (
        <div className="workspace-error" role="alert">
          <span>
            {foldersError && tagsError
              ? "Projects and tags couldn’t be loaded."
              : foldersError
              ? "Projects couldn’t be loaded."
              : "Tags couldn’t be loaded."}
          </span>
          <button
            type="button"
            onClick={() => {
              if (foldersError) retryFolders();
              if (tagsError) retryTags();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {workspaceError && (
        <div className="workspace-error" role="alert">
          <span>{workspaceError}</span>
          <button
            type="button"
            onClick={() => {
              setWorkspaceError("");
              retryFolders();
            }}
          >
            Refresh
          </button>
        </div>
      )}
      {creating && (
        <Modal
          title={creating === "folder" ? "Create project" : "Create tag"}
          close={() => setCreating(null)}
        >
          <form onSubmit={submit}>
            <label className="field">
              <span>{creating === "folder" ? "Project name" : "Tag name"}</span>
              <input
                autoFocus
                data-autofocus
                maxLength={creating === "folder" ? 120 : 64}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {error && <p role="alert" className="form-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!name.trim() || createFolder.isPending || createTag.isPending}
              >
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal
          title="Manage project"
          close={() => setEditing(null)}
          dismissible={!deleteFolder.isPending}
        >
          <form onSubmit={submit}>
            <label className="field">
              <span>Project name</span>
              <input
                autoFocus
                data-autofocus
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="muted">Deleting a project never deletes its conversations.</p>
            {error && <p role="alert" className="form-error">{error}</p>}
            <div className="modal-actions project-modal-actions">
              <button
                type="button"
                className="danger-button"
                disabled={deleteFolder.isPending || updateFolder.isPending}
                onClick={() => deleteFolder.mutate(editing)}
              >
                Delete project
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!name.trim() || name.trim() === editing.name || updateFolder.isPending}
              >
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editingTag && (
        <Modal
          title="Manage tag"
          close={() => setEditingTag(null)}
          dismissible={!deleteTag.isPending}
        >
          <form onSubmit={submit}>
            <label className="field">
              <span>Tag name</span>
              <input
                autoFocus
                data-autofocus
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Color</span>
              <input
                type="color"
                value={tagColor}
                onChange={(event) => setTagColor(event.target.value)}
              />
            </label>
            {error && <p role="alert" className="form-error">{error}</p>}
            <div className="modal-actions project-modal-actions">
              <button
                type="button"
                className="danger-button"
                disabled={deleteTag.isPending || updateTag.isPending}
                onClick={() => deleteTag.mutate(editingTag)}
              >
                Delete tag
              </button>
              <button type="button" className="secondary" onClick={() => setEditingTag(null)}>
                Cancel
              </button>
              <button className="primary" disabled={!name.trim() || updateTag.isPending}>
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function OrganizeConversationDialog({
  conversation,
  folders,
  tags,
  close,
  restoreFocusTarget,
}: {
  conversation: Conversation;
  folders: FolderData;
  tags: TagData;
  close: () => void;
  restoreFocusTarget?: () => HTMLElement | null;
}) {
  const client = useQueryClient();
  const currentFolder =
    folders.memberships.find((item) => item.conversationId === conversation.id)?.folderId ?? "";
  const currentTags = tags.bindings.filter((item) => item.conversationId === conversation.id).map((
    item,
  ) => item.tagId);
  const [folderId, setFolderId] = useState(currentFolder);
  const [tagIds, setTagIds] = useState(currentTags);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    let folderSaved = folderId === currentFolder;
    try {
      if (folderId !== currentFolder) {
        const targetId = folderId || currentFolder;
        const target = folders.data.find((item) => item.id === targetId);
        if (!target) throw new Error("The project no longer exists");
        const ids = folders.memberships.filter((item) => item.folderId === targetId).map((item) =>
          item.conversationId
        );
        const next = folderId
          ? [...ids.filter((value) => value !== conversation.id), conversation.id]
          : ids.filter((value) => value !== conversation.id);
        const affectedIds = [currentFolder, folderId].filter((id): id is string => Boolean(id));
        const expectedMembershipVersions = Object.fromEntries(affectedIds.map((id) => {
          const folder = folders.data.find((item) => item.id === id);
          if (!folder) throw new Error("A project changed in another tab");
          return [id, folder.membershipVersion];
        }));
        await api.setFolderConversations(target, next, expectedMembershipVersions);
        folderSaved = true;
      }
      if (tagIds.join("|") !== currentTags.join("|")) {
        const version = tags.tagSets.find((item) =>
          item.conversationId === conversation.id
        )?.version ?? 0;
        await api.setConversationTags(conversation.id, tagIds, version);
      }
      close();
    } catch {
      setError(
        folderSaved
          ? "The project was saved, but tags could not be updated. Refresh and try again."
          : "Couldn’t organize this conversation. Refresh and try again.",
      );
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: foldersKey }),
        client.invalidateQueries({ queryKey: tagsKey }),
      ]);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Organize conversation"
      close={close}
      dismissible={!busy}
      restoreFocusTarget={restoreFocusTarget}
    >
      <label className="field">
        <span>Project</span>
        <select
          value={folderId}
          disabled={busy}
          onChange={(event) => setFolderId(event.target.value)}
        >
          <option value="">No project</option>
          {folders.data.map((folder) => (
            <option key={folder.id} value={folder.id}>{folder.name}</option>
          ))}
        </select>
      </label>
      <fieldset className="tag-checkboxes">
        <legend>Tags</legend>
        {tags.data.map((tag) => (
          <label key={tag.id}>
            <input
              type="checkbox"
              checked={tagIds.includes(tag.id)}
              disabled={busy}
              onChange={() =>
                setTagIds((ids) =>
                  ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id]
                )}
            />
            <i style={{ backgroundColor: tag.color }} aria-hidden="true" /> {tag.name}
          </label>
        ))}
      </fieldset>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
