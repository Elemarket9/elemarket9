/** Monetary proof from a verified external PSP event/read-back.
 * No brand-specific field names cross this boundary. */
export type ProviderSplitProof = {
  type: "flat";
  subaccounts: Array<{ subaccount: string; share: number }>;
};
/** Check each external PSP seller amount against the original, frozen order split. */
export function isExactProviderSplit(
  expected: unknown,
  observed: ProviderSplitProof | null | undefined,
): boolean {
  if (!expected || typeof expected !== "object" || !observed || observed.type !== "flat") return false;
  const e = expected as {subaccounts?: unknown};
  if (!Array.isArray(e.subaccounts) || !Array.isArray(observed.subaccounts) ||
      e.subaccounts.length < 1 || e.subaccounts.length !== observed.subaccounts.length) return false;
  const wanted = new Map<string, number>();
  for (const row of e.subaccounts) {
    if (!row || typeof row !== "object") return false;
    const item = row as {subaccount?:unknown;share?:unknown};
    if (typeof item.subaccount !== "string" || !item.subaccount ||
        typeof item.share !== "number" || !Number.isSafeInteger(item.share) || item.share<=0 ||
        wanted.has(item.subaccount)) return false;
    wanted.set(item.subaccount,item.share);
  }
  const seen = new Set<string>();
  for (const row of observed.subaccounts) {
    if (typeof row.subaccount !== "string" || !row.subaccount ||
        !Number.isSafeInteger(row.share) || row.share<=0 ||
        seen.has(row.subaccount) || wanted.get(row.subaccount) !== row.share) return false;
    seen.add(row.subaccount);
  }
  return seen.size===wanted.size;
}
