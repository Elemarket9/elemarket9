import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { getAdminAccessState } from '@/modules/administration/public/transport/admin/access.functions';
import { captureExecutiveFrames, executiveJson } from '@/lib/executive/camera';

type Challenge={id:string;nonce:string;prompt:string};
const prompts:Record<string,string>={turn_left:'Turn your head left',turn_right:'Turn your head right',blink:'Blink twice'};
export const Route=createFileRoute('/admin/executive-face')({
  head:()=>({meta:[{title:'Executive biometric enrollment | ELEMARKET'},{name:'robots',content:'noindex,nofollow,noarchive'}]}),
  loader:async()=>{const access=await getAdminAccessState();if(!access.authenticated||!access.isAdmin||access.portal!=='executive'||access.staffRole!=='owner')throw redirect({to:'/admin'});return access;},
  component: ExecutiveFaceEnrollment,
});
function ExecutiveFaceEnrollment(){
  Route.useLoaderData();
  const videoRef=useRef<HTMLVideoElement|null>(null); const streamRef=useRef<MediaStream|null>(null);
  const [enabled,setEnabled]=useState(false);const [enrolled,setEnrolled]=useState(false);
  const [pin,setPin]=useState('');const [busy,setBusy]=useState(false);const [prompt,setPrompt]=useState('');const [error,setError]=useState('');const [success,setSuccess]=useState('');
  useEffect(()=>{fetch('/api/executive/face',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(v=>{setEnabled(Boolean(v.available));setEnrolled(Boolean(v.enrolled));}).catch(()=>setEnabled(false));return()=>{streamRef.current?.getTracks().forEach(t=>t.stop());};},[]);
  async function enroll(){
    setBusy(true);setError('');setSuccess('');
    try {
      if(pin.length<12||pin.length>128)throw new Error('Security passphrase must be 12–128 characters');
      // Obtain camera consent first; do not start the short-lived challenge
      // while an unfamiliar browser is still displaying its permission prompt.
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});streamRef.current=stream;
      const video=videoRef.current;if(!video)throw new Error('Camera unavailable');video.srcObject=stream;await video.play();
      if (!video.videoWidth || !video.videoHeight) throw new Error('Camera is not ready');
      const challenge=await executiveJson<Challenge>('/api/executive/face',{action:'start-enroll'});
      setPrompt(prompts[challenge.prompt]||'Follow the live camera instruction');
      const frames=await captureExecutiveFrames(video,challenge.prompt as 'blink'|'turn_left'|'turn_right',setPrompt);
      const result=await executiveJson<{ok:boolean}>('/api/executive/face',{action:'enroll',challengeId:challenge.id,frames,pin});
      if(!result.ok)throw new Error('Enrollment refused');
      setEnrolled(true);setPin('');setSuccess('Executive face and passphrase enrolled. You can use any supported camera/browser when biometric login is activated.');
    } catch(e) {setError(e instanceof Error?e.message:'Enrollment failed');}
    finally{streamRef.current?.getTracks().forEach(t=>t.stop());streamRef.current=null;setBusy(false);setPrompt('');}
  }
  async function disableFace() {
    if (!window.confirm('Disable executive facial login, revoke biometric sessions, and request deletion of the face template?')) return;
    setBusy(true);setError('');setSuccess('');
    try {
      const outcome=await executiveJson<{disabled:boolean;templateCleanupPending:boolean}>(
        '/api/executive/face',{action:'disable-face-profile'});
      if (!outcome.disabled) throw new Error('Face sign-in was not disabled');
      setEnrolled(outcome.templateCleanupPending);
      setSuccess(outcome.templateCleanupPending
        ? 'Face login is disabled and biometric sessions revoked. Remote template deletion is pending; an administrator must retry after the verifier becomes available.'
        : 'Face login disabled, biometric sessions revoked, and remote template deletion acknowledged.');
    } catch (e) {setError(e instanceof Error?e.message:'Could not disable face sign-in');}
    finally {setBusy(false);}
  }
  return <main className="mx-auto max-w-xl px-4 py-12">
    <p className="text-xs font-black uppercase tracking-widest text-market-muted">Main Administrator only</p>
    <h1 className="mt-3 text-3xl font-black">Executive Face + Alphanumeric Passphrase</h1>
    <p className="mt-3 text-sm text-market-muted">First-time enrollment requires your existing Better Auth administrator session and TOTP. No browser key or trusted-device registration is created. Password + TOTP remains an independent login option.</p>
    {enrolled ? <section className="mt-5 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <p className="font-semibold text-amber-950">An executive face profile exists. Existing Better Auth + TOTP login remains available.</p>
      <p className="text-sm text-amber-900">Use a fresh password + authenticator session to disable face login and revoke existing biometric sessions, including when the biometric engine is offline.</p>
      <button type="button" disabled={busy} onClick={()=>void disableFace()} className="rounded-lg bg-red-900 px-4 py-2 font-bold text-white disabled:opacity-60">Disable facial sign-in & request deletion</button>
    </section>
    : !enabled ? <p className="mt-5 rounded-xl bg-amber-50 p-4 font-semibold text-amber-950">Biometric enrollment and login are disabled in production until independent presentation-attack and device-independent security validation. Continue using Better Auth + TOTP.</p>
    : <section className="mt-6 space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-black">Initial facial enrollment</h2>
      <video ref={videoRef} autoPlay playsInline muted className="aspect-square w-full rounded-xl bg-neutral-950 object-cover" aria-label="Executive biometric enrollment camera" />
      {prompt && <p role="status" className="font-bold">{prompt}</p>}
      <label className="block text-sm font-bold">Executive alphanumeric security passphrase
        <input className="mt-1 h-12 w-full rounded-xl border px-3" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={pin} onChange={e=>setPin(e.target.value)} />
      </label>
      {error&&<p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {success&&<p role="status" className="rounded-xl bg-green-50 p-3 text-sm text-green-700">{success}</p>}
      <button type="button" disabled={busy||pin.length<12} onClick={()=>void enroll()} className="w-full rounded-xl bg-black p-3 font-bold text-white disabled:opacity-60">{busy?'Processing…':'Verify face and enroll'}</button>
    </section>}
    {success&&<p role="status" className="mt-3 text-sm text-green-800">{success}</p>}
    <a className="mt-6 inline-block text-sm font-bold text-market-green" href="/admin/security">Back to account security</a>
  </main>;
}
