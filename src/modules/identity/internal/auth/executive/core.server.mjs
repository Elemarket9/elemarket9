/** Executive identity policy and challenge state machine. Login never accepts a client face score. */
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { getSql, withTransaction } from '../../../../../lib/db';
import { getPortalConfiguration, portalFromRequestHost } from '../../../../../lib/security/portal-policy.mjs';
import { faceEngineConfigured, verifyLiveFace, removeOrphanFaceReference } from './engine.server.mjs';
import { newChallenge, hashExecutivePassphrase, verifyExecutivePassphrase } from './security.mjs';

function executiveConfig() {
  const config = getPortalConfiguration();
  if (!config) throw new Error('Executive portal routing is required');
  return config;
}
export function requireExecutiveHost(request) {
  const config = executiveConfig();
  if (portalFromRequestHost(request.headers.get('host')) !== 'executive') throw new Error('Executive portal required');
  return config;
}
async function activeExecutive(sql,userId) {
  const roles = await sql.query(`select 1 from "user" u join admin_staff_roles a on a.user_id=u.id
    where u.id=$1 and u.role='admin' and a.staff_role='owner' and a.status='active' limit 1`,[userId]);
  return roles.length > 0;
}
async function assertOwner(sql,config) {
  if (!await activeExecutive(sql,config.executiveUserId)) throw new Error('Executive authentication not available');
}
function clientIpDigest(request) {
  // Only trust this header when the service is never publicly exposed bypassing Caddy.
  const ip = request.headers.get('x-forwarded-for') || 'unavailable';
  const secret = process.env.BETTER_AUTH_SECRET || '';
  return createHash('sha256').update(secret+':'+ip.slice(0,120)).digest('hex');
}
export async function createExecutiveChallenge(request,{operation}) {
  const config = requireExecutiveHost(request);
  if (!faceEngineConfigured()) throw new Error('Executive biometric verification unavailable');
  if (!['login','enroll'].includes(operation)) throw new Error('Invalid operation');
  const sql = await getSql();
  await assertOwner(sql,config);
  const userId = config.executiveUserId;
  const ipDigest = clientIpDigest(request);
  // Serialize issuance across worker processes. The previous count-then-insert
  // was raceable and let any single IP exhaust a shared 12-challenge owner limit.
  // Per-IP and global ceilings are independent; the shared ceiling is a backstop,
  // not a trivial 12-request denial of service against the sole executive.
  return withTransaction(async tx => {
    // Lock the persisted executive account row: portable to PostgreSQL and
    // PGlite and serializes challenge issuance without process-local state.
    const ownerLock = await tx.query('select id from "user" where id=$1 for update', [userId]);
    if (!ownerLock.length) throw new Error('Executive account unavailable');
    const counts = await tx.query(`select
        count(*) filter (where ip_digest=$1)::integer as per_ip,
        count(*)::integer as total
      from executive_face_challenges
      where user_id=$2 and created_at>now()-interval '10 minutes'`,[ipDigest,userId]);
    if (Number(counts[0]?.per_ip) >= 8 || Number(counts[0]?.total) >= 160)
      throw new Error('Too many authentication attempts');
    const profile = await tx.query(`select enabled,locked_until from executive_face_profiles where user_id=$1`,[userId]);
    if (operation === 'login') {
      if (!profile[0]?.enabled || (profile[0].locked_until && Date.parse(String(profile[0].locked_until)) > Date.now())) throw new Error('Executive authentication unavailable');
    }
    if (operation === 'enroll' && profile.length) throw new Error('Executive face profile already exists; use authorized recovery to reset it.');
    const nonce = newChallenge(); const id = randomUUID();
    const prompt = ['turn_left','turn_right','blink'][randomInt(3)];
    await tx.query(`insert into executive_face_challenges(id,user_id,operation,nonce,prompt,ip_digest,expires_at)
      values($1,$2,$3,$4,$5,$6,now()+interval '90 seconds')`,[id,userId,operation,nonce,prompt,ipDigest]);
    return {id,nonce,prompt,expiresInSeconds:90};
  });
}
export async function takeExecutiveChallenge(request,{id,operation}) {
  const config = requireExecutiveHost(request);
  if (!faceEngineConfigured()) throw new Error('Executive biometric verification unavailable');
  const sql = await getSql();
  // Bind the originating network before consuming. A forged/mismatched request
  // must not burn a legitimate challenge that it did not create.
  const rows = await sql.query(`update executive_face_challenges set consumed_at=now()
    where id=$1 and user_id=$2 and operation=$3 and ip_digest=$4
      and consumed_at is null and expires_at>now()
    returning id,nonce,prompt`,[id,config.executiveUserId,operation,clientIpDigest(request)]);
  if (!rows.length) throw new Error('Challenge expired, already used, or originated elsewhere');
  return { ...rows[0], userId:config.executiveUserId, sql };
}
export async function enrollExecutiveProfile(request,{challengeId,frames,pin}) {
  const challenge = await takeExecutiveChallenge(request,{id:challengeId,operation:'enroll'});
  const secretHash = await hashExecutivePassphrase(pin);
  const faceReference = await verifyLiveFace({operation:'enroll',challengeId,nonce:challenge.nonce,prompt:challenge.prompt,frames});
  // Bootstrap is authorized separately by the existing Better Auth + TOTP session.
  // No per-device key is enrolled; face/PIN remains available across browsers.
  try {
    await withTransaction(async tx => {
      await tx.query(`insert into executive_face_profiles(user_id,verifier_reference,passphrase_hash,enabled)
        values($1,$2,$3,true)`,[challenge.userId,faceReference,secretHash]);
      await writeEvent(tx,challenge.userId,'enrolled');
    });
  } catch (error) {
    try { await removeOrphanFaceReference(faceReference); }
    catch { /* operator reconciliation required if cleanup fails */ }
    throw error;
  }
  return {ok:true};
}
async function writeEvent(sql,userId,eventType) {
  // Never store biometric captures or the secret passphrase in audit records.
  await sql.query(`insert into executive_face_events(id,user_id,event_type) values($1,$2,$3)`,
    [randomUUID(),userId,eventType]);
}
export async function verifyExecutiveLogin(request,{challengeId,frames,pin}) {
  const challenge = await takeExecutiveChallenge(request,{id:challengeId,operation:'login'});
  const sql = challenge.sql;
  const rows = await sql.query(`select passphrase_hash,verifier_reference,locked_until from executive_face_profiles
    where user_id=$1 and enabled=true`,[challenge.userId]);
  if (!rows.length || (rows[0].locked_until && Date.parse(String(rows[0].locked_until)) > Date.now())) throw new Error('Authentication failed');
  // Always assess both factors. The old PIN-first short circuit exposed a
  // network timing oracle for guessing the executive's private passphrase:
  // correct PIN incurred a much slower face-verifier round trip.
  const factors = await Promise.allSettled([
    verifyExecutivePassphrase(pin,rows[0].passphrase_hash),
    verifyLiveFace({operation:'login',challengeId,nonce:challenge.nonce,prompt:challenge.prompt,
      frames,reference:rows[0].verifier_reference}),
  ]);
  if (factors[0].status !== 'fulfilled' || factors[0].value !== true ||
      factors[1].status !== 'fulfilled') {
    await withTransaction(async tx => {
      await tx.query(`update executive_face_profiles set failed_attempts=least(failed_attempts+1,100),
        locked_until=case when failed_attempts>=4 then now()+interval '15 minutes' else locked_until end
        where user_id=$1`,[challenge.userId]);
      await writeEvent(tx,challenge.userId,'login_rejected');
    });
    throw new Error('Authentication failed');
  }
  // Independent account/role enforcement: an enrolled face must never revive suspended admin access.
  if (!await activeExecutive(sql,challenge.userId)) throw new Error('Executive account inactive');
  await withTransaction(async tx => {
    await tx.query(`update executive_face_profiles set failed_attempts=0,locked_until=null where user_id=$1`,[challenge.userId]);
    await writeEvent(tx,challenge.userId,'login_succeeded');
  });
  return {userId: challenge.userId};
}

