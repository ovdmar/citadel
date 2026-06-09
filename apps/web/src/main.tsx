/// <reference types="vite/client" />
import { QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./api.js";
import { OptimisticRemoveProvider } from "./app-state.js";
import { Cockpit } from "./cockpit.js";
import { Toaster } from "./components/ui/toast.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { bootstrapLastRoute, clearLastRoute, saveLastRoute } from "./lib/last-route.js";
import { bootstrapMobileScratchpad } from "./lib/mobile-scratchpad-bootstrap.js";
import { AgentTemplatesView } from "./routes/agents.js";
import { DashboardView } from "./routes/dashboard.js";
import { HistoryView } from "./routes/history.js";
import { OnboardingView } from "./routes/onboarding.js";
import { OperationsView } from "./routes/operations.js";
import { RepoSettingsView } from "./routes/repo-settings.js";
import { ReviewDiffView } from "./routes/review-diff.js";
import { ScheduledAgentsView } from "./routes/scheduled-agents.js";
import { ScratchpadView } from "./routes/scratchpad.js";
import { SettingsView } from "./routes/settings.js";
import { getScratchpadDrawerOpen, setScratchpadDrawerOpen, toggleScratchpadDrawer } from "./scratchpad-drawer-store.js";
import { ScratchpadPanel } from "./scratchpad-panel.js";
import { handleShellTerminalShortcutMessage } from "./shell-terminal-shortcuts.js";
import { ToastProvider } from "./toast.js";
import { installUiDiagnostics } from "./ui-diagnostics.js";
import { applyThemePreference, readThemePreference } from "./use-resolved-theme.js";
import { VoiceModeProvider, useVoiceMode } from "./voice-mode-provider.js";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./voice-mode.css";
import "./chrome.css";
import "./stage-terminal.css";
import "./stage-empty-launcher.css";
import "./structured-home-summary.css";
import "./cockpit-extras.css";
import "./pr-card-actions.css";
import "./inspector-stats.css";
import "./jira-picker.css";
import "./inspector-checks.css";
import "./inspector-deploy.css";
import "./inspector-meta.css";
import "./cockpit-tools.css";
import "./modals.css";
import "./namespaces.css";
import "./operations.css";
import "./settings.css";
import "./settings-ia.css";
import "./settings-cards.css";
import "./settings-rows.css";
import "./scheduled-agents.css";
import "./scheduled-agents-shell.css";
import "./runtime-usage.css";
import "./scratchpad.css";
import "./scratchpad-drawer.css";
import "./review-diff.css";
import "./responsive.css";

// Seed data-theme on <html> BEFORE React renders so any component that
// reads it synchronously on first render (e.g. useResolvedTheme used by
// TerminalPane to initialize xterm with the matching palette) doesn't
// race ThemeControls's useEffect that writes the attribute later.
(() => {
  applyThemePreference(readThemePreference());
})();

installUiDiagnostics();

const rootRoute = createRootRoute({
  component: () => <Shell />,
});

// Pathless layout route whose component renders the Cockpit unconditionally
// plus an overlay slot for any child route. Every non-index route mounts as
// a child here, so the Cockpit (and the TerminalPane instances inside it) is
// kept alive across navigations to Settings, Scratchpad, etc. Without this,
// every route transition unmounted Cockpit, destroyed the live terminal panes,
// and forced a fresh attach on return.
const cockpitLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "cockpit-layout",
  component: CockpitLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/",
  // No body: Cockpit is rendered by the parent layout. The empty Outlet here
  // is what lets RouteOverlay decide "we're on /, don't render the overlay."
  component: () => null,
});

const settingsRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/settings",
  component: SettingsView,
});

const agentsRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/agents",
  component: AgentTemplatesView,
});

const repoSettingsRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/repos/$repoId",
  component: RepoSettingsView,
});

const reviewDiffRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/workspaces/$workspaceId/checkouts/$checkoutId/review",
  component: ReviewDiffView,
});

const operationsRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/operations",
  component: OperationsView,
  // Surfaces deep-links from elsewhere in the cockpit (e.g. the redeploy
  // chip's "View log" link) — `?id=<operationId>` selects the matching row.
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === "string" ? search.id : undefined,
  }),
});

const onboardingRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/onboarding",
  component: OnboardingView,
});

const dashboardRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/dashboard",
  component: DashboardView,
});

const historyRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/history",
  component: HistoryView,
});

const scratchpadRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/scratchpad",
  component: ScratchpadView,
});

const scheduledAgentsRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/scheduled-agents",
  component: ScheduledAgentsView,
});

function Shell() {
  return (
    <VoiceModeProvider>
      <ShellContent />
    </VoiceModeProvider>
  );
}

