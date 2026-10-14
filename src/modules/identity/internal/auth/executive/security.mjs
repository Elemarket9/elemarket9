/** EIDE executive biometric protocol utilities (server-side). Never log credentials, frames or keys. */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const FRAME_LIMIT = 500_000; // bytes (base64 data, not file storage)
export const PHOTO_LIMIT = 3; // one frontal and two liveness frames
export const PIN_MIN_LENGTH = 12;
export const PIN_MAX_LENGTH = 128;
export function validateExecutivePassphrase(pin) {
  return typeof pin === 'string' && pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH &&
    Buffer.byteLength(pin, 'utf8') <= 256 && !/[\u0000-\u001f\u007f]/.test(pin);
}
export async function hashExecutivePassphrase(pin) {
  if (!validateExecutivePassphrase(pin)) throw new Error('Executive passphrase must be 12–128 characters');
  const salt = randomBytes(24);
  const digest = await scrypt(Buffer.from(pin.normalize('NFKC'), 'utf8'), salt, 64, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return `scrypt-v1$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}
export async function verifyExecutivePassphrase(pin, encoded) {
  if (!validateExecutivePassphrase(pin) || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt-v1') return false;
  const salt = Buffer.from(parts[1], 'base64url');
  const stored = Buffer.from(parts[2], 'base64url');
  if (salt.length !== 24 || stored.length !== 64) return false;
  const actual = await scrypt(Buffer.from(pin.normalize('NFKC'), 'utf8'), salt, 64, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return timingSafeEqual(stored, actual);
}
export function newChallenge() { return randomBytes(32).toString('base64url'); }
export function secretDigest(s) { return createHash('sha256').update(s).digest('hex'); }
export function validateFrames(frames) {
  if (!Array.isArray(frames) || frames.length !== PHOTO_LIMIT) return false;
  return frames.every(f => typeof f === 'string' && f.length > 400 && f.length <= FRAME_LIMIT && /^[A-Za-z0-9+/]*={0,2}$/.test(f) && Buffer.from(f,'base64').subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff])));
}
export function hmacHex(key, payload) { return createHmac('sha256',key).update(payload).digest('hex'); }
export function equalHex(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
export function requireSameOrigin(request, executiveHost) {
  const host = request.headers.get('host')?.toLowerCase()?.replace(/:\d+$/,'');
  if (!executiveHost || host !== executiveHost) throw new Error('Executive host required');
  const origin = request.headers.get('origin');
  const expected = `https://${executiveHost}`;
  const local = process.env.ELEMARKET_ENV === 'development' ? `http://${executiveHost}` : null;
  if (origin !== expected && origin !== local) throw new Error('Cross-origin executive request denied');
  if (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin') throw new Error('Cross-site executive request denied');
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('Expected JSON');
}
