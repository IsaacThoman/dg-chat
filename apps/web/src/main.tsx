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
  useRouterState,
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
import { PwaUpdateNotice } from "./PwaUpdateNotice.tsx";
import { parseCommunitySearch } from "./communityRouting.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import "./styles.css";

const rootRoute = createRootRoute({ component: () => <Outlet /> });
function WorkspaceShell() {
  const location = useRouterState({ select: (state) => state.location });
  const path = location.pathname;
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const search = location.search as Record<string, unknown>;
  const adminUserDetail = parts.length === 4 && parts[0] === "admin" && parts[1] === "users" &&
      isAdminUserRouteId(parts[2]) && isAdminUserTab(parts[3])
    ? { userId: parts[2], tab: parts[3] }
    : undefined;
  const routeAdminSection = parts[1] ?? "";
  const adminSection = parts[0] === "admin" && isAdminSection(routeAdminSection)
    ? routeAdminSection
    : "overview";
  const initialView = path === "/community"
    ? "community"
    : path === "/archived"
    ? "archived"
    : path === "/trash"
    ? "trash"
    : path === "/knowledge"
    ? "knowledge"
    : path === "/settings"
    ? "settings"
    : path === "/tokens"
    ? "tokens"
    : parts[0] === "admin"
    ? "admin"
    : "chat";

  return (
    <App
      initialView={initialView}
      initialAdminSection={adminSection}
      initialAdminSearch={parseAdminSearch(search)}
      initialAdminUserDetail={adminUserDetail}
      initialCommunitySearch={parseCommunitySearch(search)}
    />
  );
}

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "workspace",
  component: WorkspaceShell,
});
const emptyWorkspaceRoute = () => null;
const indexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/",
  component: emptyWorkspaceRoute,
});
const communityRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/community",
  validateSearch: parseCommunitySearch,
  component: emptyWorkspaceRoute,
});
const archivedRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/archived",
  component: emptyWorkspaceRoute,
});
const trashRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/trash",
  component: emptyWorkspaceRoute,
});
const knowledgeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/knowledge",
  component: emptyWorkspaceRoute,
});
const settingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/settings",
  component: emptyWorkspaceRoute,
});
const tokensRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/tokens",
  component: emptyWorkspaceRoute,
});
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
  getParentRoute: () => workspaceRoute,
  path: "/admin/$section",
  validateSearch: parseAdminSearch,
  component: emptyWorkspaceRoute,
});
const adminUserDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
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
  component: emptyWorkspaceRoute,
});
const workspaceTree = workspaceRoute.addChildren([
  indexRoute,
  communityRoute,
  archivedRoute,
  trashRoute,
  knowledgeRoute,
  settingsRoute,
  tokensRoute,
  adminUserDetailRoute,
  adminRoute,
]);
const routeTree = rootRoute.addChildren([
  workspaceTree,
  loginRoute,
  setupRoute,
  pendingRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  verifyEmailRoute,
  publicShareRoute,
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
      <TooltipProvider>
        <RouterProvider router={router} />
        <PwaUpdateNotice />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
