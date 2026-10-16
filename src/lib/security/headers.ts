function configuredSources(name: string): string {
  return (process.env[name] ?? "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

export function securityHeaders(options: { production: boolean; nonce?: string }): Record<string, string> {
  const extraScriptSources = configuredSources("ELEMARKET_CSP_SCRIPT_SRC");
  const extraConnectSources = configuredSources("ELEMARKET_CSP_CONNECT_SRC");
  // Only reviewed exact HTTPS image origins are allowed in visitor browsers.
  const imageOrigins = (process.env.VITE_ELEMARKET_PUBLIC_MEDIA_ORIGINS ?? '').split(/[\s,]+/)
    .filter(origin=>{try{const u=new URL(origin);return u.protocol==='https:'&&u.origin===origin;}catch{return false;}})
    .join(' ');
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `img-src 'self' data: blob:${imageOrigins ? ` ${imageOrigins}` : ""}`,
    "font-src 'self' data:",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    `script-src 'self'${options.nonce ? ` 'nonce-${options.nonce}'` : ""}${extraScriptSources ? ` ${extraScriptSources}` : ""}`,
    `connect-src 'self'${extraConnectSources ? ` ${extraConnectSources}` : ""}`,
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Origin-Agent-Cluster": "?1",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=(self)",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    ...(options.production ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload" } : {}),
  };
}
