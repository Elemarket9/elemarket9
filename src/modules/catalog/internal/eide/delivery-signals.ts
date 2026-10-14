/** Search consumes only authoritative, cached observations supplied by logistics.
 * Request-scoped adapters must never quote providers per candidate or expose addresses.
 * No adapter is enabled until a provider-neutral cache exists.
 */
export type CachedDeliverySignal = {
  productId: string; covered: boolean | null; etaMinutes: number | null;
  cost: number | null; observedAt: number; expiresAt: number;
};
export interface DiscoveryDeliverySignals {
  getCached(productIds: readonly string[], coarseRegion: string): Promise<readonly CachedDeliverySignal[]>;
}
export function deliveryPreference(signal: CachedDeliverySignal | undefined, now: number): number | null {
  if(!signal || !Number.isFinite(now) || !Number.isFinite(signal.observedAt) || !Number.isFinite(signal.expiresAt)
    || signal.observedAt>now || signal.expiresAt<=now || signal.covered!==true) return null;
  const eta=signal.etaMinutes,cost=signal.cost;
  if(eta==null||cost==null||![eta,cost].every(n=>Number.isFinite(n)&&n>=0))return null;
  return Math.max(0,Math.min(1,.5/(1+eta/60)+.5/(1+cost/50)));
}
