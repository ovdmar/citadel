import { NotebookPen } from "lucide-react";
import { useScratchpadDrawer } from "./scratchpad-drawer-store.js";

export function ScratchpadNavLink() {
  const { open, toggle } = useScratchpadDrawer();
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const hint = isMac ? "Shift+Cmd+S" : "Shift+Ctrl+S";
  return (
    <button
      type="button"
      className={`nav-link-button${open ? " active" : ""}`}
      onClick={toggle}
      title={`Scratchpad — markdown notes orchestrator agents can read via MCP (${hint})`}
      aria-pressed={open}
    >
      <NotebookPen size={13} /> Scratchpad
      <kbd className="nav-kbd-hint" aria-hidden>
        {hint}
      </kbd>
    </button>
  );
}
