import { type FormEvent, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, RefreshCw, Shield, Trash2, Users } from "lucide-react";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { useDebouncedValue } from "./useDebouncedValue.ts";
import type {
  AccessGroupPolicyImpact,
  AdminModel,
  AdminTokenAccessItem,
  ModelAccessGroup,
  ModelAlias,
  User,
} from "./types.ts";

const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
const conflict = (error: unknown) => error instanceof ApiError && error.status === 409;

export const policyNeedsWideningConfirmation = (impact: AccessGroupPolicyImpact) =>
  impact.modelIdsBecomingPublic.length > 0 || impact.tokenIdsLosingGroupAccess.length > 0 ||
  impact.tokenIdsRevertingToOwnerInheritance.length > 0;

export function selectTokenWithOwner(
  userIds: string[],
  tokenIds: string[],
  token: Pick<AdminTokenAccessItem, "id" | "ownerId">,
) {
  return {
    userIds: userIds.includes(token.ownerId) ? userIds : [...userIds, token.ownerId],
    tokenIds: tokenIds.includes(token.id) ? tokenIds : [...tokenIds, token.id],
  };
}

export function removeUserAndOwnedTokens(
  userIds: string[],
  tokenIds: string[],
  userId: string,
  tokenOwners: Array<{ tokenId: string; ownerId: string }>,
) {
  const owned = new Set(
    tokenOwners.filter((token) => token.ownerId === userId).map((token) => token.tokenId),
  );
  return {
    userIds: userIds.filter((id) => id !== userId),
    tokenIds: tokenIds.filter((id) => !owned.has(id)),
  };
}

