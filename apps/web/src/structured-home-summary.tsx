import type {
  LocalNotificationEvent,
  ManagerActionLedgerEntry,
  Workspace,
  WorkspaceManager,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { Bell, CheckCircle2, GitBranch, PauseCircle, PlayCircle, Route, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { StateResponse } from "./app-state.js";

export type StructuredHomeSummaryModel = {
  activePlan: WorkspacePlanVersion | null;
  manager: WorkspaceManager | null;
  deliveryUnits: WorkspacePlanDeliveryUnit[];
  activeNotifications: LocalNotificationEvent[];
  recentActions: ManagerActionLedgerEntry[];
  checkoutBindings: number;
};

export function structuredHomeSummaryModel(input: {
  workspace: Workspace;
  plans: WorkspacePlanVersion[];
  managers: WorkspaceManager[];
  deliveryUnits: WorkspacePlanDeliveryUnit[];
  checkouts: WorktreeCheckout[];
  managerActions: ManagerActionLedgerEntry[];
  localNotifications: LocalNotificationEvent[];
}): StructuredHomeSummaryModel {
  const activePlan = input.plans.find((plan) => plan.workspaceId === input.workspace.id && plan.active) ?? null;
  const manager = input.managers.find((entry) => entry.workspaceId === input.workspace.id) ?? null;
  const units = activePlan
    ? input.deliveryUnits.filter(
        (unit) => unit.workspaceId === input.workspace.id && unit.planVersionId === activePlan.id,
      )
    : [];
  const activeNotifications = input.localNotifications
    .filter((event) => event.workspaceId === input.workspace.id && event.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recentActions = input.managerActions
    .filter((action) => action.workspaceId === input.workspace.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4);
  const checkoutBindings = activePlan
    ? input.checkouts.filter(
        (checkout) => checkout.deliveryPlanVersionId === activePlan.id && Boolean(checkout.deliveryUnitKey),
      ).length
    : 0;
  return { activePlan, manager, deliveryUnits: units, activeNotifications, recentActions, checkoutBindings };
}

export function StructuredHomeSummary(props: {
  workspace: Workspace;
  state: Pick<
    StateResponse,
    "workspacePlans" | "workspaceManagers" | "workspacePlanDeliveryUnits" | "managerActions" | "localNotifications"
  >;
  checkouts: WorktreeCheckout[];
}) {
  const model = structuredHomeSummaryModel({
    workspace: props.workspace,
    plans: props.state.workspacePlans,
    managers: props.state.workspaceManagers,
    deliveryUnits: props.state.workspacePlanDeliveryUnits,
    checkouts: props.checkouts,
    managerActions: props.state.managerActions,
    localNotifications: props.state.localNotifications,
  });
  const managerPaused = model.manager?.pauseState === "paused";
  return (
    <section className="structured-home-summary" aria-label="Structured workspace summary">
      <div className="shs-header">
        <div>
          <div className="shs-eyebrow">Workspace Home</div>
          <h2>{props.workspace.name}</h2>
        </div>
        <span className={`shs-manager ${managerPaused ? "paused" : "running"}`}>
          {managerPaused ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
          manager {managerPaused ? "paused" : model.manager ? "running" : "not started"}
        </span>
      </div>
      <div className="shs-grid">
        <SummaryMetric
          icon={<Route size={15} />}
          label="Plan"
          value={model.activePlan ? `v${model.activePlan.version} ${model.activePlan.status}` : "none"}
          detail={model.activePlan?.approvalMode ?? "approval needed"}
        />
        <SummaryMetric
          icon={<GitBranch size={15} />}
          label="Delivery"
          value={`${model.checkoutBindings}/${model.deliveryUnits.length}`}
          detail="checkouts bound"
        />
        <SummaryMetric
          icon={<Bell size={15} />}
          label="Attention"
          value={String(model.activeNotifications.length)}
          detail="active notifications"
        />
      </div>
      <div className="shs-columns">
        <div className="shs-section">
          <h3>Delivery Units</h3>
          <div className="shs-list">
            {model.deliveryUnits.slice(0, 5).map((unit) => (
              <div className="shs-row" key={unit.id ?? unit.key}>
                <span className="shs-row-main">{unit.key}</span>
                <span className="shs-row-sub">{unit.checkoutName}</span>
                <span className="shs-row-sub">{unit.status}</span>
              </div>
            ))}
            {model.deliveryUnits.length === 0 ? <div className="shs-empty">No approved delivery units</div> : null}
          </div>
        </div>
        <div className="shs-section">
          <h3>Manager Activity</h3>
          <div className="shs-list">
            {model.activeNotifications.slice(0, 2).map((event) => (
              <div className="shs-row attention" key={event.id}>
                <ShieldAlert size={13} />
                <span className="shs-row-main">{event.title}</span>
              </div>
            ))}
            {model.recentActions.map((action) => (
              <div className="shs-row" key={action.id}>
                <CheckCircle2 size={13} />
                <span className="shs-row-main">{action.actionName}</span>
                <span className="shs-row-sub">{action.status}</span>
              </div>
            ))}
            {model.activeNotifications.length === 0 && model.recentActions.length === 0 ? (
              <div className="shs-empty">No manager activity yet</div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function SummaryMetric(props: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="shs-metric">
      <span className="shs-metric-icon">{props.icon}</span>
      <span>
        <span className="shs-metric-label">{props.label}</span>
        <strong>{props.value}</strong>
        <span className="shs-metric-detail">{props.detail}</span>
      </span>
    </div>
  );
}
