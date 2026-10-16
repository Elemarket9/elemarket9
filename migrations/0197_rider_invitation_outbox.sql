-- Provider-neutral, lease-based rider invitation outbox. Individual riders
-- still must authenticate and verify BOTH registered email and phone.
CREATE TABLE IF NOT EXISTS provider_rider_invitation_outbox (
 invitation_id text PRIMARY KEY REFERENCES provider_rider_invitations(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','accepted','failed','cancelled')),
 lease_token text,lease_expires_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 accepted_at timestamptz,provider_message_id text,
 last_error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rider_invitation_outbox_due ON provider_rider_invitation_outbox(status,next_attempt_at)
  WHERE status IN ('pending','processing','failed');
-- An expired pending invitation must not permanently block repeat invitations.
-- Expiry is reconciled transactionally by the invite creation code.
