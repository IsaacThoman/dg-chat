import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { api, ApiError } from "./api.ts";
import type { UserSession } from "./types.ts";

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function SessionCenter() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const [revoking, setRevoking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const revoke = async (id: string) => {
    setRevoking(id);
    setError("");
    setNotice("");
    try {
      await api.revokeSession(id);
      queryClient.setQueryData<UserSession[]>(
        ["sessions"],
        (current) => current?.filter((session) => session.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: ["sessions"] }).catch(() => {
        setNotice("The session was revoked, but the refreshed list is temporarily unavailable.");
      });
      try {
        await api.me();
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          location.assign("/login");
        } else {
          setNotice("The session was revoked. Your current sign-in could not be rechecked.");
        }
      }
    } catch {
      setError("That session could not be revoked. Refresh the list and try again.");
    } finally {
      setRevoking("");
    }
  };
  return (
    <section className="session-center" aria-labelledby="session-center-title">
      <div className="session-center-head">
        <span className="portability-icon">
          <ShieldCheck size={18} aria-hidden="true" />
        </span>
        <span>
          <h3 id="session-center-title">Signed-in sessions</h3>
          <p>Review and revoke browser sessions associated with your account.</p>
        </span>
        <button
          className="secondary push"
          type="button"
          disabled={sessions.isFetching}
          onClick={() => void sessions.refetch()}
        >
          <RefreshCw className={sessions.isFetching ? "spin" : ""} size={15} /> Refresh
        </button>
      </div>
      {sessions.isLoading && <p className="session-empty" role="status">Loading sessions…</p>}
      {sessions.isError && (
        <p className="inline-error" role="alert">Sessions are temporarily unavailable.</p>
      )}
      {!sessions.isLoading && !sessions.isError && sessions.data?.length === 0 && (
        <p className="session-empty">No active sessions were returned.</p>
      )}
      {sessions.data && sessions.data.length > 0 && (
        <ul className="session-list">
          {sessions.data.map((session) => (
            <li key={session.id}>
              <span className="session-icon">
                <Clock3 size={17} aria-hidden="true" />
              </span>
              <span>
                <strong>
                  {session.limited ? "Status session" : "Workspace session"}
                  {session.current ? " · This device" : ""}
                </strong>
                <small>
                  Created {dateTime(session.createdAt)} · Expires {dateTime(session.expiresAt)}
                </small>
              </span>
              <button
                className="secondary push"
                type="button"
                disabled={Boolean(revoking)}
                aria-label={`${session.current ? "Sign out" : "Revoke"} ${
                  session.limited ? "status" : "workspace"
                } session created ${dateTime(session.createdAt)}`}
                onClick={() => void revoke(session.id)}
              >
                <LogOut size={15} />{" "}
                {revoking === session.id ? "Revoking…" : session.current ? "Sign out" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="session-notice" role="status">{notice}</p>}
    </section>
  );
}
