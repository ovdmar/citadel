type UiDiagnosticExtra = {
  persisted?: boolean;
};

const HEARTBEAT_MS = 60_000;
let installed = false;
let cleanup: (() => void) | null = null;
const pageId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const startedAt = Date.now();

export function installUiDiagnostics() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;

  postUiDiagnostic("page.load");
  const onPageShow = (event: PageTransitionEvent) => postUiDiagnostic("page.pageshow", { persisted: event.persisted });
  const onPageHide = (event: PageTransitionEvent) =>
    postUiDiagnostic("page.pagehide", { persisted: event.persisted }, true);
  const onVisibility = () => postUiDiagnostic("page.visibility");
  const onFocus = () => postUiDiagnostic("page.focus");
  const onBlur = () => postUiDiagnostic("page.blur");
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  const heartbeatTimer = window.setInterval(() => postUiDiagnostic("page.heartbeat"), HEARTBEAT_MS);
  (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  cleanup = () => {
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(heartbeatTimer);
  };

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", () => postUiDiagnostic("sw.controllerchange"));
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.addEventListener("updatefound", () => postUiDiagnostic("sw.updatefound"));
      })
      .catch(() => undefined);
  }
}

export function resetUiDiagnosticsForTests() {
  cleanup?.();
  cleanup = null;
  installed = false;
}

function postUiDiagnostic(event: string, extra: UiDiagnosticExtra = {}, unload = false) {
  const payload = {
    event,
    pageId,
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    href: window.location.href,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    navigationType: navigationType(),
    ageMs: Date.now() - startedAt,
    persisted: extra.persisted,
    online: navigator.onLine,
    wasDiscarded: (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true,
    swController: Boolean(navigator.serviceWorker?.controller),
  };
  const body = JSON.stringify(payload);

  if (unload && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon("/api/diagnostics/client-event", blob)) return;
  }

  fetch("/api/diagnostics/client-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: unload,
  }).catch(() => undefined);
}

function navigationType() {
  const entries = typeof performance.getEntriesByType === "function" ? performance.getEntriesByType("navigation") : [];
  const nav = entries[0] as PerformanceNavigationTiming | undefined;
  return typeof nav?.type === "string" ? nav.type : "";
}
