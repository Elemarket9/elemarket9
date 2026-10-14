/** Camera capture and network helper; no device registration or IndexedDB keys required. */
function toBase64(bytes:Uint8Array):string {
  let encoded=''; for (let i=0;i<bytes.length;i+=4096) encoded+=String.fromCharCode(...bytes.subarray(i,i+4096));
  return btoa(encoded);
}
export async function captureExecutiveFrames(
  video:HTMLVideoElement,
  prompt:'turn_left'|'turn_right'|'blink',
  onInstruction?:(instruction:string)=>void,
):Promise<string[]> {
  if(!['turn_left','turn_right','blink'].includes(prompt)) throw new Error('Unknown challenge');
  const canvas=document.createElement('canvas');
  canvas.width=240;canvas.height=320;
  const ctx=canvas.getContext('2d');
  if (!ctx || !video.videoWidth || !video.videoHeight) throw new Error('Camera has not started');
  const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  async function snapshot():Promise<string> {
    if(video.readyState < 2 || video.paused) throw new Error('Camera stopped');
    const side=Math.min(video.videoWidth,video.videoHeight);
    ctx!.drawImage(video,(video.videoWidth-side)/2,(video.videoHeight-side)/2,side,side,0,0,240,320);
    const blob=await new Promise<Blob|null>(resolve=>canvas!.toBlob(resolve,'image/jpeg',0.65));
    if (!blob) throw new Error('Unable to capture camera image');
    const raw=new Uint8Array(await blob.arrayBuffer());
    if (raw.length > 370_000) throw new Error('Camera frame too large');
    return toBase64(raw);
  }
  try {
    onInstruction?.('Look straight at the camera and keep your eyes open');
    await pause(1500);
    const first=await snapshot();
    onInstruction?.(prompt === 'blink' ? 'Close both eyes and hold briefly'
      : prompt === 'turn_left' ? 'Turn your head to YOUR left and hold'
      : 'Turn your head to YOUR right and hold');
    await pause(1750);
    const second=await snapshot();
    onInstruction?.('Look straight at the camera again and open your eyes');
    await pause(1400);
    const third=await snapshot();
    return [first,second,third];
  } finally {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    onInstruction?.('');
  }
}
export async function executiveJson<T=Record<string,unknown>>(path:string,body:object):Promise<T> {
  const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const json=await response.json().catch(()=>({error:'Request failed'}));
  if(!response.ok) throw new Error(typeof json?.error==='string'?json.error:'Request rejected');
  return json as T;
}
