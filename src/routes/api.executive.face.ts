import { createFileRoute } from '@tanstack/react-router';
import { getSessionUser, requireFreshSession } from '@/modules/identity/public/auth/verify.server';
import { requireAdminForUserId } from '@/modules/identity/public/auth/authorization.server';
import { getSql } from '@/lib/db';
import { auth } from '@/modules/identity/public/auth/server';
import { getRequest } from '@tanstack/react-start/server';
import { requireSameOrigin, faceEngineConfigured, requireExecutiveHost, createExecutiveChallenge, enrollExecutiveProfile, revokeExecutiveFaceProfile } from '@/modules/identity/public/auth/executive/server';

const noStore = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
import { readBodyWithLimit } from '@/lib/security/body.server';

async function readJson(request: Request): Promise<Record<string,unknown>> {
  const raw = await readBodyWithLimit(request, 2_200_000, 10_000);
  if (!raw) throw new Error('Invalid request');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request');
  return value as Record<string,unknown>;
}
function data(value: unknown, status=200) { return Response.json(value,{status,headers:noStore}); }
async function requireOwnerFresh(request: Request): Promise<string> {
  const conf = requireExecutiveHost(request);
  const user = await getSessionUser();
  if (!user || user.id !== conf.executiveUserId) throw new Error('Executive account required');
  if (await requireFreshSession(undefined, 10*60) !== conf.executiveUserId) throw new Error('Fresh sign-in required');
  await requireAdminForUserId(user.id);
  // Executive profile enrollment/revocation is a recovery-class operation.
  // A fresh biometric-created session must NEVER count as the required
  // independent Better Auth credential + authenticator recovery path.
  const currentRequest = getRequest();
  if (!currentRequest) throw new Error('Executive session unavailable');
  const session = await auth.api.getSession({headers:currentRequest.headers});
  if (!session?.session || !session.user || session.user.id !== user.id) throw new Error('Executive session unavailable');
  const sql = await getSql();
  const provenance = await sql.query<{method:string}>(`select method from executive_face_session_assurance
    where session_id=$1 and user_id=$2 limit 1`,[session.session.id,user.id]);
  if (provenance.some(row => row.method.startsWith('face-passphrase')))
    throw new Error('Use your independent password + authenticator session');
  return user.id;
}
export const Route = createFileRoute('/api/executive/face')({
  server: { handlers: {
    GET: async ({request}) => {
      try {
        const conf = requireExecutiveHost(request);
        const user = await getSessionUser();
        const enrolled = user?.id === conf.executiveUserId
          ? await (async () => {
              const sql = await getSql();
              const rows = await sql.query<{enabled:boolean}>(`select enabled from executive_face_profiles where user_id=$1`,[user.id]);
              return Boolean(rows[0]?.enabled);
            })() : false;
        return data({available:faceEngineConfigured(),enrolled});
      } catch { return data({available:false,enrolled:false}); }
    },
    POST: async ({request}) => {
      try {
        const conf = requireExecutiveHost(request);
        requireSameOrigin(request,conf.hosts.executive);
        const body = await readJson(request);
        const action = body.action;
        if (action === 'start-login') {
          return data(await createExecutiveChallenge(request,{operation:'login'}));
        }
        if (action === 'disable-face-profile') {
          await requireOwnerFresh(request);
          return data(await revokeExecutiveFaceProfile(request));
        }
        if (action === 'start-enroll') {
          await requireOwnerFresh(request);
          return data(await createExecutiveChallenge(request,{operation:'enroll'}));
        }
        if (action === 'enroll') {
          await requireOwnerFresh(request);
          const payload = {
            challengeId:String(body.challengeId||''),
            frames:body.frames,
            pin:body.pin,
          };
          return data(await enrollExecutiveProfile(request,payload));
        }
        return data({error:'Invalid action'},400);
      } catch (error) {
        // Do not leak which factor or biometric check failed; no captures logged.
        const msg = error instanceof Error ? error.message : '';
        const status = msg === 'Payload too large' ? 413 : msg === 'Request body timed out' ? 408 : 403;
        return data({error:'Executive verification refused or unavailable'},status);
      }
    },
  } },
});
