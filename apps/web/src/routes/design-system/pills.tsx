import { GitBranch } from "lucide-react";
import { Badge } from "../../components/ui/badge.js";
import { Chip } from "../../components/ui/chip.js";

const variants = ["neutral", "ready", "blocked", "info", "warn", "merged", "neutral-strong"] as const;

export function PillsSection() {
  return (
    <div className="flex flex-col gap-3">
      <Row label="Badge variants">
        {variants.map((v) => (
          <Badge key={v} variant={v}>
            {v}
          </Badge>
        ))}
      </Row>
      <Row label="Badge with dot">
        {variants.map((v) => (
          <Badge key={v} variant={v} dot>
            {v}
          </Badge>
        ))}
      </Row>
      <Row label="Chip with leading icon">
        <Chip variant="info" icon={<GitBranch size={11} />}>
          feat/foo
        </Chip>
        <Chip variant="warn">no icon</Chip>
      </Row>
      <Row label="Chip with onClose">
        <Chip variant="merged" onClose={() => {}} closeAriaLabel="Remove">
          DESIGN-12
        </Chip>
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