function ShellContent() {
  const { startDictation, stopDictation } = useVoiceMode();
  const location = useLocation();
  const voiceRouteHrefRef = useRef(location.href);
  // Initialize the drawer from the `?scratchpad=1` query param on cold mount,
  // so deep-link refreshes (e.g. /settings?scratchpad=1) restore the drawer
  // exactly as it was. Subsequent toggles update the URL via syncDrawerToUrl
  // below; navigation does not unmount the panel.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("scratchpad") === "1") setScratchpadDrawerOpen(true);
  }, []);

  useEffect(() => {
    if (voiceRouteHrefRef.current === location.href) return;
    voiceRouteHrefRef.current = location.href;
    stopDictation({ commitFinal: false });
  }, [location.href, stopDictation]);

  // Shell-level keydown: cmd/ctrl+shift+s toggles the drawer from every route.
  // Cockpit-specific shortcuts (cmd+k, c, ctrl+n) stay in Cockpit so they're
  // not triggered on other routes.
  useEffect(() => {
    const toggleScratchpad = () => {
      toggleScratchpadDrawer();
      syncDrawerToUrl(getScratchpadDrawerOpen());
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        toggleScratchpad();
      }
    };
    const onMessage = (event: MessageEvent) => {
      handleShellTerminalShortcutMessage(event, { startDictation, toggleScratchpad });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, [startDictation]);

  return (
    <OptimisticRemoveProvider>
      <ToastProvider>
        <div className="app-root">
          <Outlet />
          <ScratchpadPanel />
        </div>
      </ToastProvider>
    </OptimisticRemoveProvider>
  );
}

// Mirror the drawer's open/closed state into the `?scratchpad=1` query param
// using replaceState — no history entry, so closing the drawer doesn't require
// multiple back presses. Keeps the URL bar consistent with the drawer state for
// share / reload / restore-on-cold-boot.
function syncDrawerToUrl(open: boolean) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const has = url.searchParams.get("scratchpad") === "1";
  if (open && !has) {
    url.searchParams.set("scratchpad", "1");
    window.history.replaceState(null, "", url.toString());
  } else if (!open && has) {
    url.searchParams.delete("scratchpad");
    window.history.replaceState(null, "", url.toString());
  }
}

function CockpitLayout() {
  const location = useLocation();
  // The Outlet is ALWAYS rendered (in a stable DOM position) so TanStack
  // Router never sees its mount point appear/disappear across route changes
  // — child route components mount/unmount around it, but the outer wrapper
  // is constant. The overlay is hidden by CSS when on the index route so the
  // cockpit is fully visible and clickable; on any other route the overlay
  // turns opaque and covers the cockpit, but the cockpit (including every
  // TerminalPane iframe) stays mounted underneath.
  const isIndex = location.pathname === "/" || location.pathname === "";
  return (
    <>
      <div aria-hidden={!isIndex}>
        <Cockpit />
      </div>
      <div className="route-overlay" data-hidden={isIndex ? "" : undefined} aria-hidden={isIndex}>
        <Outlet />
      </div>
    </>
  );
}

function NotFoundView() {
  // A stale persisted route (e.g. a removed page) would otherwise loop the user
  // back into 404 on every reload. Clear the saved value once on mount so the
  // next boot falls through to the default cockpit view. Done in an effect (not
  // during render) so we don't fire side effects from a render function.
  useEffect(() => {
    clearLastRoute();
  }, []);
  return (
    <div className="empty">
      <p>That page is no longer available.</p>
      <Link className="settings-link" to="/">
        Back to cockpit
      </Link>
    </div>
  );
}

// Bootstrap the URL before the router boots so it picks the correct initial
// location. Mobile scratchpad default-open runs first, then last-route restore
// handles ordinary bare-root reloads.
if (typeof window !== "undefined") {
  if (!bootstrapMobileScratchpad(window.location, window.history)) {
    bootstrapLastRoute(window.location, window.history);
  }
}

// Base routes always shipped. Dev-only routes are appended below behind a
// static `if (import.meta.env.DEV)` guard which Vite tree-shakes out of
// production bundles — the dynamic `import()` inside the branch never
// emits a chunk for prod builds because the entire branch is dead code
// when DEV is replaced with the literal `false`.
const childRoutes: AnyRoute[] = [
  cockpitLayoutRoute.addChildren([
    indexRoute,
    settingsRoute,
    agentsRoute,
    repoSettingsRoute,
    reviewDiffRoute,
    operationsRoute,
    onboardingRoute,
    dashboardRoute,
    historyRoute,
    scratchpadRoute,
    scheduledAgentsRoute,
  ]),
];

if (import.meta.env.DEV) {
  const { DesignSystemShowcase } = await import("./routes/design-system/index.js");
  const designSystemRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/design-system",
    component: DesignSystemShowcase,
  });
  childRoutes.push(designSystemRoute);
}

const router = createRouter({
  routeTree: rootRoute.addChildren(childRoutes),
  defaultNotFoundComponent: NotFoundView,
});

// Persist every resolved navigation. onResolved (vs onBeforeNavigate) ensures
// only routes the user actually reached enter the store — aborted loads and
// in-flight navigations are skipped, so we never restore into a broken state.
// Also skip non-2xx outcomes (404, redirects-in-flight) so a stale route can't
// briefly write itself back to storage between resolve and NotFoundView mount.
router.subscribe("onResolved", (event) => {
  const status = router.state.statusCode;
  if (status >= 400) return;
  saveLastRoute(event.toLocation.href);
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
);
