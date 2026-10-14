-- Move facial login to face + passphrase only. Preserve legacy device tables for rollback/audit.
-- No destructive migration, no device key requirement for newly minted biometric sessions.
ALTER TABLE executive_face_session_assurance ALTER COLUMN device_id DROP NOT NULL;
ALTER TABLE executive_face_session_assurance DROP CONSTRAINT IF EXISTS executive_face_session_assurance_method_check;
ALTER TABLE executive_face_session_assurance ADD CONSTRAINT executive_face_session_assurance_method_check
  CHECK (method IN ('face-passphrase-device','face-passphrase'));
ALTER TABLE executive_face_session_assurance ALTER COLUMN method SET DEFAULT 'face-passphrase';

-- Legacy software-key sessions must not remain valid after the factor is retired.
UPDATE "session" SET "expiresAt" = now()
 WHERE id IN (SELECT session_id FROM executive_face_session_assurance WHERE method = 'face-passphrase-device');
