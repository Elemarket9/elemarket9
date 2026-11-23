import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { AdminSupportWorkspace } from "@/components/admin-support-workspace";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";

export const Route = createFileRoute("/admin/support")({
  loader: async () => {
    const access = await getAdminAccessState();
    const can = (permission: string) => access.staffRole === "owner" || access.capabilities.includes(permission);
    // Reading accepts either permission; the server re-checks on every request.
    if (!(can("admin.support") || can("admin.support.view"))) throw redirect({ to: "/admin" });
    return { staffRole: access.staffRole, capabilities: access.capabilities, canReply: can("admin.support") };
  },
  component: AdminSupport,
});

function AdminSupport() {
  const { staffRole, capabilities, canReply } = Route.useLoaderData();
  return <main className="mx-auto max-w-7xl px-4 py-8"><AdminWorkspaceNav staffRole={staffRole} capabilities={capabilities} /><h1 className="mb-5 text-2xl font-black">Support Inbox</h1><AdminSupportWorkspace canReply={canReply} /></main>;
}
