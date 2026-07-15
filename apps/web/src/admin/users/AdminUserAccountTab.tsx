import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Trash2, UserCheck } from "lucide-react";
import type { AdminUser } from "../../../../../packages/contracts/src/types.ts";
import { api, ApiError } from "../../api.ts";
import {
  type AdminLifecycleAction,
  adminLifecycleConsequence,
  adminLifecycleErrorMessage,
} from "../../adminLifecycleUi.ts";
import { adminUserKeys } from "./adminUserKeys.ts";
import { dateTime, isConflict, ReasonDialog } from "./AdminUserPrimitives.tsx";
export function AdminUserAccountTab(
  { user, refresh, onReauthenticate, announce }: {
    user: AdminUser;
    refresh(): Promise<unknown>;
    onReauthenticate(): void;
    announce(message: string): void;
  },
) {
  const client = useQueryClient();
  const [action, setAction] = useState<AdminLifecycleAction>();
  const run = async (reason: string) => {
    try {
      if (action === "promote" || action === "demote") {
        await api.setUserRole(
          user.id,
          action === "promote" ? "admin" : "user",
          user.version,
          reason,
        );
      } else if (action === "suspend" || action === "activate") {
        await api.setUserState(
          user.id,
          action === "suspend" ? "suspended" : "active",
          user.version,
          reason,
        );
      } else if (action === "delete") {
        await api.deleteUser(user.id, user.version, reason);
      } else if (action === "restore") {
        await api.restoreUser(user.id, user.version, reason);
      }
      await refresh();
      await client.invalidateQueries({ queryKey: adminUserKeys.directories() });
      announce(`Account ${action} completed.`);
    } catch (cause) {
      if (isConflict(cause)) await refresh();
      if (cause instanceof ApiError && cause.code !== "version_conflict") {
        throw new ApiError(
          cause.status,
          cause.code,
          adminLifecycleErrorMessage(cause.code, cause.message),
        );
      }
      throw cause;
    }
  };
  const actionTitle = action ? `${action[0].toUpperCase()}${action.slice(1)} ${user.name}?` : "";
  return (
    <div className="admin-user-account-grid">
      <section className="admin-user-card" aria-labelledby="admin-user-identity-title">
        <div className="admin-user-card-heading">
          <div>
            <h2 id="admin-user-identity-title">Account</h2>
            <p>Identity, authority, and workspace access.</p>
          </div>
          <UserCheck size={20} aria-hidden="true" />
        </div>
        <dl className="admin-user-facts">
          <div>
            <dt>Display name</dt>
            <dd>{user.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{dateTime(user.createdAt)}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{dateTime(user.updatedAt)}</dd>
          </div>
          <div>
            <dt>Lifecycle version</dt>
            <dd>{user.version}</dd>
          </div>
          <div>
            <dt>Current authority</dt>
            <dd>{user.effectiveAdmin ? "Administrator" : "Standard user"}</dd>
          </div>
        </dl>
      </section>
      <section className="admin-user-card" aria-labelledby="admin-user-access-title">
        <div className="admin-user-card-heading">
          <div>
            <h2 id="admin-user-access-title">Access controls</h2>
            <p>Every change requires a reason and creates an audit event.</p>
          </div>
          <ShieldCheck size={20} aria-hidden="true" />
        </div>
        <div className="admin-user-detail-actions">
          {!user.deletedAt && (
            <button
              type="button"
              className="secondary"
              disabled={user.role !== "admin" &&
                (user.approvalStatus !== "approved" || user.state !== "active")}
              onClick={() => setAction(user.role === "admin" ? "demote" : "promote")}
            >
              <ShieldCheck size={15} />{" "}
              {user.role === "admin" ? "Demote to user" : "Promote to admin"}
            </button>
          )}
          {!user.deletedAt && (
            <button
              type="button"
              className={user.state === "suspended" ? "secondary" : "danger-button"}
              onClick={() => setAction(user.state === "suspended" ? "activate" : "suspend")}
            >
              <UserCheck size={15} />{" "}
              {user.state === "suspended" ? "Reactivate account" : "Suspend account"}
            </button>
          )}
          <button
            type="button"
            className={user.deletedAt ? "secondary" : "danger-button"}
            onClick={() => setAction(user.deletedAt ? "restore" : "delete")}
          >
            <Trash2 size={15} /> {user.deletedAt ? "Restore account" : "Delete account"}
          </button>
        </div>
        {user.role !== "admin" &&
          (user.approvalStatus !== "approved" || user.state !== "active") && (
          <p className="admin-user-inline-note">
            Approve and activate this account before granting administrator authority.
          </p>
        )}
      </section>
      {action && (
        <ReasonDialog
          title={actionTitle}
          consequence={adminLifecycleConsequence(action)}
          confirmLabel={`Confirm ${action}`}
          danger={["demote", "suspend", "delete"].includes(action)}
          close={() => setAction(undefined)}
          submit={run}
          onReauthenticate={onReauthenticate}
        />
      )}
    </div>
  );
}
