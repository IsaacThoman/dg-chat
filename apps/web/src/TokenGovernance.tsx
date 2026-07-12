import { type FormEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, RefreshCw, RotateCcw, ShieldX } from "lucide-react";
import { api, ApiError } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { Token, TokenSecret } from "./types.ts";

const scopeChoices = [
  ["chat:write", "Chat completions"],
  ["models:read", "List models"],
  ["files:read", "Read files"],
  ["files:write", "Upload and delete files"],
] as const;

type TokenDraft = {
  name: string;
  scopes: string[];
  expiresAt: string;
  rpmLimit: string;
  burstLimit: string;
};

const emptyDraft = (): TokenDraft => ({
  name: "",
  scopes: ["chat:write", "models:read"],
  expiresAt: "",
  rpmLimit: "",
  burstLimit: "",
});

const tokenDraft = (token: Token): TokenDraft => ({
  name: token.name,
  scopes: token.scopes,
  expiresAt: token.expiresAt?.slice(0, 16) ?? "",
  rpmLimit: token.rpmLimit === null ? "" : String(token.rpmLimit),
  burstLimit: token.burstLimit === null ? "" : String(token.burstLimit),
});

function parsedDraft(draft: TokenDraft) {
  const rpmLimit = draft.rpmLimit === "" ? null : Number(draft.rpmLimit);
  const burstLimit = draft.burstLimit === "" ? null : Number(draft.burstLimit);
  if (!draft.name.trim() || draft.name.trim().length > 80) return { error: "Enter a token name." };
  if (!draft.scopes.length) return { error: "Select at least one scope." };
  if (
    rpmLimit !== null &&
    (!Number.isInteger(rpmLimit) || rpmLimit < 1 || rpmLimit > 60_000)
  ) {
    return { error: "Requests per minute must be between 1 and 60,000." };
  }
  if (
    burstLimit !== null &&
    (!Number.isInteger(burstLimit) || burstLimit < 1 || burstLimit > 1_000)
  ) {
    return { error: "Burst requests must be between 1 and 1,000." };
  }
  if (rpmLimit !== null && burstLimit !== null && burstLimit > rpmLimit) {
    return { error: "Burst requests cannot exceed requests per minute." };
  }
  const expiresAt = draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    return { error: "Expiration must be in the future." };
  }
  return {
    input: { name: draft.name.trim(), scopes: draft.scopes, expiresAt, rpmLimit, burstLimit },
  };
}

const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;
const formatDate = (value: string | null) => value ? new Date(value).toLocaleString() : "Never";

export function tokenStatus(token: Token, now = Date.now()) {
  if (token.revokedAt) return "Revoked";
  if (token.replacedByTokenId && token.overlapEndsAt && Date.parse(token.overlapEndsAt) > now) {
    return "Overlap active";
  }
  if (token.replacedByTokenId) return "Replaced";
  if (token.expiresAt && Date.parse(token.expiresAt) <= now) return "Expired";
  return "Active";
}

