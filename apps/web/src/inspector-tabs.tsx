import { X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.js";

export type InspectorTab = "stats" | "diff";

// Inspector tab strip extracted from inspector.tsx so the parent file
// stays under the 800-line `check:size` cap. Uses the Radix-backed Tabs
// primitive but renders only the trigger row — the actual panel content
// is conditionally rendered by the caller (inspector.tsx) inside its
// existing `<div className="column-body">`, which keeps the scroll
// container intact.
//
// CRITICAL: `data-active={tab}` MUST be on the TabsList wrapper because
// `inspector-deploy.css:94` styles `.inspector-tabs[data-active="<tab>"]`
// — see plan §Migration: Inspector tabs.
export interface InspectorTabsProps {
  tab: InspectorTab;
  onTabChange: (next: InspectorTab) => void;
  fileCount: number | null;
  onCollapse: () => void;
}

export function InspectorTabs({ tab, onTabChange, fileCount, onCollapse }: InspectorTabsProps) {
  return (
    <Tabs value={tab} onValueChange={(next) => onTabChange(next as InspectorTab)}>
      <TabsList className="inspector-tabs" data-active={tab}>
        <TabsTrigger
          value="stats"
          className={`inspector-tab ${tab === "stats" ? "active" : ""}`}
          title="PR and check stats"
        >
          Stats
        </TabsTrigger>
        <TabsTrigger
          value="diff"
          className={`inspector-tab ${tab === "diff" ? "active" : ""}`}
          title="Changed files and working tree diff"
        >
          Diff
          {fileCount !== null && fileCount > 0 ? <span className="inspector-tab-count">{fileCount}</span> : null}
        </TabsTrigger>
        <span className="inspector-tab-indicator" data-tab={tab} aria-hidden />
        <button
          type="button"
          className="cit-icon-btn cit-icon-btn--sm inspector-tabs-collapse"
          onClick={onCollapse}
          aria-label="Collapse inspector"
          title="Collapse inspector"
        >
          <X size={12} />
        </button>
      </TabsList>
    </Tabs>
  );
}
