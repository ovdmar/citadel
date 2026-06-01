type UiDiagnosticExtra = {
  persisted?: boolean;
};

let installed = false;
const pageId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const startedAt = Date.now();

export function installUiDiagnostics() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;

  postUiDiagnostic("page.load");
  window.addEventListener("pageshow", (event) => postUiDiagnostic("page.pageshow", { persisted: event.persisted }));
  window.addEventListener("pagehide", (event) =>
    postUiDiagnostic("page.pagehide", { persisted: event.persisted }, true),
  );
  document.addEventListener("visibilitychange", () => postUiDiagnostic("page.visibility"));

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
  installed = false;
}

function postUiDiagnostic(event: string, extra: UiDiagnosticExtra = {}, unload = false) {
  const payload = {
    event,
    pageId,
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    href: window.location.href,
    visibility: document.visibilityState,
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
