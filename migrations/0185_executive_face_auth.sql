-- Executive-only authentication. No face images or biometric embeddings stored in marketplace DB.
CREATE TABLE IF NOT EXISTS executive_face_profiles (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  verifier_reference text NOT NULL,
  passphrase_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 100),
  locked_until timestamptz,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS executive_face_devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES executive_face_profiles(user_id) ON DELETE CASCADE,
  public_jwk jsonb NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS executive_face_devices_active_idx ON executive_face_devices(user_id,revoked_at);
CREATE TABLE IF NOT EXISTS executive_face_challenges (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('login','enroll','add-device')),
  nonce text NOT NULL,
  prompt text NOT NULL,
  device_id text,
  ip_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS executive_face_challenges_throttle_idx ON executive_face_challenges(ip_digest,created_at DESC);
CREATE INDEX IF NOT EXISTS executive_face_challenges_expiry_idx ON executive_face_challenges(expires_at);
CREATE TABLE IF NOT EXISTS executive_face_session_assurance (
  session_id text PRIMARY KEY REFERENCES "session"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES executive_face_devices(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL DEFAULT 'face-passphrase-device' CHECK (method='face-passphrase-device')
);
CREATE TABLE IF NOT EXISTS executive_face_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('enrolled','device_added','device_revoked','login_succeeded','login_rejected','locked')),
  device_id text,
  ip_digest text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS executive_face_events_actor_idx ON executive_face_events(user_id,created_at DESC);