/**
 * Emergency executive biometric revocation. This operation can run even if the
 * recognition engine is offline or explicitly disabled in production. A fresh
 * password/TOTP-origin executive session is required by the API route.
 * Disable + session invalidation is atomic; remote template deletion is a
 * separate best-effort step so bridge downtime never prevents revocation.
 */
export async function revokeExecutiveFaceProfile(request) {
  const config = requireExecutiveHost(request);
  const sql = await getSql();
  await assertOwner(sql,config);
  const rows = await withTransaction(async tx => {
    const profile = await tx.query(`select verifier_reference from executive_face_profiles
      where user_id=$1 for update`,[config.executiveUserId]);
    if (!profile.length) return [];
    await tx.query(`update executive_face_profiles set enabled=false,updated_at=now()
      where user_id=$1`,[config.executiveUserId]);
    await tx.query(`update "session" set "expiresAt"=now() where id in (
      select session_id from executive_face_session_assurance
        where user_id=$1 and method like 'face-passphrase%')`,[config.executiveUserId]);
    await writeEvent(tx,config.executiveUserId,'disabled');
    return profile;
  });
  if (!rows.length) return {disabled:true,templateCleanupPending:false};
  try {
    await removeOrphanFaceReference(rows[0].verifier_reference);
  } catch {
    // Leave the profile disabled in DB and its opaque reference available for
    // later, explicitly authorized cleanup; NEVER re-enable automatically.
    return {disabled:true,templateCleanupPending:true};
  }
  await withTransaction(async tx => {
    await tx.query(`delete from executive_face_profiles where user_id=$1 and enabled=false
      and verifier_reference=$2`,[config.executiveUserId,rows[0].verifier_reference]);
    await writeEvent(tx,config.executiveUserId,'profile_deleted');
  });
  return {disabled:true,templateCleanupPending:false};
}
