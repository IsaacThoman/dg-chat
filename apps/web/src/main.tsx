import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { App, AuthScreen, PendingScreen, SetupScreen } from "./App.tsx";
import { isAdminSection, parseAdminSearch } from "./adminRouting.ts";
import { isAdminUserRouteId, isAdminUserTab } from "./admin/users/adminUserRouting.ts";
import { PublicConversationShareView } from "./PublicConversationShare.tsx";
import {
  ForgotPasswordScreen,
  ResetPasswordScreen,
  VerifyEmailScreen,
} from "./IdentityRecovery.tsx";
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
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordScreen,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ResetPasswordScreen,
});
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify-email",
  component: VerifyEmailScreen,
});
const publicShareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share/$capability",
  component: () => {
    const { capability } = publicShareRoute.useParams();
    return <PublicConversationShareView capability={capability} />;
  },
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
const adminUserDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/users/$userId/$tab",
  validateSearch: parseAdminSearch,
  beforeLoad: ({ params, search }) => {
    if (!isAdminUserRouteId(params.userId) || !isAdminUserTab(params.tab)) {
      throw redirect({
        to: "/admin/$section",
        params: { section: "users" },
        search,
        replace: true,
      });
    }
  },
  component: () => {
    const { userId, tab } = adminUserDetailRoute.useParams();
    const search = adminUserDetailRoute.useSearch();
    return (
      <App
        initialView="admin"
        initialAdminSection="users"
        initialAdminSearch={search}
        initialAdminUserDetail={isAdminUserRouteId(userId) && isAdminUserTab(tab)
          ? { userId, tab }
          : undefined}
      />
    );
  },
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  setupRoute,
  pendingRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  verifyEmailRoute,
  publicShareRoute,
  adminUserDetailRoute,
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
