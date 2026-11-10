/** Connection and capacity failures that callers should surface as 503.
 * @param {unknown} error
 */
export function isDatabaseUnavailable(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code ?? "") : "";
  if (/^(08|53|57P0[123]|53300)/.test(code)) return true;
  const message = error instanceof Error ? error.message : "";
  return /timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED|the database system is|sorry, too many clients|remaining connection slots/i.test(message);
}
