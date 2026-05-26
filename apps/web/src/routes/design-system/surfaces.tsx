import { Inbox } from "lucide-react";
import { Card } from "../../components/ui/card.js";
import { EmptyState } from "../../components/ui/empty-state.js";
import { Panel, PanelBody, PanelFooter, PanelHeader, PanelTitle } from "../../components/ui/panel.js";
import { Skeleton } from "../../components/ui/skeleton.js";

export function SurfacesSection() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <div className="text-xs font-semibold">Card</div>
          <p className="text-[11px] text-[var(--c-fg-3)]">Rounded surface with --c-card bg.</p>
        </Card>
        <Panel>
          <PanelHeader>
            <PanelTitle>Panel header</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <p className="text-xs text-[var(--c-fg-2)]">Body</p>
          </PanelBody>
          <PanelFooter>
            <span className="text-[11px] text-[var(--c-fg-3)]">Footer</span>
          </PanelFooter>
        </Panel>
      </div>
      <Card>
        <EmptyState
          icon={<Inbox size={20} />}
          heading="No workspaces yet"
          description="Create a workspace to get started."
          action={{ label: "Add workspace", onClick: () => {} }}
        />
      </Card>
      <Card>
        <div className="text-xs font-semibold">Skeleton</div>
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton width="60%" height={12} />
          <Skeleton width="80%" height={12} />
          <Skeleton width="40%" height={12} label="Loading PR data" />
        </div>
      </Card>
    </div>
  );
}