export function AdminModelAccess({ models }: { models: AdminModel[] }) {
  const client = useQueryClient();
  const sectionRef = useRef<HTMLElement>(null);
  const groups = useQuery({
    queryKey: ["admin-model-access-groups"],
    queryFn: api.adminModelAccessGroups,
  });
  const aliases = useQuery({ queryKey: ["admin-model-aliases"], queryFn: api.adminModelAliases });
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const [group, setGroup] = useState<ModelAccessGroup | "new">();
  const [alias, setAlias] = useState<ModelAlias | "new">();
  const [deletingGroup, setDeletingGroup] = useState<ModelAccessGroup>();
  const [deletingAlias, setDeletingAlias] = useState<ModelAlias>();
  const [announcement, setAnnouncement] = useState("");
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["admin-model-access-groups"] }),
      client.invalidateQueries({ queryKey: ["admin-model-aliases"] }),
    ]);
  };
  const loading = groups.isLoading || aliases.isLoading || users.isLoading;
  const error = groups.error ?? aliases.error ?? users.error;
  const announceAndFocus = (text: string) => {
    setAnnouncement(text);
    requestAnimationFrame(() => sectionRef.current?.focus());
  };
  return (
    <section
      ref={sectionRef}
      className="model-access"
      aria-labelledby="model-access-heading"
      tabIndex={-1}
    >
      <p className="ops-announcer" role="status" aria-live="polite">{announcement}</p>
      <div className="model-access-heading">
        <div>
          <h2 id="model-access-heading">Access groups & aliases</h2>
          <p>Control who can discover and call models, including personal API tokens.</p>
        </div>
        <div>
          <button className="secondary" disabled={!models.length} onClick={() => setAlias("new")}>
            <Plus size={15} /> Alias
          </button>
          <button className="primary" onClick={() => setGroup("new")}>
            <Plus size={15} /> Access group
          </button>
        </div>
      </div>
      <div className="entitlement-invariant">
        <Shield size={18} aria-hidden="true" />
        <p>
          <strong>Token access can only become narrower.</strong>{" "}
          Tokens in inherited mode follow their owner’s current groups. Tokens in restricted mode
          use the intersection of explicit token groups and owner groups—and fail closed when no
          explicit groups remain. Assigning a token never grants access its owner cannot use.
        </p>
      </div>
      {loading && <div className="registry-state" role="status">Loading model access…</div>}
      {error && (
        <div className="registry-state" role="alert">
          <p>{message(error)}</p>
          <button
            className="secondary"
            onClick={() => {
              void groups.refetch();
              void aliases.refetch();
              void users.refetch();
            }}
          >
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}
      {!loading && !error && (
        <div className="model-access-grid">
          <div>
            <div className="model-access-subhead">
              <h3>Groups</h3>
              <span>{groups.data?.length ?? 0}</span>
            </div>
            {groups.data?.length
              ? (
                <ul className="access-list">
                  {groups.data.map((item) => (
                    <li key={item.id}>
                      <span className="access-icon">
                        <Users size={16} />
                      </span>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.description || "No description"}</small>
                        <span>
                          {item.userIds.length} users · {item.tokenIds.length} restricted tokens ·
                          {" "}
                          {item.modelIds.length} models
                        </span>
                      </div>
                      <button
                        className="icon-button"
                        aria-label={`Edit group ${item.name}`}
                        onClick={() => setGroup(item)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-button danger-icon"
                        aria-label={`Delete group ${item.name}`}
                        onClick={() => setDeletingGroup(item)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )
              : (
                <p className="registry-state">
                  No access groups. Without groups, approved users use the installation’s default
                  model access.
                </p>
              )}
          </div>
          <div>
            <div className="model-access-subhead">
              <h3>Aliases</h3>
              <span>{aliases.data?.length ?? 0}</span>
            </div>
            {aliases.data?.length
              ? (
                <ul className="access-list">
                  {aliases.data.map((item) => (
                    <li key={item.id}>
                      <span className="access-icon">
                        <KeyRound size={16} />
                      </span>
                      <div>
                        <strong>{item.alias}</strong>
                        <small>
                          {models.find((model) => model.id === item.targetModelId)?.displayName ??
                            "Missing target"}
                        </small>
                        <span>{item.description || "No description"}</span>
                      </div>
                      <button
                        className="icon-button"
                        aria-label={`Edit alias ${item.alias}`}
                        onClick={() => setAlias(item)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-button danger-icon"
                        aria-label={`Delete alias ${item.alias}`}
                        onClick={() => setDeletingAlias(item)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )
              : (
                <p className="registry-state">
                  No aliases. Clients must use canonical public model IDs.
                </p>
              )}
          </div>
        </div>
      )}
      {!loading && !error && <TokenAccessModes />}
      {group && (
        <GroupDialog
          group={group === "new" ? undefined : group}
          models={models}
          users={users.data ?? []}
          close={() => setGroup(undefined)}
          saved={async () => {
            setGroup(undefined);
            await refresh();
            announceAndFocus(group === "new" ? "Access group created." : "Access group updated.");
          }}
        />
      )}
      {alias && (
        <AliasDialog
          alias={alias === "new" ? undefined : alias}
          models={models}
          close={() => setAlias(undefined)}
          saved={async () => {
            setAlias(undefined);
            await refresh();
            announceAndFocus(alias === "new" ? "Model alias created." : "Model alias updated.");
          }}
        />
      )}
      {deletingGroup && (
        <DeleteDialog
          title={`Delete ${deletingGroup.name}?`}
          detail="Members lose this group assignment. Their other group access remains unchanged."
          impact={() => api.previewAdminModelAccessGroupPolicy(deletingGroup, null)}
          close={() => setDeletingGroup(undefined)}
          remove={() => api.deleteAdminModelAccessGroup(deletingGroup)}
          removed={async () => {
            setDeletingGroup(undefined);
            await refresh();
            announceAndFocus("Access group deleted.");
          }}
        />
      )}
      {deletingAlias && (
        <DeleteDialog
          title={`Delete alias ${deletingAlias.alias}?`}
          detail="Requests using this alias will stop resolving immediately."
          close={() => setDeletingAlias(undefined)}
          remove={() => api.deleteAdminModelAlias(deletingAlias)}
          removed={async () => {
            setDeletingAlias(undefined);
            await refresh();
            announceAndFocus("Model alias deleted.");
          }}
        />
      )}
    </section>
  );
}

function TokenAccessModes() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query);
  const [confirming, setConfirming] = useState<AdminTokenAccessItem>();
  const [notice, setNotice] = useState("");
  const tokens = useQuery({
    queryKey: ["admin-model-access-mode-tokens", debouncedQuery],
    queryFn: ({ signal }) => api.adminModelAccessTokens(debouncedQuery, undefined, 50, signal),
  });
  const mutation = useMutation({
    mutationFn: ({ token, mode }: {
      token: AdminTokenAccessItem;
      mode: "inherit" | "restricted";
    }) => api.setAdminTokenAccessMode(token, mode),
    onSuccess: async (_saved, variables) => {
      setConfirming(undefined);
      setNotice(
        variables.mode === "inherit"
          ? `${variables.token.name} now inherits its owner’s access.`
          : `${variables.token.name} is now restricted to explicit token groups.`,
      );
      await tokens.refetch();
    },
  });
  return (
    <div className="token-mode-panel">
      <div className="model-access-subhead">
        <div>
          <h3>Token access mode</h3>
          <p>
            Inherited tokens follow all current owner groups. Restricted tokens can use only their
            explicit groups and fail closed when none are assigned.
          </p>
        </div>
      </div>
      <label className="field">
        <span>Find a token</span>
        <input
          type="search"
          value={query}
          placeholder="Token name, preview, or owner"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="ops-announcer" role="status" aria-live="polite">{notice}</p>
      {tokens.isLoading && <p role="status">Loading token access modes…</p>}
      {tokens.isError && <p role="alert">Could not load token access modes.</p>}
      <div className="token-mode-list">
        {tokens.data?.data.filter((token) => !token.revokedAt).map((token) => (
          <article key={token.id}>
            <div>
              <strong>{token.name}</strong>
              <code>{token.preview}</code>
              <small>{token.ownerEmail}</small>
            </div>
            <span className="status-chip">
              {token.accessMode === "inherit" ? "Inherits owner" : "Restricted"}
            </span>
            {token.accessMode === "inherit"
              ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={mutation.isPending}
                  onClick={() =>
                    void mutation.mutateAsync({ token, mode: "restricted" }).catch(() => undefined)}
                >
                  Restrict token
                </button>
              )
              : (
                <button
                  type="button"
                  className="secondary"
                  disabled={mutation.isPending}
                  onClick={() => setConfirming(token)}
                >
                  Use owner access
                </button>
              )}
          </article>
        ))}
      </div>
      {confirming && (
        <div className="policy-impact" role="alert">
          <strong>Allow {confirming.name} to inherit its owner’s access?</strong>
          <p>
            This can immediately widen the token from {confirming.groupIds.length}{" "}
            explicit group(s) to every group currently held by {confirming.ownerEmail}.
          </p>
          {mutation.isError && <p className="form-error">{message(mutation.error)}</p>}
          <div className="modal-actions">
            <button className="secondary" type="button" onClick={() => setConfirming(undefined)}>
              Cancel
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={mutation.isPending}
              onClick={() =>
                void mutation.mutateAsync({ token: confirming, mode: "inherit" }).catch(
                  () => undefined,
                )}
            >
              {mutation.isPending ? "Updating…" : "Confirm owner inheritance"}
            </button>
          </div>
        </div>
      )}
      {mutation.isError && !confirming && <p role="alert">{message(mutation.error)}</p>}
    </div>
  );
}

function GroupDialog(
  { group, models, users, close, saved }: {
    group?: ModelAccessGroup;
    models: AdminModel[];
    users: User[];
    close(): void;
    saved(): Promise<void>;
  },
) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [userIds, setUserIds] = useState(group?.userIds ?? []);
  const [tokenIds, setTokenIds] = useState(group?.tokenIds ?? []);
  const [tokenOwners, setTokenOwners] = useState(group?.tokenOwners ?? []);
  const [modelIds, setModelIds] = useState(group?.modelIds ?? []);
  const [filter, setFilter] = useState("");
  const debouncedFilter = useDebouncedValue(filter);
  const [impact, setImpact] = useState<AccessGroupPolicyImpact>();
  const client = useQueryClient();
  const tokenSearch = useInfiniteQuery({
    queryKey: ["admin-model-access-tokens", debouncedFilter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.adminModelAccessTokens(debouncedFilter, pageParam, 100, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const tokens =
    tokenSearch.data?.pages.flatMap((page) => page.data).filter((token) => !token.revokedAt) ?? [];
  const input = () => ({
    name: name.trim(),
    description: description.trim(),
    userIds,
    modelIds,
    tokenIds,
  });
  useEffect(() => setImpact(undefined), [name, description, userIds, modelIds, tokenIds]);
  const mutation = useMutation({
    mutationFn: async (policy: ReturnType<typeof input>) => {
      const created = group ? undefined : await api.createAdminModelAccessGroup({
        name: policy.name,
        description: policy.description,
      });
      const current = group ?? created!;
      try {
        return await api.replaceAdminModelAccessGroupPolicy(current, policy);
      } catch (error) {
        if (created) {
          try {
            await api.deleteAdminModelAccessGroup(created);
          } catch {
            throw new Error(
              `The empty group was created, but its policy and automatic cleanup failed. Reopen model access and delete it before retrying. ${
                message(error)
              }`,
            );
          }
        }
        throw error;
      }
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ["admin-model-access-groups"] });
      void client.invalidateQueries({ queryKey: ["admin-model-access-tokens"] });
    },
  });
  const preview = useMutation({
    mutationFn: (policy: ReturnType<typeof input>) =>
      group ? api.previewAdminModelAccessGroupPolicy(group, policy) : Promise.resolve({
        modelIdsBecomingPublic: [],
        tokenIdsLosingGroupAccess: [],
        tokenIdsRevertingToOwnerInheritance: [],
      }),
  });
  const toggle = (list: string[], value: string, set: (next: string[]) => void) =>
    set(list.includes(value) ? list.filter((id) => id !== value) : [...list, value]);
  const matches = (value: string) => value.toLowerCase().includes(filter.toLowerCase());
  return (
    <Modal
      title={group ? `Edit access group · ${group.name}` : "Create access group"}
      close={close}
      dismissible={!mutation.isPending}
      variant="wide"
    >
      <form
        className="access-form"
        aria-busy={mutation.isPending}
        onSubmit={async (event: FormEvent) => {
          event.preventDefault();
          try {
            const policy = input();
            const nextImpact = await preview.mutateAsync(policy);
            if (policyNeedsWideningConfirmation(nextImpact)) {
              setImpact(nextImpact);
              return;
            }
            await mutation.mutateAsync(policy);
            await saved();
          } catch { /* rendered */ }
        }}
      >
        <div className="access-basics">
          <label className="field">
            <span>Name</span>
            <input
              data-autofocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              maxLength={240}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>Filter members and models</span>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Name, email, token, or model"
          />
        </label>
        <div className="assignment-grid">
          <Assignment title="Users" hint="Users receive the union of their assigned groups.">
            {users.filter((item) => matches(`${item.name} ${item.email}`)).map((item) => (
              <Choice
                key={item.id}
                checked={userIds.includes(item.id)}
                label={item.name}
                detail={item.email}
                change={() => {
                  const removing = userIds.includes(item.id);
                  if (removing) {
                    const next = removeUserAndOwnedTokens(
                      userIds,
                      tokenIds,
                      item.id,
                      tokenOwners,
                    );
                    setUserIds(next.userIds);
                    setTokenIds(next.tokenIds);
                    setTokenOwners((current) =>
                      current.filter((entry) => entry.ownerId !== item.id)
                    );
                  } else {
                    setUserIds([...userIds, item.id]);
                  }
                }}
              />
            ))}
          </Assignment>
          <Assignment
            title="API tokens"
            hint="Selecting a token selects its owner. Removing an owner also removes every selected token they own, including tokens outside the current search page."
          >
            {tokens.filter((item) => matches(`${item.name} ${item.preview} ${item.ownerEmail}`))
              .map(
                (item) => (
                  <Choice
                    key={item.id}
                    checked={tokenIds.includes(item.id)}
                    label={`${item.name} · ${item.preview}`}
                    detail={`Owner ${item.ownerEmail}`}
                    change={() => {
                      if (tokenIds.includes(item.id)) {
                        setTokenIds(tokenIds.filter((id) => id !== item.id));
                        setTokenOwners((current) =>
                          current.filter((entry) => entry.tokenId !== item.id)
                        );
                      } else {
                        const next = selectTokenWithOwner(userIds, tokenIds, item);
                        setUserIds(next.userIds);
                        setTokenIds(next.tokenIds);
                        setTokenOwners((current) => [
                          ...current.filter((entry) => entry.tokenId !== item.id),
                          { tokenId: item.id, ownerId: item.ownerId },
                        ]);
                      }
                    }}
                  />
                ),
              )}
            {tokenSearch.isLoading && <p role="status">Searching tokens…</p>}
            {tokenSearch.isError && (
              <p role="alert">Token search failed. Try changing the filter.</p>
            )}
            {tokenSearch.hasNextPage && (
              <button
                type="button"
                className="secondary"
                disabled={tokenSearch.isFetchingNextPage}
                onClick={() => void tokenSearch.fetchNextPage()}
              >
                {tokenSearch.isFetchingNextPage ? "Loading…" : "Load more tokens"}
              </button>
            )}
          </Assignment>
          <Assignment title="Models" hint="Only enabled models should be assigned.">
            {models.filter((item) => matches(`${item.displayName} ${item.publicModelId}`)).map((
              item,
            ) => (
              <Choice
                key={item.id}
                checked={modelIds.includes(item.id)}
                label={`${item.displayName}${item.enabled ? "" : " (disabled)"}`}
                detail={`${item.publicModelId}${item.enabled ? "" : " · unavailable to callers"}`}
                change={() => toggle(modelIds, item.id, setModelIds)}
              />
            ))}
          </Assignment>
        </div>
        {impact && (
          <div className="policy-impact" role="alert">
            <strong>Confirm access widening</strong>
            {impact.modelIdsBecomingPublic.length > 0 && (
              <p>
                {impact.modelIdsBecomingPublic.length}{" "}
                model(s) will have no access group and become public to every approved user.
              </p>
            )}
            {impact.tokenIdsLosingGroupAccess.length > 0 && (
              <p>{impact.tokenIdsLosingGroupAccess.length} token(s) will lose this group.</p>
            )}
            {impact.tokenIdsRevertingToOwnerInheritance.length > 0 && (
              <p>
                {impact.tokenIdsRevertingToOwnerInheritance.length}{" "}
                token(s) will return to inheriting all current owner access.
              </p>
            )}
            <button
              type="button"
              className="danger-button"
              disabled={mutation.isPending}
              onClick={async () => {
                try {
                  await mutation.mutateAsync(input());
                  await saved();
                } catch { /* rendered below */ }
              }}
            >
              {mutation.isPending ? "Saving…" : "Confirm widening and save"}
            </button>
          </div>
        )}
        {(mutation.isError || preview.isError) && (
          <p className="form-error" role="alert">
            {conflict(mutation.error ?? preview.error)
              ? "This group changed in another session. Close and reopen it before saving."
              : message(mutation.error ?? preview.error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={mutation.isPending} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={mutation.isPending || preview.isPending || !name.trim() || Boolean(impact)}
          >
            {mutation.isPending || preview.isPending ? "Checking policy…" : "Save group"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Assignment(
  { title, hint, children }: { title: string; hint: string; children: React.ReactNode },
) {
  return (
    <fieldset className="assignment">
      <legend>{title}</legend>
      <small>{hint}</small>
      <div>{children}</div>
    </fieldset>
  );
}
function Choice(
  { checked, label, detail, change }: {
    checked: boolean;
    label: string;
    detail: string;
    change(): void;
  },
) {
  return (
    <label>
      <input type="checkbox" checked={checked} onChange={change} />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function AliasDialog(
  { alias, models, close, saved }: {
    alias?: ModelAlias;
    models: AdminModel[];
    close(): void;
    saved(): Promise<void>;
  },
) {
  const [name, setName] = useState(alias?.alias ?? "");
  const [description, setDescription] = useState(alias?.description ?? "");
  const [targetModelId, setTargetModelId] = useState(alias?.targetModelId ?? models[0]?.id ?? "");
  const mutation = useMutation({
    mutationFn: () =>
      alias
        ? api.updateAdminModelAlias(alias, {
          alias: name.trim(),
          targetModelId,
          description: description.trim(),
        })
        : api.createAdminModelAlias({
          alias: name.trim(),
          targetModelId,
          description: description.trim(),
        }),
  });
  return (
    <Modal
      title={alias ? `Edit alias · ${alias.alias}` : "Create model alias"}
      close={close}
      dismissible={!mutation.isPending}
    >
      <form
        aria-busy={mutation.isPending}
        onSubmit={async (event: FormEvent) => {
          event.preventDefault();
          try {
            await mutation.mutateAsync();
            await saved();
          } catch { /* rendered */ }
        }}
      >
        <label className="field">
          <span>Alias</span>
          <input
            data-autofocus
            required
            pattern="[A-Za-z0-9._/-]+"
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Target model</span>
          <select required value={targetModelId} onChange={(e) => setTargetModelId(e.target.value)}>
            {models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.displayName} · {model.publicModelId}
                {model.enabled ? "" : " · disabled"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            rows={3}
            maxLength={240}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {mutation.isError && (
          <p role="alert" className="form-error">
            {conflict(mutation.error)
              ? "This alias changed in another session. Close and reopen it before saving."
              : message(mutation.error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={mutation.isPending} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={mutation.isPending || !name.trim() || !targetModelId}
          >
            {mutation.isPending ? "Saving…" : "Save alias"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog(
  { title, detail, impact, close, remove, removed }: {
    title: string;
    detail: string;
    impact?: () => Promise<AccessGroupPolicyImpact>;
    close(): void;
    remove(): Promise<void>;
    removed(): Promise<void>;
  },
) {
  const mutation = useMutation({ mutationFn: remove });
  const impactQuery = useQuery({
    queryKey: ["model-access-delete-impact", title],
    queryFn: impact ?? (() => Promise.resolve(undefined)),
    enabled: Boolean(impact),
  });
  const widening = Boolean(
    impactQuery.data?.modelIdsBecomingPublic.length ||
      impactQuery.data?.tokenIdsRevertingToOwnerInheritance.length,
  );
  return (
    <Modal title={title} close={close} dismissible={!mutation.isPending}>
      <div aria-busy={mutation.isPending}>
        <p>{detail}</p>
        {impactQuery.isLoading && <p role="status">Checking access impact…</p>}
        {impactQuery.isError && (
          <p role="alert" className="form-error">
            Could not verify who would gain access. Close this dialog and try again.
          </p>
        )}
        {impactQuery.data && (
          <div className={widening ? "policy-impact" : "entitlement-invariant"} role="alert">
            {impactQuery.data.modelIdsBecomingPublic.length > 0 && (
              <p>
                <strong>
                  {impactQuery.data.modelIdsBecomingPublic.length} model(s) become public
                </strong>{" "}
                to every approved user because no other group restricts them.
              </p>
            )}
            {impactQuery.data.tokenIdsLosingGroupAccess.length > 0 && (
              <p>{impactQuery.data.tokenIdsLosingGroupAccess.length} token(s) lose this group.</p>
            )}
            {impactQuery.data.tokenIdsRevertingToOwnerInheritance.length > 0 && (
              <p>
                <strong>
                  {impactQuery.data.tokenIdsRevertingToOwnerInheritance.length}{" "}
                  token(s) return to owner inheritance.
                </strong>
              </p>
            )}
          </div>
        )}
        {mutation.isError && (
          <p role="alert" className="form-error">
            {conflict(mutation.error)
              ? "This item changed in another session. Refresh before deleting."
              : message(mutation.error)}
          </p>
        )}
        <div className="modal-actions">
          <button className="secondary" disabled={mutation.isPending} onClick={close}>
            Cancel
          </button>
          <button
            className="danger-button"
            disabled={mutation.isPending || impactQuery.isLoading || impactQuery.isError}
            onClick={async () => {
              try {
                await mutation.mutateAsync();
                await removed();
              } catch { /* rendered */ }
            }}
          >
            {mutation.isPending ? "Deleting…" : widening ? "Delete and widen access" : "Delete"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
