/** Shared developer beta intentionally cannot create real or simulated paid orders.
 * Shared-environment profile is positive opt-in, never inferred from NODE_ENV. */
export function isDeveloperBeta(env = process.env) {
  return env.ELEMARKET_LAUNCH_PROFILE === "developer_beta" &&
    ["staging", "production"].includes(env.ELEMARKET_ENV);
}
export function assertCommerceExecutionAllowed(operation, env = process.env) {
  if (isDeveloperBeta(env)) throw new Error(`Developer beta: ${operation} is disabled; no transactions or fulfillment are available`);
}
