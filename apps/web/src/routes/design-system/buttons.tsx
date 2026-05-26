import { Plus, X } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { IconButton } from "../../components/ui/icon-button.js";

export function ButtonsSection() {
  return (
    <div className="flex flex-col gap-3">
      <Row label="Variants">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Row>
      <Row label="Sizes">
        <Button size="sm">Small</Button>
        <Button size="default">Default</Button>
        <Button size="lg">Large</Button>
      </Row>
      <Row label="States">
        <Button loading>Loading</Button>
        <Button disabled>Disabled</Button>
        <Button variant="secondary" loading>
          Saving…
        </Button>
      </Row>
      <Row label="IconButton">
        <IconButton aria-label="Add workspace">
          <Plus size={14} />
        </IconButton>
        <IconButton aria-label="Close" variant="ghost">
          <X size={14} />
        </IconButton>
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--c-fg-4)]">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
