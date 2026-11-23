import type { PayoutDriver } from "../payout";

/**
 * Vendor-specific payout drivers bundled with the build. Each lives in this
 * folder and exports createPayoutDriver({ key }). None are bundled yet: connect
 * a provider through the signed-HTTP driver, or add its module here and list
 * "builtin:<name>" in ELEMARKET_PAYOUT_ALLOWED_MODULES.
 */
export async function loadBundledPayoutDriver(
  _specifier: string,
): Promise<{ createPayoutDriver: (args: { key: string }) => PayoutDriver } | null> {
  return null;
}
