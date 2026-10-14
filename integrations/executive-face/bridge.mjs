/** Authenticated private executive evaluator: CompreFace identity + independent PAD.
 * Runs as its own isolated adapter process; do not expose outside private network.
 */
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createCompreFaceClient } from './compreface.mjs';
import { verifyPad } from './pad-adapter.mjs';
import { validateFrames, equalHex, hmacHex } from '../../src/modules/identity/internal/auth/executive/security.mjs';

const MAX_BODY = 1_650_000;
const ID = /^[0-9a-f-]{36}$/i;
const OP = new Set(['login','enroll']);
const PROMPT = new Set(['turn_left','turn_right','blink']);
export function decisionSignaturePayload(r) {
  return JSON.stringify(['eide-executive-face-v2',r.operation,r.challengeId,r.nonce,r.prompt,r.requestDigest,
    r.identityMatched,r.livenessPassed,r.reference,r.policyId]);
}
/** Signed private cleanup, for orphaned templates after failed DB enrollment. */
export function removalSignaturePayload(r) {
  return JSON.stringify(['eide-executive-remove-v1',r.reference,r.nonce,r.requestDigest,r.removed,r.policyId]);
}
function validateRequest(obj) {
  return obj && OP.has(obj.operation) && PROMPT.has(obj.prompt) &&
    typeof obj.challengeId === 'string' && ID.test(obj.challengeId) &&
    typeof obj.nonce === 'string' && obj.nonce.length >= 32 && obj.nonce.length <= 128 &&
    validateFrames(obj.frames) && (obj.operation === 'enroll' ? obj.reference === null : ID.test(obj.reference || ''));
}
export function createBridge({env=process.env, matcher=null, pad=verifyPad, clock=Date.now}={}) {
  if ((env.EIDE_EXEC_FACE_ENGINE_SECRET || '').length < 32 ||
      !/^[a-zA-Z0-9_.:-]{8,128}$/.test(env.EIDE_EXEC_FACE_ENGINE_POLICY_ID || '')) throw new Error('Bridge signer not configured');
  const engineSecret = env.EIDE_EXEC_FACE_ENGINE_SECRET;
  const faceMatcher = matcher || createCompreFaceClient({env});
  const seen = new Map();
  async function evaluate(obj) {
    // Bridge replay cache is defense in depth; application's DB consumes every challenge atomically.
    const key = `${obj.challengeId}:${obj.nonce}`;
    const now=clock();
    for (const [k, expires] of seen) if (expires < now) seen.delete(k);
    if (seen.has(key)) throw new Error('Repeated biometric challenge');
    seen.set(key,now+120_000);
    // Do not enroll a faceprint or emit a positive attestation without independent PAD.
    await pad({challengeId:obj.challengeId,nonce:obj.nonce,prompt:obj.prompt,frames:obj.frames},{env});
    let ref = obj.reference;
    let matched = false;
    if (obj.operation === 'enroll') {
      ref = await faceMatcher.enroll(obj.frames[0],randomBytes(16).toString('hex'));
      try {
        matched = await faceMatcher.match(obj.frames[1],ref) && await faceMatcher.match(obj.frames[2],ref);
        if (!matched) throw new Error('Enrollment frames do not match');
      } catch (e) {
        await faceMatcher.remove(ref).catch(() => {});
        throw e;
      }
    } else {
      matched = await faceMatcher.match(obj.frames[0],ref) &&
                await faceMatcher.match(obj.frames[1],ref) &&
                await faceMatcher.match(obj.frames[2],ref);
    }
    if (!matched) throw new Error('Face did not match enrolled template');
    const decision = {
      operation:obj.operation,challengeId:obj.challengeId,nonce:obj.nonce,prompt:obj.prompt,
      requestDigest:createHash('sha256').update(JSON.stringify(obj)).digest('hex'),
      identityMatched:true,livenessPassed:true,reference:ref,policyId:env.EIDE_EXEC_FACE_ENGINE_POLICY_ID,
    };
    return {...decision,signature:hmacHex(engineSecret,decisionSignaturePayload(decision))};
  }
  async function handle(req,res) {
    const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
    if (req.method !== 'POST' || !['/v1/verify','/v1/remove'].includes(req.url)) return reply(404,{error:'Not found'});
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return reply(415,{error:'Invalid request'});
    let length=0;const parts=[];
    try {
      for await (const chunk of req) {
        length+=chunk.length;if (length>MAX_BODY) return reply(413,{error:'Payload too large'});
        parts.push(chunk);
      }
      const raw=Buffer.concat(parts).toString('utf8');
      if (!equalHex(req.headers['x-eide-exec-request-signature'],hmacHex(engineSecret,raw))) return reply(401,{error:'Unauthorized'});
      const data=JSON.parse(raw);
      if (req.url === '/v1/remove') {
        const reference = data?.reference;
        const nonce = data?.nonce;
        if (!ID.test(reference || '') || typeof nonce !== 'string' || nonce.length < 32 || nonce.length > 128)
          return reply(400,{error:'Invalid removal request'});
        const key=`remove:${reference}:${nonce}`;
        const now=clock();
        for(const [k,expires] of seen) if(expires<now) seen.delete(k);
        if(seen.has(key)) return reply(403,{error:'Repeated removal'});
        seen.set(key,now+120_000);
        await faceMatcher.remove(reference);
        const ack={reference,nonce,requestDigest:createHash('sha256').update(raw).digest('hex'),
          removed:true,policyId:env.EIDE_EXEC_FACE_ENGINE_POLICY_ID};
        return reply(200,{...ack,signature:hmacHex(engineSecret,removalSignaturePayload(ack))});
      }
      if (!validateRequest(data)) return reply(400,{error:'Invalid request'});
      const decision=await evaluate(data);
      return reply(200,decision);
    } catch { return reply(403,{error:'Verification unsuccessful'}); }
  }
  return {handle,evaluate};
}
export function startBridge(env=process.env) {
  const {handle}=createBridge({env});
  const port=Number(env.EIDE_EXEC_BRIDGE_PORT || 8091);
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid bridge port');
  const server=createServer(handle);
  server.requestTimeout=15000;
  server.headersTimeout=20000;
  server.listen(port,'0.0.0.0');
  return server;
}
