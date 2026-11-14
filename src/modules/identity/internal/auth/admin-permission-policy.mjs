/**
 * Admin privileges use an explicit allow-list. Roles are customizable but
 * capability strings are reviewed code contracts, never client-defined APIs.
 * A protected Main Administrator is the only implicit superuser.
 */
export const ADMIN_CAPABILITIES = Object.freeze([
  'admin.operations', 'admin.support',
  'admin.merchants.review', 'admin.merchants.moderate',
  'admin.customers.moderate', 'admin.products.moderate', 'admin.categories.manage',
  'admin.enterprise.manage', 'admin.providers.manage', 'admin.financing.manage',
  'admin.campaigns.manage', 'admin.audit.read', 'admin.staff.directory',
  'admin.finance.refunds', 'admin.finance.policy', 'admin.finance.view',
  'admin.staff.manage',
  'admin.overview.view', 'admin.finance.payouts',
]);

/** Plain-language descriptions shown to the Main Administrator when defining roles. */
/** @type {Readonly<Record<string, string>>} */
export const ADMIN_CAPABILITY_LABELS = Object.freeze({
  'admin.operations': 'Marketplace operations (all merchant, customer, product and category moderation)',
  'admin.support': 'Customer support inbox, assisted orders and delivery holds',
  'admin.merchants.review': 'Review and approve merchant applications',
  'admin.merchants.moderate': 'Suspend or reinstate merchants; recalculate merchant health',
  'admin.customers.moderate': 'Suspend or reinstate customers',
  'admin.products.moderate': 'Approve, suspend or reinstate products',
  'admin.categories.manage': 'Turn catalogue categories on or off',
  'admin.enterprise.manage': 'Enterprise merchant onboarding',
  'admin.providers.manage': 'Payment, delivery and partner providers; delivery allocation',
  'admin.financing.manage': 'Customer and merchant financing providers',
  'admin.campaigns.manage': 'Homepage campaigns and advertising review',
  'admin.audit.read': 'Read the audit history',
  'admin.staff.directory': 'See the staff directory and role catalogue',
  'admin.staff.manage': 'Hire, suspend and assign roles (only within own permissions)',
  'admin.finance.refunds': 'Request and approve customer refunds',
  'admin.finance.policy': 'Set commission policy; move merchants to wallet payouts',
  'admin.finance.view': 'View commission policy and wallet reconciliation (read-only)',
  'admin.finance.payouts': 'Settle stuck merchant payouts and reconciliation exceptions',
  'admin.overview.view': 'Read-only marketplace overview (control-centre figures)',
});

/** A few legacy/managerial bundle grants expand into explicit backend capabilities. */
/** @type {Readonly<Record<string, readonly string[]>>} */
const IMPLIED = Object.freeze({
  'admin.operations': ['admin.merchants.review','admin.merchants.moderate',
    'admin.customers.moderate','admin.products.moderate','admin.categories.manage'],
  'admin.finance.policy': ['admin.finance.view'],
  'admin.staff.manage': ['admin.staff.directory'],
});

/** Expand stored grants before evaluating navigation, data projection or API access. */
/** @param {readonly string[]} grants */
export function expandAdminCapabilities(grants) {
  const found = new Set(/** @type {string[]} */ ([]));
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!ADMIN_CAPABILITIES.includes(grant)) continue;
    found.add(grant);
    for (const implied of IMPLIED[grant] ?? []) found.add(implied);
  }
  return [...found];
}

/** @param {string | null | undefined} role @param {string[]} grants @param {string} capability */
export function canGrantedAdminPerform(role, grants, capability) {
  if (role === 'owner') return capability === 'admin.full' || ADMIN_CAPABILITIES.includes(capability);
  if (capability === 'admin.full' || !ADMIN_CAPABILITIES.includes(capability)) return false;
  return expandAdminCapabilities(grants).includes(capability);
}

/** Manager may delegate only privileges already held, never Main Admin rights. */
/** @param {{actorOwner: boolean, actorCapabilities: string[], oldCapabilities: string[], nextCapabilities: string[], oldPrimaryRole: string, nextPrimaryRole: string}} input */
export function canDelegatedAdminManageRoles({ actorOwner, actorCapabilities, oldCapabilities,
  nextCapabilities, oldPrimaryRole, nextPrimaryRole }) {
  if (actorOwner) return true;
  const actor = new Set(expandAdminCapabilities(actorCapabilities));
  if (!actor.has('admin.staff.manage') || oldPrimaryRole === 'owner' || nextPrimaryRole === 'owner') return false;
  return [...oldCapabilities, ...nextCapabilities].every(p => actor.has(p));
}

/** Retain the original pure compatibility policy for existing verifications. */
/** @param {string | null | undefined} staffRole @param {string} capability */
export function canAdminPerform(staffRole, capability) {
  const baseline = staffRole === 'operations' ? ['admin.operations']
    : staffRole === 'support' ? ['admin.support'] : [];
  return canGrantedAdminPerform(staffRole, baseline, capability);
}
