import { X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { cn } from "../../lib/utils.js";

// Minimal in-process toast queue + <Toaster /> renderer. Backed by a module
// store consumed via useSyncExternalStore so the queue is shared by every
// <Toaster /> mounted on the page (the cockpit mounts exactly one).

export type ToastVariant = "default" | "success" | "warning" | "danger";

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss timeout in milliseconds. Defaults to 5000. Pass 0 to disable. */
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: string;
  variant: ToastVariant;
  durationMs: number;
}

const listeners = new Set<() => void>();
let queue: ToastItem[] = [];
let maxQueue = 5;
let counter = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const fn of listeners) fn();
}

function snapshot(): ToastItem[] {
  return queue;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function nextId(): string {
  counter += 1;
  return `toast-${counter}`;
}

function dismiss(id: string) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const before = queue.length;
  queue = queue.filter((t) => t.id !== id);
  if (queue.length !== before) emit();
}

export function toast(input: ToastInput): string {
  const item: ToastItem = {
    ...input,
    id: nextId(),
    variant: input.variant ?? "default",
    durationMs: input.durationMs ?? 5000,
  };
  queue = [...queue, item];
  if (queue.length > maxQueue) {
    // Dropping older entries — clear their pending timers so the queue
    // and timer maps stay in sync.
    const dropped = queue.slice(0, queue.length - maxQueue);
    for (const d of dropped) {
      const t = timers.get(d.id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(d.id);
      }
    }
    queue = queue.slice(queue.length - maxQueue);
  }
  emit();
  if (item.durationMs > 0) {
    timers.set(
      item.id,
      setTimeout(() => dismiss(item.id), item.durationMs),
    );
  }
  return item.id;
}

// Testing helpers — exported but not part of the public API surface.
export function resetToastQueue() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  queue = [];
  counter = 0;
  emit();
}

export function getToastQueueLength(): number {
  return queue.length;
}

export interface ToasterProps {
  /** Maximum simultaneous toasts. Older entries are dropped past this cap. */
  maxQueue?: number;
}

const variantClasses: Record<ToastVariant, string> = {
  default: "border-[var(--c-line-2)] bg-[var(--c-card)] text-[var(--c-fg-1)]",
  success: "border-[var(--c-ok)] bg-[var(--c-ok-bg)] text-[var(--c-fg-1)]",
  warning: "border-[var(--c-warn)] bg-[var(--c-warn-bg)] text-[var(--c-fg-1)]",
  danger: "border-[var(--c-bad)] bg-[var(--c-bad-bg)] text-[var(--c-fg-1)]",
};

export function Toaster({ maxQueue: max }: ToasterProps = {}) {
  // Apply the cap as an effect, not during render — the module-level
  // `maxQueue` is a singleton across every <Toaster /> on the page, and
  // assigning during render would mutate it on StrictMode double-render or
  // suspense retry. The cockpit mounts exactly one <Toaster /> at the
  // root, so the singleton contract is fine; this guard just keeps the
  // render path side-effect-free.
  useEffect(() => {
    if (max !== undefined) maxQueue = max;
  }, [max]);
  const items = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div
      data-component="toaster"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col items-end gap-2"
    >
      {items.map((item) => (
        <ToastItemRow key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
}

function ToastItemRow({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  // role="status" for non-critical announcements (polite live region),
  // role="alert" for danger (assertive live region). Setting role
  // explicitly even on the implicit-status <output> element avoids relying
  // on assistive tech that might not translate <output> → status.
  const role = item.variant === "danger" ? "alert" : "status";
  return (
    <output
      role={role}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-[10px] border px-3 py-2 shadow-[var(--sh-2)]",
        variantClasses[item.variant],
      )}
    >
      <div className="flex-1">
        <div className="text-sm font-semibold">{item.title}</div>
        {item.description ? <div className="mt-0.5 text-xs text-[var(--c-fg-3)]">{item.description}</div> : null}
      </div>
      <button
        type="button"
        data-slot="toast-close"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-mr-1 -mt-0.5 inline-grid h-5 w-5 place-items-center rounded-md text-[var(--c-fg-3)] transition-colors hover:bg-[color-mix(in_srgb,CanvasText_7%,transparent)] hover:text-[var(--c-fg-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)]"
      >
        <X size={12} />
      </button>
    </output>
  );
}
