import type { ReactNode } from "react";
import { type FormEvent, useEffect, useState } from "react";

type AuthStatus = {
  enabled: boolean;
  authenticated: boolean;
  tokenPath?: string | null;
};

type AuthState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "locked"; tokenPath?: string | null; error?: string };

function lockedState(input: { tokenPath?: string | null | undefined; error?: string | undefined }): AuthState {
  return {
    kind: "locked",
    ...(input.tokenPath !== undefined ? { tokenPath: input.tokenPath } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

export function AuthGate(props: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: "loading" });
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.statusText || "auth_status_failed");
        return (await response.json()) as AuthStatus;
      })
      .then((status) => {
        if (cancelled) return;
        setState(
          status.enabled && !status.authenticated ? lockedState({ tokenPath: status.tokenPath }) : { kind: "ready" },
        );
      })
      .catch((error) => {
        if (!cancelled) setState(lockedState({ error: error instanceof Error ? error.message : "auth_status_failed" }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "ready") return <>{props.children}</>;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        setState(lockedState({ tokenPath: state.kind === "locked" ? state.tokenPath : null, error: "Invalid token" }));
        return;
      }
      setState({ kind: "ready" });
    } catch (error) {
      setState(
        lockedState({
          tokenPath: state.kind === "locked" ? state.tokenPath : null,
          error: error instanceof Error ? error.message : "Sign-in failed",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen" aria-busy={state.kind === "loading" || submitting}>
      <form className="auth-panel" onSubmit={onSubmit}>
        <div>
          <p className="auth-kicker">Citadel</p>
          <h1>Sign in</h1>
        </div>
        <label className="auth-field">
          <span>Local token</span>
          <input
            autoComplete="current-password"
            disabled={state.kind === "loading" || submitting}
            onChange={(event) => setToken(event.target.value)}
            type="password"
            value={token}
          />
        </label>
        {state.kind === "locked" && state.tokenPath ? <p className="auth-hint">Token file: {state.tokenPath}</p> : null}
        {state.kind === "locked" && state.error ? <p className="auth-error">{state.error}</p> : null}
        <button className="auth-submit" disabled={!token || state.kind === "loading" || submitting} type="submit">
          {submitting ? "Signing in" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
