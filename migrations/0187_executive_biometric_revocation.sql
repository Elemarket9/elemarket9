-- Executive emergency biometric shutoff; do not alter historical migrations.
ALTER TABLE executive_face_events DROP CONSTRAINT IF EXISTS executive_face_events_event_type_check;
ALTER TABLE executive_face_events ADD CONSTRAINT executive_face_events_event_type_check
 CHECK (event_type IN ('enrolled','device_added','device_revoked',
  'login_succeeded','login_rejected','locked','disabled','profile_deleted'));
CREATE INDEX IF NOT EXISTS executive_face_challenges_user_window_idx
 ON executive_face_challenges(user_id,created_at DESC);
