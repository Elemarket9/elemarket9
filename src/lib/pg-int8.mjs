/** int8 arrives as text. Keep JSON-safe integers; preserve the decimal text past 2^53.
 * @param {unknown} value
 */
export function parsePgInt8(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}
