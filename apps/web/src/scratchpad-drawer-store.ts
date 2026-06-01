// Single source of truth for the scratchpad drawer's open/closed state.
//
// The drawer is mounted at the Shell level (sibling to <Outlet />) so it
// survives route changes; its visibility is driven by this module-level
// boolean. Multiple components subscribe: the Shell renders the panel,
// the Shell-level keydown handler toggles via cmd+shift+s, the navigator's
// scratchpad link toggles on click, and the /scratchpad route's redirect
// component sets open=true on mount before navigating away.
//
// A module-level emitter (over a React context provider) keeps the wiring
// trivial — there is exactly one writer pattern (call toggle/setOpen) and
// readers use the hook.
import { useSyncExternalStore } from "react";

type Listener = () => void;

let openState = false;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

export function getScratchpadDrawerOpen(): boolean {
  return openState;
}

export function setScratchpadDrawerOpen(next: boolean): void {
  if (openState === next) return;
  openState = next;
  notify();
}

export function toggleScratchpadDrawer(): void {
  setScratchpadDrawerOpen(!openState);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useScratchpadDrawer(): {
  open: boolean;
  toggle: () => void;
  setOpen: (next: boolean) => void;
} {
  const open = useSyncExternalStore(subscribe, getScratchpadDrawerOpen, getScratchpadDrawerOpen);
  return {
    open,
    toggle: toggleScratchpadDrawer,
    setOpen: setScratchpadDrawerOpen,
  };
}

// Test-only reset hook — vitest tests that flip the store across runs need a
// clean slate without re-importing the module.
export function __resetScratchpadDrawerForTest(): void {
  openState = false;
  listeners.clear();
}
