import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CircleDollarSign,
  Clock3,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  UserCheck,
} from "lucide-react";
import type { AdminUser } from "../../../../../packages/contracts/src/types.ts";
import { api, ApiError } from "../../api.ts";
import { AdminUserAccountTab } from "./AdminUserAccountTab.tsx";
import { AdminUserBillingTab } from "./AdminUserBillingTab.tsx";
import { dateTime, DetailState, errorMessage } from "./AdminUserPrimitives.tsx";
import { AdminUserSessionsTab, AdminUserTokensTab } from "./AdminUserSecurityTabs.tsx";
import { adminUserKeys } from "./adminUserKeys.ts";
import {
  type AdminUserTab,
  adminUserTabForKey,
  adminUserTabId,
  adminUserTabLabels,
  adminUserTabPanelId,
  adminUserTabs,
} from "./adminUserRouting.ts";
import { formatUsdMicros } from "./money.ts";
import "./adminUserDetail.css";

const initials = (name: string) =>
  name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

export interface AdminUserDetailProps {
  userId: string;
  tab: AdminUserTab;
  onTabChange(tab: AdminUserTab): void;
  onBack(): void;
  onReauthenticate(): void;
}

function StatusChips({ user }: { user: AdminUser }) {
  return (
    <div className="admin-user-detail-chips" aria-label="Account status">
      <span className="status-chip">{user.approvalStatus}</span>
      <span className={`status-chip${user.state === "suspended" ? " warning" : ""}`}>
        {user.state}
      </span>
      <span className="status-chip">{user.role}</span>
      <span className={`status-chip${user.emailVerifiedAt ? "" : " warning"}`}>
        {user.emailVerifiedAt ? "email verified" : "email unverified"}
      </span>
      {user.deletedAt && <span className="status-chip warning">deleted</span>}
      {user.effectiveAdmin && <span className="status-chip">effective admin</span>}
    </div>
  );
}

export function AdminUserDetail(
  { userId, tab, onTabChange, onBack, onReauthenticate }: AdminUserDetailProps,
) {
  const [announcement, setAnnouncement] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const user = useQuery({
    queryKey: adminUserKeys.detail(userId),
    queryFn: ({ signal }) => api.adminUserDetail(userId, signal),
  });
  useEffect(() => {
    if (user.data) document.title = `${user.data.name} · Users · DG Chat Admin`;
  }, [user.data]);
  useEffect(() => {
    if (user.data) headingRef.current?.focus();
  }, [userId]);
  const changeTab = (next: AdminUserTab, focus = false) => {
    onTabChange(next);
    if (focus) {
      requestAnimationFrame(() => document.getElementById(adminUserTabId(userId, next))?.focus());
    }
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = adminUserTabForKey(tab, event.key, document.dir === "rtl" ? "rtl" : "ltr");
    if (!next) return;
    event.preventDefault();
    changeTab(next, true);
  };
  if (user.isLoading) {
    return <DetailState kind="loading" message="Loading user security and billing…" />;
  }
  if (!user.data) {
    const notFound = user.error instanceof ApiError && user.error.status === 404;
    const forbidden = user.error instanceof ApiError && user.error.status === 403;
    return (
      <div className="admin-user-detail-fatal">
        <ShieldAlert size={28} />
        <h1>
          {notFound
            ? "User not found"
            : forbidden
            ? "Administrator access changed"
            : "User details unavailable"}
        </h1>
        <p>
          {notFound
            ? "This account no longer exists or is unavailable to administrators."
            : forbidden
            ? "Your account no longer has authority to inspect user security and billing data."
            : errorMessage(user.error, "The user could not be loaded.")}
        </p>
        <div>
          <button
            type="button"
            className="secondary"
            onClick={forbidden ? () => location.assign("/") : onBack}
          >
            <ArrowLeft size={15} /> {forbidden ? "Return to workspace" : "Back to users"}
          </button>
          {!notFound && !forbidden && (
            <button
              type="button"
              className="primary"
              onClick={() => void user.refetch()}
            >
              <RefreshCw size={15} /> Retry
            </button>
          )}
        </div>
      </div>
    );
  }
  const data = user.data;
  return (
    <div className="admin-user-detail-page">
      <p className="ops-announcer" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <button type="button" className="admin-user-back" onClick={onBack}>
        <ArrowLeft size={15} /> Back to users
      </button>
      <header className="admin-user-detail-header">
        <span className="admin-user-detail-avatar" aria-hidden="true">{initials(data.name)}</span>
        <div>
          <h1 ref={headingRef} tabIndex={-1}>{data.name}</h1>
          <p>{data.email}</p>
          <StatusChips user={data} />
        </div>
        <div className="admin-user-detail-balance">
          <small>Available balance</small>
          <strong>{formatUsdMicros(data.balanceMicros)}</strong>
          <span>Updated {dateTime(data.updatedAt)}</span>
        </div>
      </header>
      {user.isFetching && (
        <p className="admin-user-refreshing" role="status">
          <RefreshCw className="spin" size={13} /> Refreshing account…
        </p>
      )}
      {user.isError && (
        <p className="admin-user-stale-warning" role="status">
          The latest account refresh failed. Showing the last loaded details.{"  "}
          <button type="button" className="text-button" onClick={() => void user.refetch()}>
            Retry
          </button>
        </p>
      )}
      <div className="admin-user-tabs" role="tablist" aria-label="User administration">
        {adminUserTabs.map((item) => (
          <button
            key={item}
            id={adminUserTabId(userId, item)}
            role="tab"
            type="button"
            aria-selected={tab === item}
            aria-controls={adminUserTabPanelId(userId, item)}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => changeTab(item)}
            onKeyDown={tabKey}
          >
            {item === "account"
              ? <UserCheck size={16} />
              : item === "sessions"
              ? <Clock3 size={16} />
              : item === "tokens"
              ? <KeyRound size={16} />
              : <CircleDollarSign size={16} />}
            {adminUserTabLabels[item]}
          </button>
        ))}
      </div>
      <div
        id={adminUserTabPanelId(userId, tab)}
        role="tabpanel"
        aria-labelledby={adminUserTabId(userId, tab)}
        tabIndex={0}
        className="admin-user-tab-panel"
      >
        {tab === "account" && (
          <AdminUserAccountTab
            user={data}
            refresh={user.refetch}
            onReauthenticate={onReauthenticate}
            announce={setAnnouncement}
          />
        )}
        {tab === "sessions" && (
          <AdminUserSessionsTab
            userId={userId}
            onReauthenticate={onReauthenticate}
            announce={setAnnouncement}
          />
        )}
        {tab === "tokens" && (
          <AdminUserTokensTab
            userId={userId}
            onReauthenticate={onReauthenticate}
            announce={setAnnouncement}
          />
        )}
        {tab === "billing" && (
          <AdminUserBillingTab
            user={data}
            refresh={user.refetch}
            onReauthenticate={onReauthenticate}
            announce={setAnnouncement}
          />
        )}
      </div>
    </div>
  );
}
