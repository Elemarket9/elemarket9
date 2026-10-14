import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { AdminSupportWorkspace } from "@/components/admin-support-workspace";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";

export const Route = createFileRoute("/admin/support")({
  loader: async () => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.support"))) throw redirect({ to: "/admin" });
    return {staffRole:access.staffRole};
  },
  component: AdminSupport,
});

function AdminSupport() {
  return <main className="mx-auto max-w-7xl px-4 py-8"><AdminWorkspaceNav staffRole={Route.useLoaderData().staffRole} /><h1 className="mb-5 text-2xl font-black">Support Inbox</h1><AdminSupportWorkspace /></main>;
}
