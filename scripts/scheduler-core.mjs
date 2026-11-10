// Portable, provider-neutral job definitions. The HTTP routes remain the
// authoritative execution implementations; scheduler invokes no marketplace SQL.
import { createHash, createHmac, randomBytes } from 'node:crypto';
export const JOBS = Object.freeze([
  { path: '/api/internal/expire-payment-orders', everyMinutes: 1 },
  { path: '/api/internal/reconcile-payments', everyMinutes: 1 },
  { path: '/api/internal/dispatch-deliveries', everyMinutes: 1 },
  { path: '/api/internal/rider-invitations', everyMinutes: 1 },
  { path: '/api/internal/collection-notifications', everyMinutes: 1 },
  { path: '/api/internal/enterprise-order-outbox', everyMinutes: 1 },
  { path: '/api/internal/enterprise-webhook-worker', everyMinutes: 1 },
  { path: '/api/internal/sync-enterprise-catalogs', everyMinutes: 5 },
  { path: '/api/internal/refresh-eide', everyMinutes: 5 },
  { path: '/api/internal/purge-retention', everyMinutes: 5 },
  { path: '/api/internal/wallet-settlement', everyMinutes: 1 },
]);
export function signedHeaders({ secret, path, timestamp = Date.now(), nonce = randomBytes(24).toString('hex') }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Scheduler signing secret must be at least 32 characters');
  if (!JOBS.some(job => job.path === path)) throw new Error('Scheduler path not registered');
  const hash = createHash('sha256').update('').digest('hex');
  const message = `${timestamp}.${nonce}.GET.${path}.${hash}`;
  return {
    'x-elemarket-sync-timestamp': String(timestamp),
    'x-elemarket-sync-nonce': nonce,
    'x-elemarket-sync-signature': createHmac('sha256', secret).update(message).digest('hex'),
    'x-elemarket-body-sha256': hash,
  };
}
export function dueJobs(minute) {
  return JOBS.filter(job => minute % job.everyMinutes === 0);
}
/** Replay at most the first missed minute, then the current one. Do not stampede. */
export function minutesToRun(previousMinute, minute) {
  if (!Number.isInteger(previousMinute) || previousMinute < 0 || !Number.isInteger(minute) || minute <= previousMinute) return [minute];
  const missed = minute - previousMinute - 1;
  if (missed <= 0) return [minute];
  return [previousMinute + 1, minute];
}
