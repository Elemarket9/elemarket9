/**
 * Provider-neutral payment policy. Provider availability is controlled by the
 * database payment_providers registry and operational approval, not by a
 * hard-coded vendor allow-list.
 */
export function normalizeProviderKey(providerKey: string): string {
  const key = providerKey.trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(key)) throw new Error("Invalid payment provider");
  return key;
}

export function providerSecretEnvKey(providerKey: string): string {
  const key = normalizeProviderKey(providerKey);
  return `ELEMARKET_PAYMENT_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SECRET`;
}
