import { useState } from "react";
import { ButtonsSection } from "./buttons.js";
import { FeedbackSection } from "./feedback.js";
import { FormsSection } from "./forms.js";
import { NavigationSection } from "./navigation.js";
import { OverlaysSection } from "./overlays.js";
import { PillsSection } from "./pills.js";
import { SurfacesSection } from "./surfaces.js";

// Unique marker token. The production-build verification step greps for
// this string in apps/web/dist/assets and fails the gate if found — the
// dev-only `if (import.meta.env.DEV)` branch in main.tsx must drop the
// entire showcase chunk in production builds.
export const DESIGN_SYSTEM_SHOWCASE_MARKER = "CITADEL_DESIGN_SYSTEM_SHOWCASE";

type Section = "buttons" | "pills" | "surfaces" | "forms" | "overlays" | "navigation" | "feedback";

const sections: { id: Section; label: string; render: () => React.ReactNode }[] = [
  { id: "buttons", label: "Buttons & IconButton", render: () => <ButtonsSection /> },
  { id: "pills", label: "Badge & Chip", render: () => <PillsSection /> },
  { id: "surfaces", label: "Card / Panel / EmptyState / Skeleton", render: () => <SurfacesSection /> },
  { id: "forms", label: "Form fields", render: () => <FormsSection /> },
  { id: "overlays", label: "Dialog & Tooltip", render: () => <OverlaysSection /> },
  { id: "navigation", label: "Tabs", render: () => <NavigationSection /> },
  { id: "feedback", label: "Toast", render: () => <FeedbackSection /> },
];

export function DesignSystemShowcase() {
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[var(--c-canvas)] text-[var(--c-fg-1)]">
      <Pane theme="light" />
      <Pane theme="dark" />
    </div>
  );
}

function Pane({ theme }: { theme: "light" | "dark" }) {
  return (
    <div
      data-theme={theme}
      className="flex-1 overflow-auto border-r border-[var(--c-line-2)] bg-[var(--c-canvas)] p-6 text-[var(--c-fg-1)] last:border-r-0"
    >
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">{theme === "light" ? "Light" : "Dark"}</h1>
        <span className="text-xs text-[var(--c-fg-3)]">{DESIGN_SYSTEM_SHOWCASE_MARKER}</span>
      </div>
      {sections.map((section) => (
        <SectionBlock key={section.id} id={section.id} label={section.label}>
          {section.render()}
        </SectionBlock>
      ))}
    </div>
  );
}

function SectionBlock({
  id,
  label,
  children,
}: {
  id: Section;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section data-section={id} className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="mb-2 inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--c-fg-4)] hover:text-[var(--c-fg-2)]"
      >
        <span>{open ? "▼" : "▶"}</span>
        {label}
      </button>
      {open ? <div className="flex flex-col gap-4">{children}</div> : null}
    </section>
  );
}
