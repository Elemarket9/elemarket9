/** UI destination only; backend authorization is still enforced independently. */
export function adminDefaultRoute(access: { staffRole: string | null; capabilities: string[] }): string {
  const has = (cap:string) => access.staffRole === 'owner' || access.capabilities.includes(cap);
  if (has('admin.full')) return '/admin/dashboard';
  if (['admin.operations','admin.merchants.review','admin.merchants.moderate',
       'admin.customers.moderate','admin.products.moderate','admin.categories.manage'].some(has)) return '/admin/operations';
  if (has('admin.support')) return '/admin/support';
  if (has('admin.providers.manage')) return '/admin/partners';
  if (has('admin.enterprise.manage')) return '/admin/enterprise';
  if (has('admin.financing.manage')) return '/admin/financing';
  if (has('admin.campaigns.manage')) return '/admin/campaigns';
  if (has('admin.finance.view') || has('admin.finance.policy')) return '/admin/commissions';
  if (has('admin.finance.refunds')) return '/admin/refunds';
  if (has('admin.staff.directory') || has('admin.staff.manage')) return '/admin/team';
  if (has('admin.audit.read')) return '/admin/activity';
  return '/admin/security';
}
