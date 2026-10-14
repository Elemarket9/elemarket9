-- Flexible, audited company roles. Existing grants remain valid, no owner revoked.
-- Keep admin_staff_roles as one active assigned role per staff identity.
CREATE TABLE IF NOT EXISTS admin_roles (
  role_key text PRIMARY KEY CHECK (role_key ~ '^[a-z][a-z0-9_]{2,48}$'),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 3 AND 80),
  description text NOT NULL DEFAULT '',
  system_role boolean NOT NULL DEFAULT false,
  created_by text REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admin_roles(role_key,display_name,description,system_role) VALUES
 ('owner','Main Administrator','Protected platform main administrator role',true),
 ('operations','Marketplace Operations','Legacy operations privileges',true),
 ('support','Customer Support','Legacy customer support privileges',true)
ON CONFLICT (role_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_key text NOT NULL REFERENCES admin_roles(role_key) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN (
    'admin.full','admin.operations','admin.support',
    'admin.merchants.review','admin.merchants.moderate',
    'admin.customers.moderate','admin.products.moderate','admin.categories.manage',
    'admin.enterprise.manage','admin.providers.manage','admin.financing.manage',
    'admin.campaigns.manage','admin.audit.read','admin.staff.directory',
    'admin.finance.refunds','admin.finance.policy','admin.finance.view',
    'admin.staff.manage'
  )),
  PRIMARY KEY(role_key,capability)
);
INSERT INTO admin_role_permissions(role_key,capability) VALUES
 ('owner','admin.full'),
 ('operations','admin.operations'),
 ('operations','admin.merchants.review'),('operations','admin.merchants.moderate'),
 ('operations','admin.customers.moderate'),('operations','admin.products.moderate'),
 ('operations','admin.categories.manage'),
 ('support','admin.support')
ON CONFLICT DO NOTHING;
-- 0183 had an inline check constraint limiting roles to three; safely extend it.
ALTER TABLE admin_staff_roles DROP CONSTRAINT IF EXISTS admin_staff_roles_staff_role_check;
ALTER TABLE admin_staff_roles ADD CONSTRAINT admin_staff_roles_role_key_fk
  FOREIGN KEY (staff_role) REFERENCES admin_roles(role_key) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS admin_role_permissions_capability_idx ON admin_role_permissions(capability);
COMMENT ON TABLE admin_roles IS 'Organization job roles; role assignments are authorized and audited by the Main Administrator.';
COMMENT ON TABLE admin_role_permissions IS 'Allow-listed backend permissions; unknown capabilities fail closed. Owner role is protected.';

-- Extra company responsibilities can be assigned in addition to a primary job role.
-- Suspension of admin_staff_roles is the absolute account-wide kill switch.
CREATE TABLE IF NOT EXISTS admin_staff_extra_roles (
  user_id text NOT NULL REFERENCES admin_staff_roles(user_id) ON DELETE CASCADE,
  role_key text NOT NULL REFERENCES admin_roles(role_key) ON DELETE RESTRICT,
  assigned_by text NOT NULL REFERENCES "user"(id),
  assigned_reason text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,role_key),
  CONSTRAINT extra_role_never_owner CHECK (role_key <> 'owner')
);
CREATE INDEX IF NOT EXISTS admin_staff_extra_roles_role_idx ON admin_staff_extra_roles(role_key);
COMMENT ON TABLE admin_staff_extra_roles IS 'Additional audited company roles. Owner may only be granted as protected primary role.';
