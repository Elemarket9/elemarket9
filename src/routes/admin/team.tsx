import { createFileRoute, redirect } from "@tanstack/react-router";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { useState } from "react";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { loadAdminStaff, findAdminStaffByEmail, loadAdminRoles, saveAdminRole, updateAdminStaff } from "@/modules/administration/public/transport/admin/staff.functions";

export const Route = createFileRoute("/admin/team")({
  head: () => ({ meta: [{ title: "Team, company roles & delegation | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    if (!access.authenticated || !access.isAdmin ||
        !(access.capabilities.includes("admin.full") || (access.capabilities.includes("admin.staff.directory") || access.capabilities.includes("admin.staff.manage")))) {
      throw redirect({ to: "/admin" });
    }
    const [staff, catalogue] = await Promise.all([loadAdminStaff(), loadAdminRoles()]);
    return { staff, catalogue, access };
  },
  component: AdminTeam,
});

function AdminTeam() {
  const { staff: initialStaff, catalogue, access } = Route.useLoaderData();
  const [staff, setStaff] = useState(initialStaff);
  const [lookupEmail, setLookupEmail] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const isMainAdmin = access.staffRole === "owner";
  const canAssign = isMainAdmin || access.capabilities.includes("admin.staff.manage");
  const assignableRoles = catalogue.roles.filter(role => isMainAdmin ||
    (role.roleKey !== "owner" && role.permissions.every(permission => access.capabilities.includes(permission))));
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [extras, setExtras] = useState<Record<string, string[]>>({});
  const [statuses, setStatuses] = useState<Record<string, "active" | "suspended">>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function findStaff() {
    setError(null); setNotice(null); setLookingUp(true);
    try {
      const match = await findAdminStaffByEmail({data:{email:lookupEmail.trim()}});
      if (!match) { setNotice("No eligible verified employee account was found (or your role cannot provision staff)."); return; }
      setStaff(current => [match, ...current.filter(person => person.userId !== match.userId)]);
      setNotice("Verified account found. Assign reviewed permissions; staff must enroll 2FA before using the console.");
    } catch(e) { setError(e instanceof Error ? e.message : "Staff lookup failed"); }
    finally { setLookingUp(false); }
  }

  // Job titles are data, not a hardcoded enumeration. The Main Administrator
  // can create a new company role without requiring code or a deploy.
  const [roleKey, setRoleKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roleReason, setRoleReason] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);

  async function save(userId: string) {
    const person = staff.find(s => s.userId === userId);
    if (!person) return;
    const staffRole = roles[userId] ?? person.staffRole ?? assignableRoles[0]?.roleKey ?? "support";
    const extraRoles = extras[userId] ?? person.extraRoles ?? [];
    const status = statuses[userId] ?? (person.status as "active" | "suspended") ?? "active";
    const reason = reasons[userId]?.trim() ?? "";
    if (reason.length < 12) { setError("Provide a decision reason of at least 12 characters."); return; }
    setError(null); setNotice(null); setBusy(userId);
    try {
      await updateAdminStaff({ data: { userId, staffRole, extraRoles: extraRoles.filter(role => role !== staffRole), status, reason } });
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Staff delegation failed"); }
    finally { setBusy(null); }
  }

  function editRole(role: typeof catalogue.roles[number]) {
    if (role.roleKey === "owner") return;
    setRoleKey(role.roleKey);
    setDisplayName(role.displayName);
    setDescription(role.description);
    setPermissions(role.permissions);
    setRoleReason("");
    document.getElementById("role-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveRole() {
    if (roleReason.trim().length < 12) { setError("Explain this role/permission decision in at least 12 characters."); return; }
    setError(null); setNotice(null); setRoleBusy(true);
    try {
      await saveAdminRole({ data: { roleKey, displayName, description, permissions, reason: roleReason.trim() } });
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Role configuration failed"); }
    finally { setRoleBusy(false); }
  }

  return <main className="mx-auto max-w-7xl px-4 py-8">
    <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
    <header className="rounded-3xl border border-market-line bg-white p-6 shadow-sm">
      <p className="text-xs font-black uppercase tracking-widest text-market-muted">Company administration and delegation</p>
      <h1 className="mt-2 text-3xl font-black">Team, roles & permissions</h1>
      <p className="mt-2 text-sm text-market-muted">ELEMARKET's Main Administrator sets company roles and can delegate real operating authority to HR, supervisors, finance, support and other managers. Staff do not need the CEO online to do authorized work. Every change is checked server-side and recorded. Each administrator uses their own verified account and 2FA.</p>
    </header>
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-4 font-bold text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-4 rounded-xl bg-green-50 p-4 text-green-800">{notice}</p>}

    <section className="mt-7 rounded-2xl border border-market-line bg-white p-5" aria-labelledby="role-catalogue">
      <h2 id="role-catalogue" className="text-xl font-black">Company roles ({catalogue.roles.length})</h2>
      <p className="mt-2 text-sm text-market-muted">A role is a job responsibility with explicit permissions. An employee can also hold additional roles. A custom role never automatically becomes a Main Administrator.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {catalogue.roles.map(role => <article key={role.roleKey} className="rounded-xl border border-market-line p-4">
          <h3 className="font-black">{role.displayName}</h3>
          <p className="mt-1 text-xs text-market-muted">{role.roleKey} · {role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}</p>
          <p className="mt-2 text-sm">{role.description || "No description provided"}</p>
          <p className="mt-2 text-xs text-market-muted">{role.roleKey === "owner" ? "Protected Main Admin" : role.systemRole ? "Existing role (editable)" : "Custom company role"}</p>
          {isMainAdmin && role.roleKey !== "owner" && <button onClick={() => editRole(role)} type="button" className="mt-3 rounded-lg border border-market-line px-3 py-2 text-sm font-bold">Edit responsibilities</button>}
        </article>)}
      </div>
    </section>

    {isMainAdmin && <section id="role-editor" className="mt-7 rounded-2xl border border-market-line bg-white p-5" aria-label="Define a company role">
      <h2 className="text-xl font-black">Create or edit a company role</h2>
      <p className="mt-1 text-sm text-market-muted">Examples: HR Manager, Regional Supervisor, Finance Manager, Merchant Quality Lead. Permission codes represent reviewed backend operations, not arbitrary API access. Main Administrator remains protected.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm font-bold">Role key<input required value={roleKey} onChange={e => setRoleKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} maxLength={49} placeholder="regional_supervisor" className="mt-1 w-full rounded-xl border p-3" /></label>
        <label className="text-sm font-bold">Job title<input required value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={80} placeholder="Regional Supervisor" className="mt-1 w-full rounded-xl border p-3" /></label>
        <label className="text-sm font-bold md:col-span-2">Job responsibilities<input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} placeholder="Supervise assigned marketplace moderation and customer escalations" className="mt-1 w-full rounded-xl border p-3" /></label>
      </div>
      <fieldset className="mt-5"><legend className="font-black">What this role may do</legend><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {catalogue.availablePermissions.map(permission => <label key={permission} className="flex items-start gap-2 rounded-lg border border-market-line p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={permissions.includes(permission)} onChange={e => setPermissions(current => e.target.checked ? [...current, permission] : current.filter(p => p !== permission))} />
          <span className="break-words font-medium">{permission}</span>
        </label>)}
      </div></fieldset>
      <label className="mt-5 block text-sm font-bold">Reason for this role or permission change<textarea value={roleReason} onChange={e => setRoleReason(e.target.value)} minLength={12} maxLength={1000} rows={2} className="mt-1 w-full rounded-xl border p-3" /></label>
      <div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={roleBusy || roleKey.length < 3 || displayName.length < 3} onClick={() => void saveRole()} className="rounded-xl bg-market-green px-5 py-3 text-sm font-black text-white disabled:opacity-50">{roleBusy ? "Saving…" : "Save role and audit changes"}</button>
        <button type="button" className="rounded-xl border px-5 py-3 text-sm font-bold" onClick={() => { setRoleKey(""); setDisplayName(""); setDescription(""); setPermissions([]); setRoleReason(""); }}>Create new role</button></div>
    </section>}

    <section className="mt-7 rounded-2xl border border-market-line bg-white p-5" aria-label="Find an administrator">
      <h2 className="text-lg font-black">Find or provision a staff member</h2>
      <p className="mt-1 text-sm text-market-muted">Search by exact verified email. Authorized staff managers can promote an existing customer identity to an employee account with an audited role assignment. Accounts holding active merchant memberships are excluded. Staff must enroll 2FA before entering the console.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <input type="email" autoComplete="off" value={lookupEmail} onChange={event=>setLookupEmail(event.target.value)} placeholder="employee@company.com" aria-label="Verified employee email to find" className="min-w-0 flex-1 rounded-xl border p-3" />
        <button type="button" disabled={lookingUp || !lookupEmail.includes("@")} onClick={()=>void findStaff()} className="rounded-xl bg-market-green px-5 py-3 font-bold text-white disabled:opacity-50">{lookingUp ? "Searching…" : "Find staff"}</button>
      </div>
    </section>
    <section className="mt-7 space-y-4" aria-label="Administrative staff"><h2 className="text-xl font-black">Staff access and delegated responsibilities</h2>
      {staff.map(person => {
        const currentPrimary = roles[person.userId] ?? person.staffRole ?? assignableRoles[0]?.roleKey ?? "support";
        const currentExtras = extras[person.userId] ?? person.extraRoles ?? [];
        return <article key={person.userId} className="rounded-2xl border border-market-line bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-black">{person.name}</h3><p className="text-sm text-market-muted">{person.email}</p></div>
            <div className="flex flex-wrap gap-2 text-xs font-bold"><span className="rounded-full bg-market-soft px-3 py-1">{person.staffRole ?? "Unassigned"}</span><span className="rounded-full bg-market-soft px-3 py-1">{person.status ?? "Unassigned"}</span><span className="rounded-full bg-market-soft px-3 py-1">2FA: {person.twoFactorEnabled ? "Enabled" : "Required"}</span></div>
          </div>
          {(canAssign && (isMainAdmin || person.staffRole !== "owner")) ? <div className="mt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm font-bold">Primary company role<select aria-label={`Primary role for ${person.email}`} className="mt-1 block w-full rounded-xl border p-3" value={currentPrimary} onChange={e => setRoles(x => ({ ...x, [person.userId]: e.target.value }))}>
                {assignableRoles.map(role => <option key={role.roleKey} value={role.roleKey}>{role.displayName}</option>)}
              </select></label>
              <label className="text-sm font-bold">Account status<select aria-label={`Status for ${person.email}`} className="mt-1 block w-full rounded-xl border p-3" value={statuses[person.userId] ?? person.status ?? "active"} onChange={e => setStatuses(x => ({ ...x, [person.userId]: e.target.value as "active" | "suspended" }))}><option value="active">Active</option><option value="suspended">Suspended — block all admin privileges</option></select></label>
            </div>
            <fieldset><legend className="text-sm font-bold">Additional company responsibilities</legend><div className="mt-2 flex flex-wrap gap-2">{assignableRoles.filter(role => role.roleKey !== "owner" && role.roleKey !== currentPrimary).map(role => <label key={role.roleKey} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"><input type="checkbox" checked={currentExtras.includes(role.roleKey)} onChange={e => setExtras(x => ({ ...x, [person.userId]: e.target.checked ? [...currentExtras, role.roleKey] : currentExtras.filter(key => key !== role.roleKey) }))} />{role.displayName}</label>)}</div></fieldset>
            <label className="block text-sm font-bold">Reason for this staff-access change<input value={reasons[person.userId] ?? ""} onChange={e => setReasons(x => ({ ...x, [person.userId]: e.target.value }))} maxLength={1000} placeholder="Document delegation, transfer, leave or suspension" className="mt-1 block w-full rounded-xl border p-3" /></label>
            <button type="button" disabled={busy !== null} onClick={() => void save(person.userId)} className="rounded-xl bg-market-green px-4 py-3 text-sm font-black text-white disabled:opacity-50">{busy === person.userId ? "Saving…" : "Apply and audit assignment"}</button>
          </div> : <p className="mt-3 text-sm text-market-muted">You can view this team member; assignment changes require a separate staff-management grant.</p>}
          {person.staffRole === "owner" && <p className="mt-3 text-xs text-market-muted">A different Main Administrator may change this account, but the last active Main Administrator cannot be suspended.</p>}
        </article>;
      })}
    </section>
  </main>;
}
