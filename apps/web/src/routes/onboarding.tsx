import type { ProviderHealth } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Folder, ShieldCheck, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "../api.js";
import { useStateQuery } from "../app-state.js";
import { Button } from "../components/ui/button.js";

type Step = "providers" | "repo" | "workspace" | "done";

type RepoInspectResult = {
  rootPath: string;
  exists: boolean;
  isGit: boolean;
  defaultBranch: string | null;
  remotes: string[];
  suggestedWorktreeParent: string;
  providerCandidates: Array<{ id: string; displayName: string; enabled: boolean }>;
};

export function OnboardingView() {
  const state = useStateQuery();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("providers");
  const [registeredRepoId, setRegisteredRepoId] = useState("");

  useEffect(() => {
    if (state.data?.repos.length && step === "providers") setStep("repo");
  }, [state.data?.repos.length, step]);

  if (state.isLoading) return <div className="empty">Loading local state…</div>;
  return (
    <div className="page onboarding-page">
      <header className="header">
        <div>
          <h1>Welcome to Citadel</h1>
          <p>Let’s get you to a workspace.</p>
        </div>
        <Link className="settings-link" to="/">
          Skip
        </Link>
      </header>
      <ol className="onboarding-steps">
        <StepHeader index={1} title="Verify providers" active={step === "providers"} done={step !== "providers"} />
        <StepHeader
          index={2}
          title="Register a repo"
          active={step === "repo"}
          done={step === "workspace" || step === "done"}
        />
        <StepHeader index={3} title="Create a workspace" active={step === "workspace"} done={step === "done"} />
      </ol>
      {step === "providers" ? (
        <ProvidersStep providerHealth={state.data?.providerHealth ?? []} onNext={() => setStep("repo")} />
      ) : null}
      {step === "repo" ? (
        <RepoStep
          onDone={(repoId) => {
            setRegisteredRepoId(repoId);
            setStep("workspace");
          }}
        />
      ) : null}
      {step === "workspace" ? (
        <WorkspaceStep
          repoId={registeredRepoId || (state.data?.repos[0]?.id ?? "")}
          onDone={() => {
            setStep("done");
            void navigate({ to: "/" });
          }}
        />
      ) : null}
      {step === "done" ? <div className="empty">All set. Redirecting…</div> : null}
    </div>
  );
}

function StepHeader(props: { index: number; title: string; active: boolean; done: boolean }) {
  return (
    <li className={`onboarding-step ${props.active ? "active" : ""} ${props.done ? "done" : ""}`}>
      <span className="step-index">{props.done ? <CheckCircle2 size={14} /> : props.index}</span>
      <span>{props.title}</span>
    </li>
  );
}

function ProvidersStep(props: { providerHealth: ProviderHealth[]; onNext: () => void }) {
  return (
    <section className="onboarding-card">
      <div className="onboarding-card-title">
        <ShieldCheck size={16} />
        <h2>Providers</h2>
      </div>
      <p>
        Citadel uses local CLIs as the first production baseline. Your provider health is checked below. You can skip
        and configure them later in Settings, or open Settings now to point Citadel at your local <code>gh</code> /{" "}
        <code>jtk</code> binaries.
      </p>
      <ul className="onboarding-provider-list">
        {props.providerHealth.map((provider) => (
          <li key={provider.id} className={`health ${provider.status}`}>
            <strong>{provider.displayName}</strong>
            <span>{provider.status}</span>
            {provider.reason ? <em>{provider.reason}</em> : null}
          </li>
        ))}
      </ul>
      <div className="stack-form-actions">
        <Link to="/settings" className="settings-link">
          Open Settings
        </Link>
        <Button type="button" onClick={props.onNext}>
          Continue <ArrowRight size={14} />
        </Button>
      </div>
    </section>
  );
}

function RepoStep(props: { onDone: (repoId: string) => void }) {
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const inspect = useMutation({
    mutationFn: () =>
      api<RepoInspectResult>("/api/repos/inspect", {
        method: "POST",
        body: JSON.stringify({ rootPath }),
      }),
  });
  const register = useMutation({
    mutationFn: () =>
      api<{ repo: { id: string } }>("/api/repos", {
        method: "POST",
        body: JSON.stringify({
          rootPath,
          name: name || undefined,
          worktreeParent: inspect.data?.suggestedWorktreeParent,
        }),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onDone(result.repo.id);
    },
  });
  return (
    <section className="onboarding-card">
      <div className="onboarding-card-title">
        <Folder size={16} />
        <h2>Register a repository</h2>
      </div>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!inspect.data || inspect.data.rootPath !== rootPath) {
            inspect.mutate();
            return;
          }
          if (inspect.data.isGit) register.mutate();
        }}
      >
        <label>
          Local path to a git repository
          <input
            value={rootPath}
            onChange={(event) => {
              setRootPath(event.target.value);
              inspect.reset();
            }}
            placeholder="/home/me/project"
          />
        </label>
        <label>
          Display name (optional)
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="My Project" />
        </label>
        {inspect.data ? (
          <div className={`repo-inspect ${inspect.data.isGit ? "ok" : "warn"}`}>
            {inspect.data.isGit ? (
              <>
                <small>default branch: {inspect.data.defaultBranch ?? "?"}</small>
                <small>remotes: {inspect.data.remotes.join(", ") || "(none)"}</small>
                <small>worktree parent will be {inspect.data.suggestedWorktreeParent}</small>
              </>
            ) : (
              <small>{inspect.data.exists ? "Not a git repository" : "Path does not exist"}</small>
            )}
          </div>
        ) : null}
        <Button type="submit" disabled={!rootPath || inspect.isPending || register.isPending}>
          {!inspect.data || inspect.data.rootPath !== rootPath ? "Inspect path" : "Register repo"}
        </Button>
        {inspect.error ? <p>{String(inspect.error)}</p> : null}
        {register.error ? <p>{String(register.error)}</p> : null}
      </form>
    </section>
  );
}

function WorkspaceStep(props: { repoId: string; onDone: () => void }) {
  const [name, setName] = useState("first-workspace");
  const mutation = useMutation({
    mutationFn: () =>
      api<{ workspaceId: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ repoId: props.repoId, name, source: "scratch" }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onDone();
    },
  });
  return (
    <section className="onboarding-card">
      <div className="onboarding-card-title">
        <TerminalSquare size={16} />
        <h2>Create your first workspace</h2>
      </div>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Workspace name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <Button type="submit" disabled={mutation.isPending || !props.repoId}>
          Create workspace
        </Button>
        {mutation.error ? <p>{String(mutation.error)}</p> : null}
      </form>
    </section>
  );
}
