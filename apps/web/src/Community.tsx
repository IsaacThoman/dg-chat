import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDollarSign, Menu, RefreshCw, ShieldCheck, Trophy, Users } from "lucide-react";
import { api, ApiError } from "./api.ts";
import type {
  CommunityColorToken,
  CommunityIdentityMode,
  CommunityLeaderboardEntry,
  CommunityLeaderboardMetric,
  CommunityLeaderboardWindow,
  CommunityProfile,
  UpdateCommunityProfileRequest,
} from "./types.ts";
import type { CommunitySearch } from "./communityRouting.ts";

const COLOR_OPTIONS: ReadonlyArray<{ value: CommunityColorToken; label: string }> = [
  { value: "slate", label: "Slate" },
  { value: "blue", label: "Blue" },
  { value: "cyan", label: "Cyan" },
  { value: "emerald", label: "Emerald" },
  { value: "amber", label: "Amber" },
  { value: "orange", label: "Orange" },
  { value: "rose", label: "Rose" },
  { value: "violet", label: "Violet" },
];

const METRICS: ReadonlyArray<{
  value: CommunityLeaderboardMetric;
  label: string;
  description: string;
}> = [
  { value: "calls", label: "Calls", description: "Billable requests" },
  { value: "tokens", label: "Tokens", description: "Input and output tokens" },
  { value: "cost", label: "Cost", description: "Settled model cost" },
  { value: "balance", label: "Balance", description: "Explicitly shared current balances" },
];

const WINDOWS: ReadonlyArray<{ value: CommunityLeaderboardWindow; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const NICKNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_. -]{0,30}[A-Za-z0-9])?$/;

export interface CommunityDraft {
  optedIn: boolean;
  identityMode: CommunityIdentityMode;
  nickname: string;
  color: CommunityColorToken;
  shareBalance: boolean;
}

export type CommunityDirtyField = "participation" | "identity" | "color" | "balance";

export function communityDraft(profile: CommunityProfile): CommunityDraft {
  return {
    optedIn: profile.optedIn,
    identityMode: profile.identityMode,
    nickname: profile.nickname ?? "",
    color: profile.color,
    shareBalance: profile.shareBalance,
  };
}

export function buildCommunityProfilePatch(
  expectedVersion: number,
  draft: CommunityDraft,
  dirtyFields: ReadonlySet<CommunityDirtyField>,
): UpdateCommunityProfileRequest {
  const patch: UpdateCommunityProfileRequest = { expectedVersion };
  if (dirtyFields.has("participation")) {
    patch.optedIn = draft.optedIn;
    if (!draft.optedIn) patch.shareBalance = false;
  }
  if (dirtyFields.has("identity")) {
    patch.identityMode = draft.identityMode;
    patch.nickname = draft.identityMode === "nickname" ? draft.nickname.trim() : null;
  }
  if (dirtyFields.has("color")) patch.color = draft.color;
  if (dirtyFields.has("balance")) {
    patch.shareBalance = draft.optedIn ? draft.shareBalance : false;
  }
  return patch;
}

export interface CommunityDraftRebase {
  draft: CommunityDraft;
  dirtyFields: Set<CommunityDirtyField>;
  conflictFields: CommunityDirtyField[];
  privacyReset: boolean;
}

/**
 * Rebases a local draft onto a newer server profile without resending untouched fields.
 * Remote privacy revocations win until the user explicitly chooses to re-enable disclosure.
 */
