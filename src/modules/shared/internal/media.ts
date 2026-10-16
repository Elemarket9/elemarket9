/** Provider-neutral browser image boundary; never accepts executable or local-network URLs. */
export function safeImageSource(value:unknown, approvedOrigins=(import.meta as ImportMeta & {env?:{VITE_ELEMARKET_PUBLIC_MEDIA_ORIGINS?:string}}).env?.VITE_ELEMARKET_PUBLIC_MEDIA_ORIGINS ?? ''):string|undefined {
 if(typeof value!=='string'||value.length>2048||value.includes('\\')||Array.from(value).some(c=>c.charCodeAt(0)<=32))return undefined;
 if(value.startsWith('/')&&!value.startsWith('//'))return value;
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port)return undefined;
 const host=url.hostname.toLowerCase();if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.startsWith('[')||/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host))return undefined;
 // Only platform-approved media hosts may see a visitor's IP. Partner feeds
 // cannot choose arbitrary browser-facing tracking hosts. This public setting
 // contains hostnames ONLY, never secrets. Relative URLs remain accepted.
 const approved = approvedOrigins.split(/[\s,]+/).filter(Boolean).some(origin=>{
   try { const parsed=new URL(origin);return parsed.protocol==='https:' && parsed.origin===origin && parsed.origin===url.origin; }catch{return false;}
 });
 if (!approved) return undefined;
 return url.href;}catch{return undefined;}
}
export function discountPercent(price:unknown,original:unknown):number|null {
 const current=Number(price),before=Number(original);
 if(!Number.isFinite(current)||!Number.isFinite(before)||current<=0||before<=current)return null;
 return Math.min(99,Math.max(1,Math.round((1-current/before)*100)));
}
