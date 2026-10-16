/** Provider-neutral, reviewed public asset origins; no arbitrary partner domains. */
export function approvedPublicMediaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return undefined;
    const configured = process.env.VITE_ELEMARKET_PUBLIC_MEDIA_ORIGINS || '';
    const allowed = configured.split(/[\s,]+/).filter(Boolean).some(origin => {
      try {const candidate = new URL(origin);return candidate.protocol === 'https:' && candidate.origin === origin && candidate.origin === url.origin;}
      catch {return false;}
    });
    return allowed ? url.href : undefined;
  } catch { return undefined; }
}
