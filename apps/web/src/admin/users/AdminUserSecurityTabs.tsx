import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Laptop } from "lucide-react";
import type {
  AdminApiTokenQuery,
  AdminApiTokenSummary,
  AdminSessionQuery,
  AdminSessionSummary,
} from "../../../../../packages/contracts/src/types.ts";
import { api } from "../../api.ts";
import { adminUserKeys } from "./adminUserKeys.ts";
import {
  dateTime,
  DetailState,
  errorMessage,
  isStaleAdminResource,
  Pagination,
  ReasonDialog,
} from "./AdminUserPrimitives.tsx";

const PAGE_SIZE = 25;

export const canRevokeAdminSession = (session: AdminSessionSummary, listStale: boolean) =>
  !listStale && !session.current && session.status === "active";

export const canRevokeAdminToken = (token: AdminApiTokenSummary, listStale: boolean) =>
  !listStale && (token.status === "active" || token.status === "overlap");

export function AdminUserSessionsTab(
  { userId, onReauthenticate, announce }: {
    userId: string;
    onReauthenticate(): void;
    announce(message: string): void;
  },
) {
  const client = useQueryClient();
  const [status, setStatus] = useState<AdminSessionQuery["status"]>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [revoking, setRevoking] = useState<AdminSessionSummary>();
  const [listStale, setListStale] = useState(false);
  const cursor = cursors.at(-1);
  const filters = { status, limit: PAGE_SIZE, cursor } satisfies AdminSessionQuery;
  const sessions = useQuery({
    queryKey: adminUserKeys.sessions(userId, filters),
    queryFn: ({ signal }) => api.adminUserSessions(userId, filters, signal),
  });
  const sessionsStale = listStale || Boolean(sessions.isError && sessions.data);
  useEffect(() => {
    if (sessions.isSuccess && !sessions.isFetching) setListStale(false);
  }, [sessions.dataUpdatedAt, sessions.isFetching, sessions.isSuccess]);
  const refreshSessions = async () => {
    const result = await sessions.refetch();
    setListStale(!result.isSuccess);
    return result;
  };
  const revoke = async (reason: string) => {
    if (!revoking) return;
    try {
      await api.revokeAdminUserSession(userId, revoking.source, revoking.id, reason);
      const [refreshed] = await Promise.all([
        refreshSessions(),
        client.invalidateQueries({ queryKey: adminUserKeys.detail(userId), exact: true }),
      ]);
      announce(
        refreshed.isSuccess
          ? "Session revoked."
          : "Session revoked, but the session list could not be refreshed. Revoke actions remain disabled.",
      );
    } catch (cause) {
      if (isStaleAdminResource(cause)) {
        setRevoking(undefined);
        setListStale(true);
        const refreshed = await refreshSessions();
        announce(
          refreshed.isSuccess
            ? "Session changed elsewhere. Review the refreshed session list."
            : "Session changed elsewhere, but the session list could not be refreshed. Revoke actions remain disabled.",
        );
        return;
      }
      throw cause;
    }
  };
  return (
    <section className="admin-user-tab-stack" aria-labelledby="admin-user-sessions-heading">
      <div className="admin-user-tab-heading">
        <div>
          <h2 id="admin-user-sessions-heading">Signed-in sessions</h2>
          <p>Review browser access without exposing session credentials.</p>
        </div>
        <label>
          <span>Status</span>
          <select
            value={status ?? ""}
            onChange={(event) => {
              setStatus(event.target.value as AdminSessionQuery["status"] || undefined);
              setCursors([]);
            }}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
        </label>
      </div>
      {sessions.isLoading && <DetailState kind="loading" message="Loading sessions…" />}
      {sessions.isError && !sessions.data && (
        <DetailState
          kind="error"
          message={errorMessage(sessions.error, "Sessions are unavailable.")}
          retry={() => void refreshSessions()}
        />
      )}
      {sessions.isError && sessions.data && (
        <p className="admin-user-stale-warning" role="status">
          The latest session refresh failed. Showing the last loaded data with revoke actions
          disabled until a refresh succeeds.{"  "}
          <button type="button" className="text-button" onClick={() => void refreshSessions()}>
            Retry
          </button>
        </p>
      )}
      {!sessions.isLoading && sessions.data?.data.length === 0 && (
        <DetailState kind="empty" message="No sessions match this view." />
      )}
      {!!sessions.data?.data.length && (
        <ul className="admin-user-resource-list" aria-busy={sessions.isFetching}>
          {sessions.data.data.map((session) => (
            <li key={session.id}>
              <span className="admin-user-resource-icon">
                <Laptop size={18} />
              </span>
              <div className="admin-user-resource-main">
                <strong>
                  {session.limited ? "Status session" : "Workspace session"}
                  {session.current ? " · Current administrator session" : ""}
                </strong>
                <span>{session.userAgent || "Unknown browser"}</span>
                <small>
                  {session.source === "better_auth" ? "Browser auth" : "Legacy auth"} ·{" "}
                  {session.ipAddress || "IP unavailable"} · Created {dateTime(session.createdAt)}
                  {" "}
                  · Expires {dateTime(session.expiresAt)}
                </small>
              </div>
              <span className={`status-chip${session.status !== "active" ? " warning" : ""}`}>
                {session.status}
              </span>
              <button
                type="button"
                className="danger-button"
                disabled={!canRevokeAdminSession(session, sessionsStale)}
                aria-describedby={session.current ? `current-session-${session.id}` : undefined}
                onClick={() => setRevoking(session)}
              >
                Revoke
              </button>
              {session.current && (
                <small id={`current-session-${session.id}`} className="admin-user-resource-note">
                  Your current administrator session is protected.
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
      {sessions.data && (cursors.length > 0 || sessions.data.nextCursor) && (
        <Pagination
          page={cursors.length + 1}
          fetching={sessions.isFetching}
          hasNext={Boolean(sessions.data.nextCursor)}
          previous={() => setCursors((value) => value.slice(0, -1))}
          next={() =>
            sessions.data?.nextCursor &&
            setCursors((value) => [...value, sessions.data!.nextCursor!])}
        />
      )}
      {revoking && (
        <ReasonDialog
          title="Revoke session?"
          consequence="This browser session will immediately lose access. The user can sign in again if the account remains active."
          confirmLabel="Revoke session"
          close={() => setRevoking(undefined)}
          submit={revoke}
          onReauthenticate={onReauthenticate}
        />
      )}
    </section>
  );
}

function tokenStatusClass(token: AdminApiTokenSummary) {
  return token.status === "active" || token.status === "overlap" ? "" : " warning";
}

export function AdminUserTokensTab(
  { userId, onReauthenticate, announce }: {
    userId: string;
    onReauthenticate(): void;
    announce(message: string): void;
  },
) {
  const client = useQueryClient();
  const [status, setStatus] = useState<AdminApiTokenQuery["status"]>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [revoking, setRevoking] = useState<AdminApiTokenSummary>();
  const [listStale, setListStale] = useState(false);
  const cursor = cursors.at(-1);
  const filters = { status, limit: PAGE_SIZE, cursor } satisfies AdminApiTokenQuery;
  const tokens = useQuery({
    queryKey: adminUserKeys.tokens(userId, filters),
    queryFn: ({ signal }) => api.adminUserApiTokens(userId, filters, signal),
  });
  const tokensStale = listStale || Boolean(tokens.isError && tokens.data);
  useEffect(() => {
    if (tokens.isSuccess && !tokens.isFetching) setListStale(false);
  }, [tokens.dataUpdatedAt, tokens.isFetching, tokens.isSuccess]);
  const refreshTokens = async () => {
    const result = await tokens.refetch();
    setListStale(!result.isSuccess);
    return result;
  };
  const revoke = async (reason: string) => {
    if (!revoking) return;
    try {
      await api.revokeAdminUserApiToken(userId, revoking.id, revoking.version, reason);
      const [refreshed] = await Promise.all([
        refreshTokens(),
        client.invalidateQueries({ queryKey: adminUserKeys.detail(userId), exact: true }),
      ]);
      announce(
        refreshed.isSuccess
          ? "API token family revoked."
          : "API token family revoked, but the token list could not be refreshed. Revoke actions remain disabled.",
      );
    } catch (cause) {
      if (isStaleAdminResource(cause)) {
        setRevoking(undefined);
        setListStale(true);
        const refreshed = await refreshTokens();
        announce(
          refreshed.isSuccess
            ? "API token family changed elsewhere. Review the refreshed token list."
            : "API token family changed elsewhere, but the token list could not be refreshed. Revoke actions remain disabled.",
        );
        return;
      }
      throw cause;
    }
  };
  return (
    <section className="admin-user-tab-stack" aria-labelledby="admin-user-tokens-heading">
      <div className="admin-user-tab-heading">
        <div>
          <h2 id="admin-user-tokens-heading">API tokens</h2>
          <p>Inspect non-secret token metadata and revoke a complete rotation family.</p>
        </div>
        <label>
          <span>Status</span>
          <select
            value={status ?? ""}
            onChange={(event) => {
              setStatus(event.target.value as AdminApiTokenQuery["status"] || undefined);
              setCursors([]);
            }}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="overlap">Overlap</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
            <option value="replaced">Replaced</option>
          </select>
        </label>
      </div>
      {tokens.isLoading && <DetailState kind="loading" message="Loading API tokens…" />}
      {tokens.isError && !tokens.data && (
        <DetailState
          kind="error"
          message={errorMessage(tokens.error, "API tokens are unavailable.")}
          retry={() => void refreshTokens()}
        />
      )}
      {tokens.isError && tokens.data && (
        <p className="admin-user-stale-warning" role="status">
          The latest token refresh failed. Showing the last loaded data with revoke actions disabled
          until a refresh succeeds.{"  "}
          <button type="button" className="text-button" onClick={() => void refreshTokens()}>
            Retry
          </button>
        </p>
      )}
      {!tokens.isLoading && tokens.data?.data.length === 0 && (
        <DetailState kind="empty" message="This user has no API tokens in this view." />
      )}
      {!!tokens.data?.data.length && (
        <div className="admin-user-token-list" aria-busy={tokens.isFetching}>
          {tokens.data.data.map((token) => (
            <article key={token.id} className="admin-user-token-card">
              <header>
                <span className="admin-user-resource-icon">
                  <KeyRound size={18} />
                </span>
                <div>
                  <strong>{token.name}</strong>
                  <code>{token.preview}</code>
                </div>
                <span className={`status-chip${tokenStatusClass(token)}`}>{token.status}</span>
              </header>
              <div className="scope-list" aria-label={`Scopes for ${token.name}`}>
                {token.scopes.map((scope) => <i key={scope}>{scope}</i>)}
              </div>
              <dl className="admin-user-resource-facts">
                <div>
                  <dt>Created</dt>
                  <dd>{dateTime(token.createdAt)}</dd>
                </div>
                <div>
                  <dt>Last used</dt>
                  <dd>{dateTime(token.lastUsedAt)}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{dateTime(token.expiresAt)}</dd>
                </div>
                <div>
                  <dt>Rate limit</dt>
                  <dd>{token.rpmLimit ?? "default"}/min · {token.burstLimit ?? "default"}/sec</dd>
                </div>
                <div>
                  <dt>Rotation</dt>
                  <dd>
                    Generation {token.rotationGeneration}
                    {token.overlapEndsAt ? ` · overlap until ${dateTime(token.overlapEndsAt)}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Access</dt>
                  <dd>
                    {token.accessMode}
                    {token.groupIds.length ? ` · ${token.groupIds.length} groups` : ""}
                  </dd>
                </div>
              </dl>
              {(token.status === "active" || token.status === "overlap") && (
                <div className="admin-user-token-actions">
                  <button
                    type="button"
                    className="danger-button"
                    disabled={!canRevokeAdminToken(token, tokensStale)}
                    onClick={() =>
                      setRevoking(token)}
                  >
                    Revoke token family
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {tokens.data && (cursors.length > 0 || tokens.data.nextCursor) && (
        <Pagination
          page={cursors.length + 1}
          fetching={tokens.isFetching}
          hasNext={Boolean(tokens.data.nextCursor)}
          previous={() => setCursors((value) => value.slice(0, -1))}
          next={() =>
            tokens.data?.nextCursor && setCursors((value) => [...value, tokens.data!.nextCursor!])}
        />
      )}
      {revoking && (
        <ReasonDialog
          title={`Revoke ${revoking.name}?`}
          consequence="Every token in this rotation family, including an active overlap credential, will immediately stop authorizing API requests."
          confirmLabel="Revoke token family"
          close={() => setRevoking(undefined)}
          submit={revoke}
          onReauthenticate={onReauthenticate}
        />
      )}
    </section>
  );
}
