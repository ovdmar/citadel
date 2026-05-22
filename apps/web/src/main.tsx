import { QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { queryClient } from "./api.js";
import { Cockpit } from "./cockpit.js";
import { DashboardView } from "./routes/dashboard.js";
import { HistoryView } from "./routes/history.js";
import { OnboardingView } from "./routes/onboarding.js";
import { OperationsView } from "./routes/operations.js";
import { RepoSettingsView } from "./routes/repo-settings.js";
import { SettingsView } from "./routes/settings.js";
import "./styles.css";
import "./stage-terminal.css";
import "./cockpit-extras.css";
import "./cockpit-tools.css";
import "./modals.css";
import "./operations.css";
import "./settings.css";
import "./settings-ia.css";
import "./responsive.css";

const rootRoute = createRootRoute({
  component: () => <Shell />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Cockpit,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const repoSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos/$repoId",
  component: RepoSettingsView,
});

const operationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations",
  component: OperationsView,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingView,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: DashboardView,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryView,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    settingsRoute,
    repoSettingsRoute,
    operationsRoute,
    onboardingRoute,
    dashboardRoute,
    historyRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Shell() {
  return (
    <div className="app-root">
      <Outlet />
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
