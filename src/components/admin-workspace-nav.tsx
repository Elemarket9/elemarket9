import { useEffect, useState } from "react";
import { getAdminAccessState, type AdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";

/** Navigation is not a security boundary. Every destination has server checks. */
const links: Array<{ href: string; label: string; permissions: string[] }> = [
  { href: "/admin/dashboard", label: "Main control centre", permissions: ["admin.full"] },
  { href: "/admin/operations", label: "Marketplace operations", permissions: ["admin.operations", "admin.merchants.review", "admin.merchants.moderate", "admin.products.moderate", "admin.customers.moderate", "admin.categories.manage"] },
  { href: "/admin/support", label: "Support inbox", permissions: ["admin.support"] },
  { href: "/admin/partners", label: "Providers & delivery", permissions: ["admin.providers.manage"] },
  { href: "/admin/enterprise", label: "Enterprise merchants", permissions: ["admin.enterprise.manage"] },
  { href: "/admin/financing", label: "Financing", permissions: ["admin.financing.manage"] },
  { href: "/admin/campaigns", label: "Campaigns & advertising", permissions: ["admin.campaigns.manage"] },
  { href: "/admin/commissions", label: "Commission policy", permissions: ["admin.finance.view", "admin.finance.policy"] },
  { href: "/admin/refunds", label: "Refund requests", permissions: ["admin.finance.refunds"] },
  { href: "/admin/team", label: "Team, HR & permissions", permissions: ["admin.staff.directory", "admin.staff.manage"] },
  { href: "/admin/activity", label: "Audit history", permissions: ["admin.audit.read"] },
];

export function AdminWorkspaceNav({ staffRole, capabilities }: {
  staffRole: AdminAccessState["staffRole"];
  capabilities?: readonly string[];
}) {
  const [loadedCapabilities, setLoadedCapabilities] = useState<readonly string[]>(capabilities ?? []);
  const [resolvedRole, setResolvedRole] = useState<string | null>(staffRole);
  useEffect(() => {
    if (capabilities) { setLoadedCapabilities(capabilities); setResolvedRole(staffRole); return; }
    let active = true;
    void getAdminAccessState().then(access => {
      if (active) { setLoadedCapabilities(access.capabilities); setResolvedRole(access.staffRole); }
    }).catch(() => { if (active) setLoadedCapabilities([]); });
    return () => { active = false; };
  }, [capabilities]);
  if (!resolvedRole) return null;
  const mainAdmin = resolvedRole === "owner";
  const allowed = (permission: string) => mainAdmin || loadedCapabilities.includes(permission);
  return <nav aria-label="Administration sections" className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-market-line bg-white p-3 text-xs font-bold sm:text-sm">
    {links.filter(link => link.permissions.some(allowed)).map(link =>
      <a key={link.href} href={link.href} className="rounded-lg border border-market-line px-3 py-2 text-market-ink hover:border-market-green focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-market-green">{link.label}</a>)}
    <a href="/admin/security" className="rounded-lg border border-market-line px-3 py-2 text-market-muted hover:text-market-ink">Account security</a>
  </nav>;
}
