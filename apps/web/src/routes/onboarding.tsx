import type { ProviderHealth } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, CheckCircle2, Folder, ShieldCheck, TerminalSquare } from "lucide-react";
import { useState } from "react";
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
  const providerHealth = state.data?.providerHealth ?? [];
  const repos = state.data?.repos ?? [];
  const workspaces = state.data?.workspaces ?? [];

  // Derive step health from current state — each step "passes" once its
  // requirement is met. Users can revisit any step (healthy or not), which is
  // useful for re-running the provider check or adding another repo.
  const providersOk = providerHealth.length > 0 && providerHealth.every((p) => p.status === "healthy");
  const repoOk = repos.length > 0;
  // We consider the "workspace" step done once any non-root workspace exists,
  // since the root workspace is auto-created when a repo is registered.
  const workspaceOk = workspaces.some((w) => w.kind !== "root");

  // Default to the first incomplete step but allow user to override.
  const firstIncomplete: Step = !providersOk ? "providers" : !repoOk ? "repo" : !workspaceOk ? "workspace" : "done";
  const [step, setStep] = useState<Step>(firstIncomplete);
  const [registeredRepoId, setRegisteredRepoId] = useState("");

  if (state.isLoading) return <div className="empty">Loading local state…</div>;
  return (
    <div className="page onboarding-page">
      <header className="header">
        <div>
          <h1>Onboarding</h1>
          <p>Provider check, repository, workspace. Click any step to revisit.</p>
        </div>
        <div className="settings-header-actions">
          <Link className="settings-link" to="/">
            <ArrowLeft size={14} /> Back
          </Link>
          <Link className="settings-link" to="/settings">
            Settings
          </Link>
        </div>
      </header>
      <ol className="onboarding-steps">
        <StepHeader
          index={1}
          title="Verify providers"
          active={step === "providers"}
          done={providersOk}
          onSelect={() => setStep("providers")}
        />
        <StepHeader
          index={2}
          title="Register a repo"
          active={step === "repo"}
          done={repoOk}
          onSelect={() => setStep("repo")}
        />
        <StepHeader
          index={3}
          title="Create a workspace"
          active={step === "workspace"}
          done={workspaceOk}
          onSelect={() => setStep("workspace")}
        />
      </ol>
      {step === "providers" ? <ProvidersStep providerHealth={providerHealth} onNext={() => setStep("repo")} /> : null}
      {step === "repo" ? (
        <RepoStep
          repos={repos}
          onDone={(repoId) => {
            setRegisteredRepoId(repoId);
            setStep("workspace");
          }}
        />
      ) : null}
      {step === "workspace" ? (
        <WorkspaceStep
          repoId={registeredRepoId || (repos[0]?.id ?? "")}
          existingWorkspaces={workspaces.filter((w) => w.kind !== "root")}
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

function StepHeader(props: {
  index: number;
  title: string;
  active: boolean;
  done: boolean;
  onSelect?: () => void;
}) {
  // The whole row is clickable — passing items are revisitable so the user
  // can re-run a provider check or add another workspace at will.
  return (
    <li className={`onboarding-step ${props.active ? "active" : ""} ${props.done ? "done" : ""}`}>
      <button type="button" className="onboarding-step-button" onClick={props.onSelect}>
        <span className="step-index">{props.done ? <CheckCircle2 size={14} /> : props.index}</span>
        <span>{props.title}</span>
        {props.done ? <span className="step-status">ready · click to revisit</span> : null}
      </button>
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
        Citadel uses provider presets and checks their health from the selected method. Configure details in Settings;
        continue when the local baseline is good enough for this repo.
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

function RepoStep(props: {
  repos: { id: string; name: string; rootPath: string }[];
  onDone: (repoId: string) => void;
}) {
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
      {props.repos.length ? (
        <div className="onboarding-existing">
          <small>Already registered:</small>
          <ul>
            {props.repos.map((repo) => (
              <li key={repo.id}>
                <strong>{repo.name}</strong>
                <span className="command-result-meta">{repo.rootPath}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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

function WorkspaceStep(props: {
  repoId: string;
  existingWorkspaces: { id: string; name: string; branch: string }[];
  onDone: () => void;
}) {
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
      {props.existingWorkspaces.length ? (
        <div className="onboarding-existing">
          <small>Existing workspaces (open from the cockpit):</small>
          <ul>
            {props.existingWorkspaces.map((workspace) => (
              <li key={workspace.id}>
                <strong>{workspace.name}</strong>
                <span className="command-result-meta">{workspace.branch}</span>
              </li>
            ))}
          </ul>
          <Link to="/" className="settings-link">
            Open cockpit
          </Link>
        </div>
      ) : null}
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
