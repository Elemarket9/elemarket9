import http from 'node:http';
import https from 'node:https';
import { normalizedPortalHostname } from '../src/lib/security/portal-policy.mjs';
import { signedHeaders } from './scheduler-core.mjs';

/** Connect over the private network while preserving the configured portal
 * Host header. HMAC authorization is still required by every worker route.
 * node:http is intentional: fetch does not reliably preserve an overridden Host.
 */
export function runScheduledJob({ base, path, secret, env = process.env, signal }) {
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid scheduler URL');
  const headers = signedHeaders({ secret, path });
  if (env.ELEMARKET_PORTAL_HOST_ROUTING === '1') {
    const host = normalizedPortalHostname(env.ELEMARKET_DOMAIN);
    if (!host) throw new Error('Portal scheduler requires ELEMARKET_DOMAIN');
    headers.host = host;
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
    }, response => {
      // Job details can contain private data. Record only status; do not buffer
      // or log response bodies. Redirects are failures and never followed.
      const status = response.statusCode ?? 0;
      response.destroy();
      if (status >= 200 && status < 300) resolve();
      else reject(new Error(`HTTP ${status}`));
    });
    request.on('error', reject);
    request.end();
  });
}
