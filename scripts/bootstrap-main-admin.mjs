#!/usr/bin/env node
/** One-time trusted console operation, never reachable from HTTP. */
import { fileURLToPath } from 'node:url';
export function validBootstrapInputs({ email, reason, approval }) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    typeof reason === 'string' && reason.trim().length >= 16 && reason.trim().length <= 500 &&
    approval === 'BOOTSTRAP_FIRST_MAIN_ADMIN';
}
export async function bootstrap(client, { email, reason }) {
  await client.query('BEGIN');
  try {
    await client.query(`lock table admin_staff_roles in share row exclusive mode`);
    const owners = (await client.query(
      `select user_id from admin_staff_roles where staff_role='owner' limit 1`)).rows;
    const flaggedAdmins = (await client.query(`select id from "user" where role='admin' limit 1`)).rows;
    if (owners.length || flaggedAdmins.length) throw new Error('A legacy admin/owner already exists. Use reviewed staff management; bootstrap forbidden.');
    const users = (await client.query(
      `select id,role,"emailVerified" as "emailVerified" from "user" where lower(email)=lower($1) for update`, [email])).rows;
    const user = users[0];
    if (!user || user.role !== 'customer' || !user.emailVerified) throw new Error('Verified existing customer required');
    const linked = (await client.query(
      `select merchant_id from merchant_accounts where user_id=$1 and status='active' limit 1`, [user.id])).rows;
    if (linked.length) throw new Error('Cannot convert an active merchant account');
    await client.query(`update "user" set role='admin',"updatedAt"=now() where id=$1`, [user.id]);
    await client.query(`delete from "session" where "userId"=$1`, [user.id]);
    await client.query(`insert into admin_staff_roles(user_id,staff_role,status,assigned_reason)
        values($1,'owner','active',$2)`, [user.id,reason]);
    await client.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
      'admin.bootstrap.owner','admin_staff_role',user.id,user.id,'admin',null,'success',
      JSON.stringify({reason,method:'trusted_console_first_owner'})]);
    await client.query('COMMIT');
    return user.id;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}
const self = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (self) {
  const email = process.env.ELEMARKET_BOOTSTRAP_EMAIL?.trim();
  const reason = process.env.ELEMARKET_BOOTSTRAP_REASON?.trim();
  const approval = process.env.ELEMARKET_BOOTSTRAP_APPROVAL;
  if (!validBootstrapInputs({email,reason,approval})) throw new Error('Supply reviewed ELEMARKET_BOOTSTRAP_EMAIL, ELEMARKET_BOOTSTRAP_REASON (>=16 chars), and ELEMARKET_BOOTSTRAP_APPROVAL=BOOTSTRAP_FIRST_MAIN_ADMIN');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const client = await pool.connect();
  try { const userId = await bootstrap(client,{email,reason}); console.log(`Bootstrapped first Main Admin: ${userId}. Staff must enable TOTP and sign in again before privileged actions.`); }
  finally { client.release(); await pool.end(); }
}