export function PersonalTokenSettings() {
  const client = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: api.tokens });
  const [editing, setEditing] = useState<Token | "new">();
  const [rotating, setRotating] = useState<Token>();
  const [revoking, setRevoking] = useState<Token>();
  const [secret, setSecret] = useState<TokenSecret>();
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const nextCutoff = tokens.data?.map((token) =>
      token.overlapEndsAt && Date.parse(token.overlapEndsAt)
    )
      .filter((value): value is number => typeof value === "number" && value > now)
      .sort((a, b) => a - b)[0];
    if (!nextCutoff) return;
    const timer = globalThis.setTimeout(
      () => setNow(Date.now()),
      Math.min(nextCutoff - now + 25, 2_147_483_647),
    );
    return () => globalThis.clearTimeout(timer);
  }, [tokens.data, now]);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["tokens"] });
  };
  return (
    <>
      <p className="ops-announcer" role="status" aria-live="polite">{announcement}</p>
      <div className="title-action token-title">
        <div className="section-title">
          <h2>API tokens</h2>
          <p>Named credentials for the OpenAI-compatible API, with independent limits.</p>
        </div>
        <button className="primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> Create token
        </button>
      </div>
      <div className="api-hint">
        <KeyRound size={20} />
        <div>
          <strong>OpenAI-compatible endpoint</strong>
          <code>{typeof location === "undefined" ? "/v1" : `${location.origin}/v1`}</code>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Copy endpoint"
          onClick={async () => {
            try {
              if (!navigator.clipboard) throw new Error("Clipboard unavailable");
              await navigator.clipboard.writeText(`${globalThis.location?.origin ?? ""}/v1`);
              setAnnouncement("API endpoint copied.");
            } catch {
              setAnnouncement("Could not copy the endpoint. Select and copy it manually.");
            }
          }}
        >
          <Copy size={16} />
        </button>
      </div>
      {tokens.isLoading && <div className="token-state" role="status">Loading API tokens…</div>}
      {tokens.isError && (
        <div className="token-state" role="alert">
          <p>{errorText(tokens.error)}</p>
          <button className="secondary" onClick={() => void tokens.refetch()}>
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}
      {!tokens.isLoading && !tokens.isError && tokens.data?.length === 0 && (
        <div className="token-state">
          <strong>No API tokens yet</strong>
          <p>Create one for scripts or SDK clients.</p>
        </div>
      )}
      <div className="governed-token-list" aria-busy={tokens.isFetching}>
        {tokens.data?.map((token) => (
          <article className="governed-token" key={token.id}>
            <div className="governed-token-head">
              <div>
                <strong>{token.name}</strong>
                <code>{token.preview}</code>
              </div>
              <span className={`status-chip ${token.revokedAt ? "warning" : ""}`}>
                {tokenStatus(token, now)}
              </span>
            </div>
            <div className="scope-list" aria-label={`Scopes for ${token.name}`}>
              {token.scopes.map((scope) => <i key={scope}>{scope}</i>)}
            </div>
            <dl className="token-facts">
              <div>
                <dt>Created</dt>
                <dd>{formatDate(token.createdAt)}</dd>
              </div>
              <div>
                <dt>Rate limit</dt>
                <dd>
                  {token.rpmLimit === null && token.burstLimit === null
                    ? "Installation default"
                    : `${token.rpmLimit ?? "default"}/min · ${token.burstLimit ?? "default"}/sec`}
                </dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{formatDate(token.expiresAt)}</dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>{formatDate(token.lastUsedAt)}</dd>
              </div>
              {token.overlapEndsAt && (
                <div>
                  <dt>Rotation overlap ends</dt>
                  <dd>{formatDate(token.overlapEndsAt)}</dd>
                </div>
              )}
            </dl>
            {!token.revokedAt && (
              <div className="token-actions">
                {!token.replacedByTokenId && (
                  <>
                    <button className="secondary" onClick={() => setEditing(token)}>Edit</button>
                    <button className="secondary" onClick={() => setRotating(token)}>
                      <RotateCcw size={15} /> Rotate
                    </button>
                  </>
                )}
                <button className="danger-button" onClick={() => setRevoking(token)}>
                  <ShieldX size={15} /> Revoke
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {editing && (
        <TokenForm
          token={editing === "new" ? undefined : editing}
          close={() => setEditing(undefined)}
          saved={async (created) => {
            setEditing(undefined);
            if (created) setSecret(created);
            await refresh();
            setAnnouncement(created ? "API token created." : "API token updated.");
          }}
        />
      )}
      {rotating && (
        <RotateTokenDialog
          token={rotating}
          close={() => setRotating(undefined)}
          rotated={async (created) => {
            setRotating(undefined);
            setSecret(created);
            await refresh();
            setAnnouncement("API token rotated. Copy the replacement secret now.");
          }}
        />
      )}
      {revoking && (
        <RevokeTokenDialog
          token={revoking}
          close={() => setRevoking(undefined)}
          revoked={async () => {
            setRevoking(undefined);
            await refresh();
            setAnnouncement("API token revoked.");
          }}
        />
      )}
      {secret && <SecretDialog secret={secret} close={() => setSecret(undefined)} />}
    </>
  );
}

function TokenForm({ token, close, saved }: {
  token?: Token;
  close(): void;
  saved(created?: TokenSecret): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => token ? tokenDraft(token) : emptyDraft());
  const [validation, setValidation] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = parsedDraft(draft);
      if (!parsed.input) throw new TypeError(parsed.error);
      return token
        ? await api.updateToken(token, parsed.input)
        : await api.createToken(parsed.input);
    },
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setValidation("");
    const parsed = parsedDraft(draft);
    if (!parsed.input) return setValidation(parsed.error ?? "Invalid token settings.");
    try {
      const result = await mutation.mutateAsync();
      await saved(token ? undefined : result as TokenSecret);
    } catch (error) {
      if (error instanceof TypeError) setValidation(error.message);
    }
  };
  return (
    <Modal
      title={token ? `Edit ${token.name}` : "Create API token"}
      close={close}
      dismissible={!mutation.isPending}
    >
      <form className="token-form" onSubmit={submit} aria-busy={mutation.isPending}>
        <label className="field">
          <span>Name</span>
          <input
            data-autofocus
            value={draft.name}
            maxLength={80}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <fieldset>
          <legend>Scopes</legend>
          {scopeChoices.map(([value, label]) => (
            <label className="check-row" key={value}>
              <input
                type="checkbox"
                checked={draft.scopes.includes(value)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    scopes: event.target.checked
                      ? [...draft.scopes, value]
                      : draft.scopes.filter((scope) => scope !== value),
                  })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Expires (optional)</span>
          <input
            type="datetime-local"
            value={draft.expiresAt}
            onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })}
          />
        </label>
        <div className="token-limit-grid">
          <label className="field">
            <span>Requests per minute</span>
            <input
              type="number"
              min="1"
              max="60000"
              placeholder="Installation default"
              value={draft.rpmLimit}
              onChange={(e) => setDraft({ ...draft, rpmLimit: e.target.value })}
            />
            <small>Leave blank to inherit the installation limit.</small>
          </label>
          <label className="field">
            <span>Burst per second</span>
            <input
              type="number"
              min="1"
              max="1000"
              placeholder="Installation default"
              value={draft.burstLimit}
              onChange={(e) => setDraft({ ...draft, burstLimit: e.target.value })}
            />
            <small>Leave blank to inherit the installation limit.</small>
          </label>
        </div>
        {(validation || mutation.isError) && (
          <p role="alert" className="form-error">
            {isConflict(mutation.error)
              ? "This token changed in another session. Close and reopen it before saving."
              : validation || errorText(mutation.error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={mutation.isPending} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : token ? "Save changes" : "Create token"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RotateTokenDialog(
  { token, close, rotated }: {
    token: Token;
    close(): void;
    rotated(secret: TokenSecret): Promise<void>;
  },
) {
  const [overlapSeconds, setOverlapSeconds] = useState(300);
  const mutation = useMutation({ mutationFn: () => api.rotateToken(token, overlapSeconds) });
  return (
    <Modal title={`Rotate ${token.name}`} close={close} dismissible={!mutation.isPending}>
      <div className="token-form" aria-busy={mutation.isPending}>
        <p>
          Rotation creates a new secret. Choose how long the current secret should continue working.
        </p>
        <fieldset>
          <legend>Overlap window</legend>
          {[[0, "No overlap"], [300, "5 minutes"], [3600, "1 hour"]].map(([seconds, label]) => (
            <label className="check-row" key={seconds}>
              <input
                type="radio"
                name="overlap"
                checked={overlapSeconds === seconds}
                onChange={() => setOverlapSeconds(Number(seconds))}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {overlapSeconds > 0 && (
          <p className="rotation-warning">
            Both secrets work during the overlap. Revoking either token revokes the entire rotation
            family, including the replacement.
          </p>
        )}
        {mutation.isError && (
          <p className="form-error" role="alert">
            {isConflict(mutation.error)
              ? "This token changed in another session. Refresh the token list before rotating."
              : errorText(mutation.error)}
          </p>
        )}
        <div className="modal-actions">
          <button className="secondary" disabled={mutation.isPending} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={mutation.isPending}
            onClick={async () => {
              try {
                const result = await mutation.mutateAsync();
                await rotated({ ...result.replacement, token: result.token });
              } catch { /* rendered */ }
            }}
          >
            {mutation.isPending ? "Rotating…" : "Rotate token"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RevokeTokenDialog(
  { token, close, revoked }: { token: Token; close(): void; revoked(): Promise<void> },
) {
  const mutation = useMutation({ mutationFn: () => api.revokeToken(token) });
  return (
    <Modal title={`Revoke ${token.name}?`} close={close} dismissible={!mutation.isPending}>
      <div aria-busy={mutation.isPending}>
        <p>
          This immediately rejects the entire rotation family, including old and replacement secrets
          associated with <code>{token.preview}</code>. This cannot be undone.
        </p>
        {mutation.isError && (
          <p className="form-error" role="alert">
            {isConflict(mutation.error)
              ? "This token changed in another session. Refresh before revoking."
              : errorText(mutation.error)}
          </p>
        )}
        <div className="modal-actions">
          <button className="secondary" disabled={mutation.isPending} onClick={close}>
            Cancel
          </button>
          <button
            className="danger-button"
            disabled={mutation.isPending}
            onClick={async () => {
              try {
                await mutation.mutateAsync();
                await revoked();
              } catch { /* rendered */ }
            }}
          >
            {mutation.isPending ? "Revoking…" : "Revoke token"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SecretDialog({ secret, close }: { secret: TokenSecret; close(): void }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const secretRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(secret.token);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
      secretRef.current?.focus();
      secretRef.current?.select();
    }
  };
  return (
    <Modal title="Copy your API token" close={close} dismissible={false}>
      <div className="secret-created">
        <Check size={28} className="success-icon" />
        <p>This secret is shown once. Store it in a password manager before closing.</p>
        <div className="secret">
          <input
            ref={secretRef}
            aria-label="API token secret"
            readOnly
            spellCheck={false}
            value={secret.token}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Copy token"
            onClick={() => void copy()}
          >
            <Copy size={17} />
          </button>
        </div>
        <p role="status" aria-live="polite">
          {copyState === "copied"
            ? "Token copied."
            : copyState === "failed"
            ? "Clipboard access failed. The full token is selected; copy it manually."
            : "Select the token to copy it manually."}
        </p>
        <button className="primary wide" onClick={close}>I’ve stored this token</button>
      </div>
    </Modal>
  );
}

export { parsedDraft as validateTokenDraft };
