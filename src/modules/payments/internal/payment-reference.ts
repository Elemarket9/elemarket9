/** Stable provider reference for one payment attempt. Retries must reuse it. */
export function deterministicPaymentReference(attemptId: string): string {
  const reference = attemptId.replace(/[^A-Za-z0-9\-.=]/g, "").slice(0, 100);
  if (reference.length < 8) throw new Error("Payment attempt reference is not usable");
  return reference;
}

/** GHS major-unit string to pesewas. Rejects negatives and extra precision. */
export function moneyToMinorUnits(amount: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error("Invalid payment amount");
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid payment amount");
  return minor;
}
