import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { App, AuthScreen, PendingScreen, SetupScreen } from "./App.tsx";
import { isAdminSection, parseAdminSearch } from "./adminRouting.ts";
import "./styles.css";

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: App });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: AuthScreen,
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupScreen,
});
const pendingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pending",
  component: PendingScreen,
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/$section",
  validateSearch: parseAdminSearch,
  component: () => {
    const { section } = adminRoute.useParams();
    const search = adminRoute.useSearch();
    return (
      <App
        initialView="admin"
        initialAdminSection={isAdminSection(section) ? section : "overview"}
        initialAdminSearch={search}
      />
    );
  },
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  setupRoute,
  pendingRoute,
  adminRoute,
]);
const router = createRouter({ routeTree });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