export function rebaseCommunityDraft(
  base: CommunityDraft,
  local: CommunityDraft,
  dirtyFields: ReadonlySet<CommunityDirtyField>,
  latest: CommunityDraft,
): CommunityDraftRebase {
  const next = { ...latest };
  const remaining = new Set(dirtyFields);
  const conflicts: CommunityDirtyField[] = [];
  let privacyReset = false;
  const remoteChanged = (field: CommunityDirtyField) => {
    if (field === "participation") return base.optedIn !== latest.optedIn;
    if (field === "identity") {
      return base.identityMode !== latest.identityMode || base.nickname !== latest.nickname;
    }
    if (field === "color") return base.color !== latest.color;
    return base.shareBalance !== latest.shareBalance;
  };
  const localDiffers = (field: CommunityDirtyField) => {
    if (field === "participation") return local.optedIn !== latest.optedIn;
    if (field === "identity") {
      return local.identityMode !== latest.identityMode || local.nickname !== latest.nickname;
    }
    if (field === "color") return local.color !== latest.color;
    return local.shareBalance !== latest.shareBalance;
  };

  for (const field of dirtyFields) {
    if (remoteChanged(field) && localDiffers(field)) conflicts.push(field);
    if (
      (field === "participation" && local.optedIn && !latest.optedIn &&
        remoteChanged("participation")) ||
      (field === "identity" && local.identityMode === "nickname" &&
        latest.identityMode === "anonymous" && remoteChanged("identity")) ||
      (field === "balance" && local.shareBalance && !latest.shareBalance &&
        remoteChanged("balance"))
    ) {
      remaining.delete(field);
      privacyReset = true;
      continue;
    }
    if (field === "participation") next.optedIn = local.optedIn;
    else if (field === "identity") {
      next.identityMode = local.identityMode;
      next.nickname = local.nickname;
    } else if (field === "color") next.color = local.color;
    else next.shareBalance = local.shareBalance;
  }

  if (!next.optedIn) {
    if (next.shareBalance) privacyReset = true;
    next.shareBalance = false;
    remaining.delete("balance");
  }
  if (next.identityMode === "anonymous") next.nickname = "";
  return { draft: next, dirtyFields: remaining, conflictFields: conflicts, privacyReset };
}

export function communityDraftError(draft: CommunityDraft): string {
  if (draft.identityMode !== "nickname") return "";
  const nickname = draft.nickname.trim();
  if (nickname.length < 2 || nickname.length > 32 || !NICKNAME_PATTERN.test(nickname)) {
    return "Use 2–32 letters or numbers. Spaces, underscores, periods, and hyphens are allowed; begin and end with a letter or number.";
  }
  return "";
}

export function formatCommunityValue(
  metric: CommunityLeaderboardMetric,
  value: number,
): string {
  if (metric === "cost" || metric === "balance") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(value / 1_000_000);
  }
  return new Intl.NumberFormat().format(value);
}

function ProfileLoading() {
  return (
    <section className="community-card community-profile-card" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Your community profile</h2>
      <div className="community-loading" role="status">
        <span className="community-skeleton community-skeleton-short" />
        <span className="community-skeleton" />
        <span>Loading privacy settings…</span>
      </div>
    </section>
  );
}

