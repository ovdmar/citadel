// Minimal toast surface used by the optimistic-remove rollback path and
// the create-workspace error path. No external dep — a bottom-right
// stack of auto-dismissing notifications driven by React context.

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import "./toast.css";

type ToastTone = "info" | "error";

type ToastEntry = {
  id: string;
  tone: ToastTone;
  message: string;
  // Absolute timestamp at which the entry should be removed. Stored on
  // the entry rather than tracked in a separate Map so the render path
  // and the dismiss path see the same source of truth and the effect
  // below can compute the next wake-up deterministically.
  expiresAt: number;
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
    const expiresAt = Date.now() + AUTO_DISMISS_MS;
    setItems((prev) => [...prev, { id, tone: input.tone ?? "info", message: input.message, expiresAt }]);
  }, []);

  // Per-entry expiry. We re-derive the next wake-up from the smallest
  // `expiresAt` in the queue, schedule a single timeout to that absolute
  // time, and the timeout handler removes ALL entries whose expiry has
  // passed (handles edge cases where the page slept or multiple toasts
  // expire on the same tick). This survives rapid pushes without
  // resetting the oldest toast's clock — every entry's expiry is fixed
  // at push time and remains so.
  const timeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (items.length === 0) {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      return;
    }
    const nextExpiry = items.reduce((min, entry) => Math.min(min, entry.expiresAt), Number.POSITIVE_INFINITY);
    const delay = Math.max(0, nextExpiry - Date.now());
    timeoutRef.current = window.setTimeout(() => {
      const now = Date.now();
      setItems((prev) => prev.filter((entry) => entry.expiresAt > now));
    }, delay);
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
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
