/**
 * Executive facial verification boundary, revision 2.
 *
 * This adapter is intentionally NOT a matcher or a PAD algorithm. Only a
 * separately evaluated biometric engine can produce a signed decision.
 * No browser-provided recognition/liveness scores are accepted.
 *
 * Engine request: POST /v1/verify with {operation,challengeId,nonce,prompt,
 * frames,reference}; request HMAC: x-eide-exec-request-signature over raw JSON.
 *
 * Engine response: {challengeId,nonce,operation,prompt,requestDigest,
 * identityMatched:true,livenessPassed:true,reference,policyId,signature}.
 * The signature covers the entire v2 decision tuple (see attestationPayload).
 * Raw face captures should be held only in volatile memory by both systems.
 */
import { createHash, randomBytes } from 'node:crypto';
import { equalHex, hmacHex, validateFrames } from './security.mjs';

const POLICY_ID = /^[a-zA-Z0-9_.:-]{8,128}$/;
const MAX_REPLY_BYTES = 4096;

export function faceEngineConfigured() {
  // Fail closed in all shared environments: face + passphrase is device-independent
  // but cannot prove camera origin and has not passed independent spoof evaluation.
  // Better Auth + TOTP remains the production executive authentication method.
  if (process.env.ELEMARKET_ENV !== 'development' && process.env.ELEMARKET_ENV !== 'test') return false;
  const url = process.env.EIDE_EXEC_FACE_ENGINE_URL ?? '';
  const key = process.env.EIDE_EXEC_FACE_ENGINE_SECRET ?? '';
  const policy = process.env.EIDE_EXEC_FACE_ENGINE_POLICY_ID ?? '';
  if (process.env.ELEMARKET_EXEC_FACE_ENABLED !== '1' || key.length < 32 ||
      !POLICY_ID.test(policy)) return false;
  try {
    const parsed = new URL(url);
    // Disallow URL-embedded credentials, queries, fragments and open HTTP.
    return parsed.pathname === '/v1/verify' && parsed.search === '' && parsed.hash === '' &&
      parsed.username === '' && parsed.password === '' &&
      (parsed.protocol === 'https:' ||
       (parsed.protocol === 'http:' && (['127.0.0.1','[::1]','::1'].includes(parsed.hostname) ||
         (process.env.EIDE_EXEC_FACE_ENGINE_ALLOW_INTERNAL_HTTP === '1' && parsed.hostname === 'executive-face-bridge' && parsed.port === '8091'))));
  } catch { return false; }
}

export function attestationPayload(decision) {
  return JSON.stringify([
    'eide-executive-face-v2',
    decision.operation, decision.challengeId, decision.nonce, decision.prompt,
    decision.requestDigest, decision.identityMatched, decision.livenessPassed,
    decision.reference, decision.policyId,
  ]);
}

async function readBoundedBody(response, maxBytes = MAX_REPLY_BYTES) {
  if (Number(response.headers.get('content-length') || '0') > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Verifier response too large');
  }
  if (!response.body) throw new Error('Verifier response missing');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('Verifier response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

export async function verifyLiveFace({operation, challengeId, nonce, prompt, frames, reference}) {
  if (!faceEngineConfigured()) throw new Error('EIDE biometric verifier unavailable');
  if (!['login', 'enroll'].includes(operation) ||
      !['turn_left','turn_right','blink'].includes(prompt) ||
      typeof nonce !== 'string' || nonce.length < 32 ||
      typeof challengeId !== 'string' || challengeId.length < 30 ||
      !validateFrames(frames)) throw new Error('Invalid verifier challenge or camera sequence');
  if (operation !== 'enroll' && (typeof reference !== 'string' || reference.length < 16)) {
    throw new Error('Missing enrolled biometric reference');
  }

  const secret = process.env.EIDE_EXEC_FACE_ENGINE_SECRET;
  const body = JSON.stringify({ operation, challengeId, nonce, prompt, frames, reference: reference ?? null });
  const requestDigest = createHash('sha256').update(body).digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(process.env.EIDE_EXEC_FACE_ENGINE_URL, {
      method: 'POST', headers: {
        'content-type':'application/json',
        'x-eide-exec-request-signature': hmacHex(secret, body),
      }, body, signal: controller.signal, redirect: 'error', cache:'no-store',
    });
    if (!response.ok) throw new Error('Face engine rejected verification');
    const result = JSON.parse(await readBoundedBody(response));
    if (!result || typeof result !== 'object' ||
        result.operation !== operation || result.challengeId !== challengeId ||
        result.nonce !== nonce || result.prompt !== prompt ||
        !equalHex(result.requestDigest, requestDigest) ||
        result.identityMatched !== true || result.livenessPassed !== true ||
        result.policyId !== process.env.EIDE_EXEC_FACE_ENGINE_POLICY_ID ||
        typeof result.reference !== 'string' ||
        result.reference.length < 16 || result.reference.length > 250 ||
        (operation !== 'enroll' && reference !== result.reference)) {
      throw new Error('Face authentication failed');
    }
    if (!equalHex(result.signature, hmacHex(secret, attestationPayload(result)))) {
      throw new Error('Untrusted biometric engine response');
    }
    return result.reference;
  } finally { clearTimeout(timeout); }
}

/** Best-effort orphan template cleanup, never called by the browser.
 * Response must be signed by the same isolated bridge as the matcher.
 */
export async function removeOrphanFaceReference(reference) {
  if (!faceEngineConfigured() || typeof reference !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference))
    throw new Error('Template cleanup unavailable');
  const nonce=randomBytes(32).toString('base64url');
  const body=JSON.stringify({reference,nonce});
  const key=process.env.EIDE_EXEC_FACE_ENGINE_SECRET;
  const url=new URL(process.env.EIDE_EXEC_FACE_ENGINE_URL);
  url.pathname='/v1/remove';
  const response=await fetch(url,{method:'POST',cache:'no-store',redirect:'error',
    signal:AbortSignal.timeout(8000),headers:{'content-type':'application/json',
      'x-eide-exec-request-signature':hmacHex(key,body)},body});
  if(!response.ok) throw new Error('Biometric template cleanup denied');
  const answer=JSON.parse(await readBoundedBody(response));
  const digest=createHash('sha256').update(body).digest('hex');
  const payload=JSON.stringify(['eide-executive-remove-v1',reference,nonce,digest,true,process.env.EIDE_EXEC_FACE_ENGINE_POLICY_ID]);
  if(answer?.reference!==reference || answer?.nonce!==nonce || answer?.removed!==true ||
     !equalHex(answer.requestDigest,digest) || answer.policyId!==process.env.EIDE_EXEC_FACE_ENGINE_POLICY_ID ||
     !equalHex(answer.signature,hmacHex(key,payload)))
    throw new Error('Untrusted biometric template cleanup acknowledgement');
  return true;
}
