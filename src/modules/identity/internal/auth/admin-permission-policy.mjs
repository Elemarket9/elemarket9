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
]);

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
