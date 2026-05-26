// Minimal toast surface used by the optimistic-remove rollback path and
// the create-workspace error path. No external dep — a bottom-right
// stack of auto-dismissing notifications driven by React context.

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type ToastTone = "info" | "error";

type ToastEntry = {
  id: string;
  tone: ToastTone;
  message: string;
};

type ToastContextValue = {
  push: (input: { tone?: ToastTone; message: string }) => void;
};

const ToastContext = createContext<ToastContextValue>({ push: () => undefined });

const AUTO_DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastEntry[]>([]);

  const push = useCallback<ToastContextValue["push"]>((input) => {
    const id = `toast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setItems((prev) => [...prev, { id, tone: input.tone ?? "info", message: input.message }]);
  }, []);

  // Auto-dismiss: each toast lives for AUTO_DISMISS_MS. Using a single
  // effect keyed off the entire `items` list keeps the dismiss timer
  // simple — every push schedules a tick, and the tick walks the oldest
  // toast off the queue. Avoids per-item setTimeout cleanup edge cases.
  useEffect(() => {
    if (items.length === 0) return;
    const oldest = items[0];
    if (!oldest) return;
    const timeoutId = window.setTimeout(() => {
      setItems((prev) => prev.filter((entry) => entry.id !== oldest.id));
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [items]);

  const value = useMemo<ToastContextValue>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewportInternal
        items={items}
        onDismiss={(id) => setItems((prev) => prev.filter((entry) => entry.id !== id))}
      />
    </ToastContext.Provider>
  );
}

// Public viewport hook — re-exported for cockpit-level placement if a
// caller wants to position the toast stack relative to its own layout.
// In practice ToastProvider already mounts a default viewport so most
// callers can ignore this.
export function ToastViewport(): null {
  return null;
}

function ToastViewportInternal({ items, onDismiss }: { items: ToastEntry[]; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <output className="cit-toast-stack" aria-live="polite">
      {items.map((entry) => (
        <div key={entry.id} className={`cit-toast cit-toast-${entry.tone}`}>
          <span className="cit-toast-message">{entry.message}</span>
          <button
            type="button"
            className="cit-toast-dismiss"
            onClick={() => onDismiss(entry.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </output>
  );
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