function CommunityProfileSettings({ profile }: { profile: CommunityProfile }) {
  const queryClient = useQueryClient();
  const nicknameId = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(() => communityDraft(profile));
  const [baseDraft, setBaseDraft] = useState(() => communityDraft(profile));
  const [baseVersion, setBaseVersion] = useState(profile.version);
  const [dirtyFields, setDirtyFields] = useState<Set<CommunityDirtyField>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflictMessage, setConflictMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const dirty = dirtyFields.size > 0;

  useEffect(() => {
    if (dirty) return;
    const next = communityDraft(profile);
    setDraft(next);
    setBaseDraft(next);
    setBaseVersion(profile.version);
  }, [dirty, profile]);

  const change = (field: CommunityDirtyField, patch: Partial<CommunityDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (!next.optedIn) next.shareBalance = false;
      return next;
    });
    setDirtyFields((current) => new Set(current).add(field));
    setSaved(false);
    setSaveError("");
  };

  const nicknameError = communityDraftError(draft);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (nicknameError || saving || !dirty) return;
    setSaving(true);
    setSaveError("");
    setConflictMessage("");
    try {
      const updated = await api.updateCommunityProfile(
        buildCommunityProfilePatch(baseVersion, draft, dirtyFields),
      );
      queryClient.setQueryData(["community-profile"], updated);
      const next = communityDraft(updated);
      setDraft(next);
      setBaseDraft(next);
      setBaseVersion(updated.version);
      setDirtyFields(new Set());
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["community-leaderboard"] });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "version_conflict") {
        try {
          const latest = await api.communityProfile();
          queryClient.setQueryData(["community-profile"], latest);
          const latestDraft = communityDraft(latest);
          const rebased = rebaseCommunityDraft(baseDraft, draft, dirtyFields, latestDraft);
          setDraft(rebased.draft);
          setDirtyFields(rebased.dirtyFields);
          setBaseDraft(latestDraft);
          setBaseVersion(latest.version);
          const fields = rebased.conflictFields.map((field) =>
            field === "participation"
              ? "participation"
              : field === "identity"
              ? "display identity"
              : field === "color"
              ? "profile color"
              : "balance sharing"
          );
          setConflictMessage(
            rebased.privacyReset
              ? "A newer privacy choice was applied. Review the current settings before making any disclosure public again."
              : fields.length
              ? `Both sessions changed ${
                fields.join(" and ")
              }. Your local choice is still unsaved; review it before saving again.`
              : "The latest profile was loaded. Your unsaved changes were rebased without overwriting settings changed elsewhere.",
          );
          requestAnimationFrame(() => conflictRef.current?.focus());
        } catch {
          setSaveError(
            "Your profile changed elsewhere, and the latest version could not be loaded. Your draft is still here. Check your connection and try again.",
          );
        }
      } else {
        setSaveError("Your community profile could not be saved. Your draft is still here.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="community-card community-profile-card" aria-labelledby="profile-heading">
      <div className="community-card-heading">
        <span className="community-heading-icon" aria-hidden="true">
          <ShieldCheck size={19} />
        </span>
        <div>
          <h2 id="profile-heading">Your community profile</h2>
          <p>You choose whether you appear and exactly what others can see.</p>
        </div>
      </div>
      {conflictMessage && (
        <div
          ref={conflictRef}
          className="community-notice warning"
          role="alert"
          tabIndex={-1}
        >
          <strong>Profile changed in another session.</strong>
          <span>{conflictMessage}</span>
        </div>
      )}
      {saveError && <div className="community-notice error" role="alert">{saveError}</div>}
      {saved && !dirty && (
        <div className="community-saved" role="status">
          <Check size={15} aria-hidden="true" /> Profile saved
        </div>
      )}
      <form className="community-profile-form" onSubmit={submit} aria-busy={saving || undefined}>
        <label className="community-consent">
          <input
            type="checkbox"
            checked={draft.optedIn}
            disabled={saving}
            onChange={(event) =>
              change("participation", { optedIn: event.target.checked })}
          />
          <span>
            <strong>Join the community leaderboard</strong>
            <small>Your identity stays anonymous unless you select a nickname below.</small>
          </span>
        </label>

        <fieldset className="community-fieldset">
          <legend>Display identity</legend>
          <label className="community-choice">
            <input
              type="radio"
              name="community-identity"
              checked={draft.identityMode === "anonymous"}
              disabled={saving}
              onChange={() =>
                change("identity", { identityMode: "anonymous" })}
            />
            <span>
              <strong>Anonymous</strong>
              <small>Shown only as “Anonymous”</small>
            </span>
          </label>
          <label className="community-choice">
            <input
              type="radio"
              name="community-identity"
              checked={draft.identityMode === "nickname"}
              disabled={saving}
              onChange={() => change("identity", { identityMode: "nickname" })}
            />
            <span>
              <strong>Nickname</strong>
              <small>Show a public nickname you choose</small>
            </span>
          </label>
          <label className="community-nickname" htmlFor={nicknameId}>
            Nickname
            <input
              id={nicknameId}
              value={draft.nickname}
              disabled={saving || draft.identityMode !== "nickname"}
              required={draft.identityMode === "nickname"}
              maxLength={32}
              aria-invalid={nicknameError ? "true" : undefined}
              aria-describedby={`${nicknameId}-help`}
              onChange={(event) => change("identity", { nickname: event.target.value })}
              autoComplete="off"
            />
          </label>
          <small
            id={`${nicknameId}-help`}
            className={nicknameError ? "community-field-error" : "community-field-help"}
          >
            {nicknameError ||
              "2–32 letters or numbers; spaces, underscores, periods, and hyphens are allowed."}
          </small>
        </fieldset>

        <fieldset className="community-fieldset">
          <legend>Profile color</legend>
          <div className="community-colors">
            {COLOR_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="community-color-choice"
                data-community-color={option.value}
                title={option.label}
              >
                <input
                  type="radio"
                  name="community-color"
                  value={option.value}
                  checked={draft.color === option.value}
                  disabled={saving}
                  onChange={() => change("color", { color: option.value })}
                />
                <span aria-hidden="true" />
                <span className="sr-only">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="community-consent community-balance-consent">
          <input
            type="checkbox"
            checked={draft.shareBalance}
            disabled={saving || !draft.optedIn}
            onChange={(event) => change("balance", { shareBalance: event.target.checked })}
          />
          <span>
            <strong>Share my current balance</strong>
            <small>Separate consent. Joining never shares your balance automatically.</small>
          </span>
        </label>

        <div className="community-form-actions">
          <button
            ref={saveRef}
            type="submit"
            className="primary"
            disabled={!dirty || Boolean(nicknameError) || saving}
          >
            {saving
              ? "Saving…"
              : conflictMessage && dirty
              ? "Review and save again"
              : "Save profile"}
          </button>
          {dirty && <span role="status">Unsaved changes</span>}
        </div>
      </form>
    </section>
  );
}

function CommunityEntryRow(
  { entry, metric }: { entry: CommunityLeaderboardEntry; metric: CommunityLeaderboardMetric },
) {
  const name = entry.identityMode === "nickname" && entry.nickname ? entry.nickname : "Anonymous";
  return (
    <tr className="community-ranking-row">
      <td>
        <span className="community-rank" aria-label={`Rank ${entry.position}`}>
          {entry.position}
        </span>
      </td>
      <th scope="row">
        <span className="community-identity">
          <span
            className={`community-avatar${entry.color ? "" : " neutral"}`}
            data-community-color={entry.color ?? undefined}
            aria-hidden="true"
          >
            {entry.identityMode === "nickname" ? name.slice(0, 1).toUpperCase() : "A"}
          </span>
          <span>
            <strong>{name}</strong>
            <small>
              {entry.identityMode === "nickname" ? "Community nickname" : "Private identity"}
            </small>
          </span>
        </span>
      </th>
      <td className="community-value">{formatCommunityValue(metric, entry.value)}</td>
    </tr>
  );
}

export function CommunityLeaderboard({
  initialSearch = { metric: "calls", window: "30d" },
  onSearchChange,
}: {
  initialSearch?: CommunitySearch;
  onSearchChange?: (search: CommunitySearch) => void;
} = {}) {
  const [metric, setMetric] = useState<CommunityLeaderboardMetric>(initialSearch.metric);
  const [window, setWindow] = useState<CommunityLeaderboardWindow>(
    initialSearch.window ?? "30d",
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    setMetric(initialSearch.metric);
    if (initialSearch.window) setWindow(initialSearch.window);
  }, [initialSearch.metric, initialSearch.window]);
  const query = useInfiniteQuery({
    queryKey: ["community-leaderboard", metric, metric === "balance" ? "current" : window],
    queryFn: ({ pageParam }) => api.communityLeaderboard(metric, window, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const entries = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data]);
  const page = query.data?.pages[0];
  const stale = query.isRefetchError && Boolean(query.data);
  const nextPageError = query.isFetchNextPageError;
  const initialError = query.isError && !query.data;
  const selectMetric = (next: CommunityLeaderboardMetric, index: number) => {
    setMetric(next);
    onSearchChange?.(next === "balance" ? { metric: next } : { metric: next, window });
    requestAnimationFrame(() => tabRefs.current[index]?.focus());
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % METRICS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + METRICS.length) % METRICS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = METRICS.length - 1;
    else return;
    event.preventDefault();
    selectMetric(METRICS[next].value, next);
  };

  return (
    <section
      className="community-card community-leaderboard-card"
      aria-labelledby="rankings-heading"
    >
      <div className="community-card-heading community-rankings-heading">
        <span className="community-heading-icon trophy" aria-hidden="true">
          <Trophy size={19} />
        </span>
        <div>
          <h2 id="rankings-heading">Community rankings</h2>
          <p>Opt-in activity from this installation. Private by default.</p>
        </div>
      </div>
      <div className="community-tabs" role="tablist" aria-label="Leaderboard metric">
        {METRICS.map((item, index) => (
          <button
            key={item.value}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`community-tab-${item.value}`}
            aria-selected={metric === item.value}
            aria-controls="community-ranking-panel"
            tabIndex={metric === item.value ? 0 : -1}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            onClick={() => selectMetric(item.value, index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id="community-ranking-panel"
        role="tabpanel"
        aria-labelledby={`community-tab-${metric}`}
        className="community-ranking-panel"
        tabIndex={0}
      >
        <div className="community-ranking-toolbar">
          <div>
            <strong>{METRICS.find((item) => item.value === metric)?.description}</strong>
            {page?.asOf && (
              <small>
                Updated{" "}
                <time dateTime={page.asOf}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(page.asOf))}
                </time>
              </small>
            )}
          </div>
          {metric !== "balance" && (
            <fieldset className="community-window-picker">
              <legend className="sr-only">Ranking period</legend>
              {WINDOWS.map((item) => (
                <label key={item.value}>
                  <input
                    type="radio"
                    name="community-window"
                    checked={window === item.value}
                    onChange={() => {
                      setWindow(item.value);
                      onSearchChange?.({ metric, window: item.value });
                    }}
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          {metric === "balance" && (
            <span className="community-current-label">
              Current snapshot
            </span>
          )}
        </div>
        {stale && (
          <div className="community-notice warning community-stale" role="status">
            <span>Showing saved community data. Refresh failed.</span>
            <button type="button" className="secondary" onClick={() => void query.refetch()}>
              <RefreshCw size={15} aria-hidden="true" /> Retry
            </button>
          </div>
        )}
        {query.isLoading && (
          <div className="community-loading community-rankings-loading" role="status">
            <span className="community-skeleton" />
            <span className="community-skeleton" />
            <span className="community-skeleton" />
            <span>Loading rankings…</span>
          </div>
        )}
        {initialError && (
          <div className="community-state" role="alert">
            <RefreshCw size={24} aria-hidden="true" />
            <strong>Rankings couldn’t be loaded</strong>
            <span>Check your connection and try again.</span>
            <button type="button" className="secondary" onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        )}
        {!query.isLoading && !initialError && entries.length === 0 && (
          <div className="community-state" role="status">
            {metric === "balance"
              ? <CircleDollarSign size={26} aria-hidden="true" />
              : <Users size={26} aria-hidden="true" />}
            <strong>
              {metric === "balance"
                ? "No shared balances yet"
                : "No one has opted in for this view yet"}
            </strong>
            <span>
              {metric === "balance"
                ? "Balances appear only after separate, explicit consent."
                : "Be the first to join from your community profile."}
            </span>
          </div>
        )}
        {entries.length > 0 && (
          <>
            <table className="community-ranking-table">
              <caption className="sr-only">
                Community leaderboard ranked by{" "}
                {METRICS.find((item) => item.value === metric)?.label}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Member</th>
                  <th scope="col">{METRICS.find((item) => item.value === metric)?.label}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <CommunityEntryRow
                    key={`${page?.asOf ?? "page"}-${index}`}
                    entry={entry}
                    metric={metric}
                  />
                ))}
              </tbody>
            </table>
            {query.hasNextPage && (
              <button
                type="button"
                className="secondary community-load-more"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading…" : "Show more"}
              </button>
            )}
            {nextPageError && (
              <div className="community-notice error community-page-error" role="alert">
                <span>More rankings couldn’t be loaded. The rows above are unchanged.</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void query.fetchNextPage()}
                >
                  Retry more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function CommunityView({
  onMenu,
  initialSearch,
  onSearchChange,
}: {
  onMenu: () => void;
  initialSearch?: CommunitySearch;
  onSearchChange?: (search: CommunitySearch) => void;
}) {
  const profile = useQuery({ queryKey: ["community-profile"], queryFn: api.communityProfile });
  const stale = profile.isError && Boolean(profile.data);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <main className="community-main">
      <header className="community-page-header">
        <button
          type="button"
          className="icon-button mobile-only"
          aria-label="Open menu"
          onClick={onMenu}
        >
          <Menu size={20} />
        </button>
        <div>
          <span className="community-eyebrow">
            <Users size={14} aria-hidden="true" /> Community
          </span>
          <h1>See how the community is creating</h1>
          <p>
            Compare opt-in activity across this installation while keeping account identities
            private by default.
          </p>
        </div>
      </header>
      {!online && (
        <div className="community-notice warning community-profile-stale" role="status">
          You’re offline. Saved community data remains visible; changes cannot be saved until your
          connection returns.
        </div>
      )}
      {stale && (
        <div className="community-notice warning community-profile-stale" role="status">
          <span>Showing your saved profile. Refresh failed.</span>
          <button type="button" className="secondary" onClick={() => void profile.refetch()}>
            <RefreshCw size={15} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
      <div className="community-layout">
        {profile.isLoading && <ProfileLoading />}
        {profile.isError && !profile.data && (
          <section className="community-card community-profile-card">
            <div className="community-state" role="alert">
              <RefreshCw size={24} aria-hidden="true" />
              <strong>Your profile couldn’t be loaded</strong>
              <span>Nothing has been changed. Check your connection and try again.</span>
              <button type="button" className="secondary" onClick={() => void profile.refetch()}>
                Retry
              </button>
            </div>
          </section>
        )}
        {profile.data && <CommunityProfileSettings profile={profile.data} />}
        <CommunityLeaderboard
          initialSearch={initialSearch}
          onSearchChange={onSearchChange}
        />
      </div>
    </main>
  );
}
