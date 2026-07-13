import { type FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, KeyRound, MailCheck, RefreshCw } from "lucide-react";
import { api, ApiError } from "./api.ts";
import { AuthCard } from "./App.tsx";
import { identityTokenFromUrl, recoveryPasswordError } from "./identityState.ts";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../../../packages/contracts/src/password-policy.ts";

function scrubIdentityToken(): void {
  const url = new URL(location.href);
  if (
    url.searchParams.has("token") || new URLSearchParams(url.hash.replace(/^#/, "")).has("token")
  ) {
    url.searchParams.delete("token");
    url.hash = "";
    history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  }
}

function useIdentityToken(): string {
  const [token, setToken] = useState(() => identityTokenFromUrl(location.href));
  useEffect(() => {
    // Mutating history inside a navigation event can abort observers or make the router remount
    // after the token disappeared. Defer the scrub one task so every listener sees the complete
    // emailed URL while retaining the token captured during render/the navigation event.
    const scheduleScrub = () => globalThis.setTimeout(scrubIdentityToken, 0);
    const refresh = () => {
      setToken(identityTokenFromUrl(location.href));
      scheduleScrub();
    };

    if (document.readyState === "complete") {
      scheduleScrub();
    } else {
      globalThis.addEventListener("load", scheduleScrub, { once: true });
    }
    globalThis.addEventListener("hashchange", refresh);
    globalThis.addEventListener("popstate", refresh);
    return () => {
      globalThis.removeEventListener("load", scheduleScrub);
      globalThis.removeEventListener("hashchange", refresh);
      globalThis.removeEventListener("popstate", refresh);
    };
  }, []);
  return token;
}

function RecoveryLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="recovery-link" href={href}>
      <ArrowLeft size={15} aria-hidden="true" /> {children}
    </a>
  );
}

export function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.requestPasswordReset(email);
      setSent(true);
    } catch {
      setError("We couldn't send recovery instructions right now. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your account email and we’ll send recovery instructions if it matches an account."
    >
      {sent
        ? (
          <div className="recovery-status" role="status">
            <MailCheck size={28} aria-hidden="true" />
            <strong>Check your inbox</strong>
            <p>
              If an account exists for that address, its password-reset link is on the way. The link
              expires after one hour.
            </p>
          </div>
        )
        : (
          <form className="auth-form" onSubmit={submit}>
            <label>
              <span>Email address</span>
              <input
                required
                autoComplete="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
              />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary wide" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send recovery link"}
              {busy ? <RefreshCw className="spin" size={16} /> : <ArrowRight size={16} />}
            </button>
          </form>
        )}
      <RecoveryLink href="/login">Back to sign in</RecoveryLink>
    </AuthCard>
  );
}

