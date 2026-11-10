/** Same-origin checkout path. Rejects protocol-relative and scheme-bearing redirects. */
export function safeRelativeCheckoutPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("://")) return null;
  if ([...value].some((char) => { const code = char.charCodeAt(0); return code < 33 || code === 127; }) || value.includes("@") || value.includes("#")) return null;
  try {
    const url = new URL(value, "https://checkout.invalid");
    if (url.origin !== "https://checkout.invalid" || url.username || url.password) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
