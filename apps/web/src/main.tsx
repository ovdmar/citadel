import { QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./api.js";
import { Cockpit } from "./cockpit.js";
import { bootstrapLastRoute, clearLastRoute, saveLastRoute } from "./lib/last-route.js";
import { DashboardView } from "./routes/dashboard.js";
import { HistoryView } from "./routes/history.js";
import { OnboardingView } from "./routes/onboarding.js";
import { OperationsView } from "./routes/operations.js";
import { RepoSettingsView } from "./routes/repo-settings.js";
import { ScheduledAgentsView } from "./routes/scheduled-agents.js";
import { ScratchpadView } from "./routes/scratchpad.js";
import { SettingsView } from "./routes/settings.js";
import "./styles.css";
import "./chrome.css";
import "./stage-terminal.css";
import "./cockpit-extras.css";
import "./pr-card-actions.css";
import "./inspector-stats.css";
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
import "./responsive.css";

// Seed data-theme on <html> BEFORE React renders so any component that
// reads it synchronously on first render (e.g. useResolvedTheme used by
// TerminalPane to spawn ttyd with the matching xterm palette) doesn't
// race ThemeControls's useEffect that writes the attribute later.
(() => {
  const stored = localStorage.getItem("citadel.theme");
  if (stored === "light" || stored === "dark") {
    document.documentElement.dataset.theme = stored;
  }
})();

const rootRoute = createRootRoute({
  component: () => <Shell />,
});

// Pathless layout route whose component renders the Cockpit unconditionally
// plus an overlay slot for any child route. Every non-index route mounts as
// a child here, so the Cockpit (and the TerminalPane iframes inside it) is
// kept alive across navigations to Settings, Scratchpad, etc. Without this,
// every route transition unmounted Cockpit → ttyd iframes were destroyed →
// returning forced a fresh ttyd handshake (the user's "reloads first" gripe).
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

const repoSettingsRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/repos/$repoId",
  component: RepoSettingsView,
});

const operationsRoute = createRoute({
  getParentRoute: () => cockpitLayoutRoute,
  path: "/operations",
  component: OperationsView,
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
    <div className="app-root">
      <Outlet />
    </div>
  );
}

function CockpitLayout() {
  return (
    <>
      <Cockpit />
      <RouteOverlay />
    </>
  );
}

function RouteOverlay() {
  const location = useLocation();
  const path = location.pathname;
  // On the index route Cockpit is the entire UI — no overlay needed (and
  // rendering one would steal pointer events from the cockpit grid). Anywhere
  // else, mount the child route in an opaque overlay so the Cockpit (with
  // its live terminal iframes) stays mounted but hidden behind.
  if (path === "/" || path === "") return null;
  return (
    <div className="route-overlay">
      <Outlet />
    </div>
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

// Restore the last visited route BEFORE the router boots so it picks the
// correct initial location off the URL bar. The decision logic lives in
// bootstrapLastRoute so it can be unit-tested independently.
if (typeof window !== "undefined") {
  bootstrapLastRoute(window.location, window.history);
}

const router = createRouter({
  routeTree: rootRoute.addChildren([
    cockpitLayoutRoute.addChildren([
      indexRoute,
      settingsRoute,
      repoSettingsRoute,
      operationsRoute,
      onboardingRoute,
      dashboardRoute,
      historyRoute,
      scratchpadRoute,
      scheduledAgentsRoute,
    ]),
  ]),
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
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