export function ResetPasswordScreen() {
  const token = useIdentityToken();
  const activeToken = useRef(token);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [serverError, setServerError] = useState("");
  const touched = Boolean(password || confirmation);
  const validation = touched ? recoveryPasswordError(password, confirmation) : null;
  useEffect(() => {
    if (activeToken.current === token) return;
    activeToken.current = token;
    setPassword("");
    setConfirmation("");
    setBusy(false);
    setComplete(false);
    setServerError("");
  }, [token]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = recoveryPasswordError(password, confirmation);
    if (invalid) return;
    setBusy(true);
    setServerError("");
    const submittedToken = token;
    try {
      await api.resetPassword(submittedToken, password);
      if (activeToken.current !== submittedToken) return;
      setComplete(true);
    } catch (caught) {
      if (activeToken.current !== submittedToken) return;
      setServerError(
        caught instanceof ApiError && caught.code === "invalid_identity_token"
          ? "This recovery link is invalid, expired, or has already been used. Request a new link."
          : "Your password could not be reset. Request a new link and try again.",
      );
    } finally {
      if (activeToken.current === submittedToken) setBusy(false);
    }
  };
  if (!token) {
    return (
      <AuthCard title="Recovery link required" subtitle="This password-reset link is incomplete.">
        <div className="recovery-status error" role="alert">
          <KeyRound size={28} aria-hidden="true" />
          <strong>Request a fresh link</strong>
          <p>Open the complete link from your email, or request new recovery instructions.</p>
        </div>
        <RecoveryLink href="/forgot-password">Request a new link</RecoveryLink>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title={complete ? "Password updated" : "Choose a new password"}
      subtitle={complete
        ? "Your existing sessions and API tokens were revoked for safety."
        : `Use ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`}
    >
      {complete
        ? (
          <div className="recovery-status" role="status">
            <CheckCircle2 size={28} aria-hidden="true" />
            <strong>Your password is ready</strong>
            <p>Sign in again on each device with your new password.</p>
          </div>
        )
        : (
          <form className="auth-form" onSubmit={submit}>
            <label>
              <span>New password</span>
              <input
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                type="password"
                aria-describedby={serverError
                  ? "reset-password-guidance reset-password-error"
                  : "reset-password-guidance"}
                aria-invalid={Boolean(validation)}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setServerError("");
                }}
              />
            </label>
            <label>
              <span>Confirm new password</span>
              <input
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                type="password"
                aria-describedby={serverError
                  ? "reset-password-guidance reset-password-error"
                  : "reset-password-guidance"}
                aria-invalid={Boolean(validation)}
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setServerError("");
                }}
              />
            </label>
            <p
              id="reset-password-guidance"
              className={`password-guidance${validation ? " invalid" : ""}`}
              aria-live="polite"
            >
              {!touched
                ? `Use ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`
                : validation ?? "Password requirements satisfied."}
            </p>
            {serverError && (
              <p id="reset-password-error" className="form-error" role="alert">{serverError}</p>
            )}
            <button className="primary wide" type="submit" disabled={busy || Boolean(validation)}>
              {busy ? "Updating…" : "Update password"}
              {busy ? <RefreshCw className="spin" size={16} /> : <ArrowRight size={16} />}
            </button>
          </form>
        )}
      <RecoveryLink href={complete ? "/login" : "/forgot-password"}>
        {complete ? "Continue to sign in" : "Request a different link"}
      </RecoveryLink>
    </AuthCard>
  );
}

export function VerifyEmailScreen() {
  const token = useIdentityToken();
  const attempted = useRef("");
  const [state, setState] = useState<"working" | "complete" | "error">(
    token ? "working" : "error",
  );
  useEffect(() => {
    if (!token) {
      attempted.current = "";
      setState("error");
      return;
    }
    if (attempted.current === token) return;
    attempted.current = token;
    setState("working");
    const submittedToken = token;
    void api.verifyEmail(token).then(
      () => {
        if (attempted.current === submittedToken) setState("complete");
      },
      () => {
        if (attempted.current === submittedToken) setState("error");
      },
    );
  }, [token]);
  return (
    <AuthCard
      title={state === "complete"
        ? "Email verified"
        : state === "working"
        ? "Verifying your email"
        : "Verification link unavailable"}
      subtitle={state === "complete"
        ? "Your account has one less step remaining."
        : "Email verification links are single-use and expire after 24 hours."}
    >
      <div
        className={`recovery-status${state === "error" ? " error" : ""}`}
        role={state === "error" ? "alert" : "status"}
      >
        {state === "working"
          ? <RefreshCw className="spin" size={28} aria-hidden="true" />
          : state === "complete"
          ? <MailCheck size={28} aria-hidden="true" />
          : <KeyRound size={28} aria-hidden="true" />}
        <strong>
          {state === "working"
            ? "Checking your link…"
            : state === "complete"
            ? "Verification complete"
            : "Request a fresh verification email"}
        </strong>
        <p>
          {state === "working"
            ? "This should only take a moment."
            : state === "complete"
            ? "Return to your account status page. You may need to sign in again for full access."
            : "This link is missing, invalid, expired, or has already been used."}
        </p>
      </div>
      <RecoveryLink href={state === "complete" ? "/pending" : "/login"}>
        {state === "complete" ? "Continue to account status" : "Return to sign in"}
      </RecoveryLink>
    </AuthCard>
  );
}
