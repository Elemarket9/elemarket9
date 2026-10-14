/** Independent, externally evaluated presentation-attack-detection boundary.
 * No in-browser model scores or fabricated liveness booleans are trusted.
 * CompreFace itself does NOT implement the required liveness assurance.
 */
import { createHash } from 'node:crypto';
import { equalHex, hmacHex } from '../../src/modules/identity/internal/auth/executive/security.mjs';

export function padConfigured(env = process.env) {
  if (!env.EIDE_EXEC_PAD_URL || (env.EIDE_EXEC_PAD_SECRET || '').length < 32 ||
      !/^[a-z0-9_.:-]{8,128}$/i.test(env.EIDE_EXEC_PAD_POLICY_ID || '')) return false;
  try {
    const url = new URL(env.EIDE_EXEC_PAD_URL);
    return url.pathname === '/v1/presentation-verify' && !url.search && !url.hash && !url.username && !url.password &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1','[::1]','pad-verifier'].includes(url.hostname)));
  } catch { return false; }
}
export function padAttestationPayload(r) {
  return JSON.stringify(['eide-pad-v1',r.challengeId,r.nonce,r.prompt,r.requestDigest,r.passed,r.captureBindingVerified,r.policyId]);
}
export async function verifyPad(challenge,{env=process.env,fetcher=fetch}={}) {
  if (!padConfigured(env)) throw new Error('Independent PAD is not configured; executive login remains disabled');
  const {challengeId,nonce,prompt,frames} = challenge;
  const body = JSON.stringify({challengeId,nonce,prompt,frames});
  const requestDigest = createHash('sha256').update(body).digest('hex');
  const response = await fetcher(env.EIDE_EXEC_PAD_URL, {
    method:'POST', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(10000),
    headers:{'content-type':'application/json','x-eide-pad-request-signature':hmacHex(env.EIDE_EXEC_PAD_SECRET,body)},body,
  });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 4096) throw new Error('Independent PAD failed');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PAD reply missing');
  let bytes = 0; const chunks = [];
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      bytes+=value.byteLength;
      if (bytes>4096) throw new Error('PAD reply too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || result.challengeId !== challengeId || result.nonce !== nonce || result.prompt !== prompt ||
    !equalHex(result.requestDigest,requestDigest) || result.passed !== true ||
    result.captureBindingVerified !== true || result.policyId !== env.EIDE_EXEC_PAD_POLICY_ID ||
    !equalHex(result.signature,hmacHex(env.EIDE_EXEC_PAD_SECRET,padAttestationPayload(result)))) {
    throw new Error('Independent PAD rejected capture');
  }
  return true;
}
