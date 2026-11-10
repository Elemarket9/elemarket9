/** Log class and SQLSTATE only. node-pg `detail` can contain emails, phones, and keys.
 * @param {unknown} error
 */
export function safeErrorFields(error) {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const raw = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof raw === "string" && /^[A-Z0-9]{5}$/.test(raw) ? raw : undefined;
  return code ? { name, code } : { name };
}

/** @param {string} scope @param {unknown} error */
export function logServerError(scope, error) {
  console.error(scope, safeErrorFields(error));
}
