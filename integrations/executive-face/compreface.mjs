/** CompreFace provider adapter — never imported by the marketplace domain. */
import { URL } from 'node:url';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESPONSE = 32_000;

export function providerConfig(env = process.env) {
  const raw = env.COMPREFACE_BASE_URL || '';
  const key = env.COMPREFACE_RECOGNITION_API_KEY || '';
  if (key.length < 12) throw new Error('Face matcher key not configured');
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(['https:', 'http:'].includes(url.protocol))) throw new Error('Invalid matcher URL');
  // HTTP is permitted only for an explicitly named local/private Docker peer.
  if (url.protocol === 'http:' && !['compreface','127.0.0.1','[::1]','localhost'].includes(url.hostname)) {
    throw new Error('Unencrypted remote matcher prohibited');
  }
  return { baseUrl: url.origin, key, threshold: Number(env.COMPREFACE_MATCH_THRESHOLD || '0.85') };
}

async function readJsonLimited(response) {
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE) throw new Error('Face matcher reply too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Face matcher returned no data');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE) throw new Error('Face matcher reply too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8'));
}

export function createCompreFaceClient({env = process.env, fetcher = fetch} = {}) {
  const cfg = providerConfig(env);
  if (!Number.isFinite(cfg.threshold) || cfg.threshold < 0.7 || cfg.threshold > 0.99) throw new Error('Invalid face match threshold');
  async function call(path, {method = 'POST', body = undefined, expectJson = true} = {}) {
    const signal = AbortSignal.timeout(8000);
    const response = await fetcher(`${cfg.baseUrl}${path}`, {
      method, redirect:'error', cache:'no-store', signal,
      headers: {'x-api-key':cfg.key, 'content-type':'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    });
    if (!response.ok) throw new Error('CompreFace refused request');
    if (!expectJson) { await response.body?.cancel().catch(() => {}); return null; }
    return readJsonLimited(response);
  }
  return {
    /** Enrollment creates an opaque image ID, not a raw face reference stored in ELEMARKET. */
    async enroll(jpegBase64, subject) {
      if (!/^[a-f0-9]{32}$/.test(subject)) throw new Error('Invalid anonymous subject');
      const result = await call(`/api/v1/recognition/faces?subject=${subject}&det_prob_threshold=0.9`, {body:{file:jpegBase64}});
      if (!ID.test(result?.image_id) || result.subject !== subject) throw new Error('Malformed CompreFace enrollment response');
      return result.image_id;
    },
    async match(jpegBase64, imageId) {
      if (!ID.test(imageId)) throw new Error('Invalid face template ID');
      const result = await call(`/api/v1/recognition/faces/${imageId}/verify?limit=0&det_prob_threshold=0.9`, {body:{file:jpegBase64}});
      // Exactly one face must be returned. Never accept a match from a crowd photo.
      const faces = result?.result;
      return Array.isArray(faces) && faces.length === 1 &&
        Number.isFinite(faces[0]?.similarity) && faces[0].similarity >= cfg.threshold &&
        Number.isFinite(faces[0]?.box?.probability) && faces[0].box.probability >= 0.9;
    },
    async remove(imageId) {
      if (!ID.test(imageId)) throw new Error('Invalid face template ID');
      await call(`/api/v1/recognition/faces/${imageId}`,{method:'DELETE',expectJson:false});
    },
  };
}
