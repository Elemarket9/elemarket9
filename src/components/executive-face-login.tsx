import { useEffect, useRef, useState } from 'react';
import { captureExecutiveFrames, executiveJson } from '@/lib/executive/camera';

type Challenge={id:string;nonce:string;prompt:string};
const promptNames:Record<string,string>={turn_left:'Turn your head gently left',turn_right:'Turn your head gently right',blink:'Blink naturally twice'};
export function ExecutiveFaceLogin() {
  const videoRef=useRef<HTMLVideoElement|null>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const [pin,setPin]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [prompt,setPrompt]=useState<string|null>(null);
  const [ready,setReady]=useState(false);
  useEffect(()=>{fetch('/api/executive/face',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(r=>setReady(Boolean(r.available))).catch(()=>setReady(false));return ()=>{streamRef.current?.getTracks().forEach(t=>t.stop());};},[]);
  async function begin() {
    setBusy(true);setError(null);
    try {
      if(pin.length<12) throw new Error('Enter your executive alphanumeric passphrase (12+ characters)');
      // Request permission before minting a 90-second challenge. Permission
      // dialogs can otherwise exhaust the challenge before capture begins.
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});
      streamRef.current=stream;
      const video=videoRef.current;
      if(!video) throw new Error('Camera not available');
      video.srcObject=stream;
      await video.play();
      if (!video.videoWidth || !video.videoHeight) throw new Error('Camera is not ready');
      const challenge=await executiveJson<Challenge>('/api/executive/face',{action:'start-login'});
      setPrompt(promptNames[challenge.prompt]||'Follow the camera instruction');
      const frames=await captureExecutiveFrames(video,challenge.prompt as "blink"|"turn_left"|"turn_right",setPrompt);
      const response=await executiveJson<{ok:boolean}>('/api/auth/executive/face-sign-in',{
        challengeId:challenge.id,frames,pin,
      });
      if(!response.ok) throw new Error('Authentication rejected');
      setPin('');window.location.assign('/admin/dashboard');
    } catch (e) {setError(e instanceof Error?e.message:'Executive authentication failed');}
    finally {streamRef.current?.getTracks().forEach(t=>t.stop());streamRef.current=null;setBusy(false);setPrompt(null);}
  }
  if(!ready) return <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Executive facial sign-in is not yet activated. Use the existing secure administrator sign-in until an independently validated liveness and face-verification engine is configured.</p>;
  return <div className="mt-6 rounded-xl border border-market-line p-4">
    <h2 className="text-lg font-black">Executive Face + Passphrase</h2>
    <p className="mt-2 text-sm text-market-muted">Use a compatible camera on any phone or computer. No device or browser enrollment is required. This experimental biometric method is disabled in production pending independent testing.</p>
    <video ref={videoRef} autoPlay muted playsInline className="mt-3 aspect-square w-full rounded-xl bg-neutral-950 object-cover" aria-label="Executive face camera" />
    {prompt && <p role="status" className="mt-2 font-bold">{prompt}</p>}
    <label className="mt-3 block text-sm font-bold">Alphanumeric security passphrase
      <input autoComplete="off" type="password" minLength={12} maxLength={128} value={pin} onChange={e=>setPin(e.target.value)} className="mt-1 w-full rounded-xl border p-3" />
    </label>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <button type="button" disabled={busy||pin.length<12} onClick={()=>void begin()} className="mt-4 w-full rounded-xl bg-black p-3 font-bold text-white disabled:opacity-60">{busy?'Verifying face and passphrase…':'Scan Face + Sign In'}</button>
  </div>;
}
