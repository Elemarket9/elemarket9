import { useEffect, useMemo, useState } from "react";
import { createStorageUploadUrl, finalizeStorageUpload } from "@/lib/storage/storage";
import { getCustomerFinancingProviderForm, submitCustomerFinancingProviderApplication } from "@/modules/financing/public/financing-form";
import { formatGhs } from "@/modules/shared/public/money";

type Props={providerId:string;quoteId:string;providerName:string};
type Field={id:string;fieldKey:string;label:string;fieldType:string;required:boolean;helpText?:string|null;options?:string[];maxLength?:number|null};
export function FinancingProviderApplicationForm({providerId,quoteId,providerName}:Props){
 const [model,setModel]=useState<any|null>(null);const [answers,setAnswers]=useState<Record<string,string>>({});const [files,setFiles]=useState<Record<string,File|undefined>>({});const [method,setMethod]=useState("");const [consent,setConsent]=useState(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState<string|null>(null);
 useEffect(()=>{let active=true;setModel(null);setAnswers({});setFiles({});setConsent(false);setMessage(null);void getCustomerFinancingProviderForm({data:{providerId,quoteId}}).then(v=>{if(!active)return;setModel(v);const first=v.deposit?.methods?.[0];if(first)setMethod(first)}).catch(e=>{if(active)setMessage(e instanceof Error?e.message:"Provider requirements could not be loaded")});return()=>{active=false}},[providerId,quoteId]);
 const fields=(model?.form?.fields??[]) as Field[];
 const hasForm=Boolean(model?.form);
 const fileTypes=new Set(["ghana_card_front","ghana_card_back","selfie","document"]);
 const depositMethods=useMemo(()=>model?.deposit?.methods??[],[model]);

 async function upload(field:Field,file:File){
  if(file.size>560*1024)throw new Error(`${field.label} must be 560 KB or smaller`);
  const allowed=field.fieldType==="document"?["application/pdf","image/jpeg","image/png","image/webp"]:["image/jpeg","image/png","image/webp"];
  if(!allowed.includes(file.type))throw new Error(`${field.label} file type is not supported`);
  const created=await createStorageUploadUrl({data:{purpose:"financing-application-document",contentType:file.type,sizeBytes:file.size,resourceId:quoteId}});
  const headers=new Headers(created.requiredHeaders??{});
  if(!headers.has("content-type"))headers.set("content-type",file.type);
  headers.delete("content-length");
  const response=await fetch(created.uploadUrl,{method:"PUT",headers,body:file});
  if(!response.ok)throw new Error(`${field.label} upload failed`);
  const finalized=await finalizeStorageUpload({data:{uploadId:created.uploadId}});
  if(!finalized.verified)throw new Error(`${field.label} could not be verified`);
  return created.uploadId;
 }

 async function submit(){
  if(!hasForm)return;
  setBusy(true);setMessage(null);
  try{
   const prepared:Array<{fieldId:string;answerText?:string;uploadIntentId?:string}>=[];
   for(const field of fields){
    if(fileTypes.has(field.fieldType)){
      const file=files[field.id];
      if(field.required&&!file)throw new Error(`${field.label} is required`);
      if(file)prepared.push({fieldId:field.id,uploadIntentId:await upload(field,file)});
    }else{
      const value=answers[field.id]??"";
      if(field.required&&!value.trim())throw new Error(`${field.label} is required`);
      if(value!==""||field.required)prepared.push({fieldId:field.id,answerText:value});
    }
   }
   if(model.deposit?.amount>0&&!method)throw new Error("Choose how to pay the initial deposit");
   if(!consent)throw new Error(`You must consent to sharing this application with ${providerName}`);
   const result=await submitCustomerFinancingProviderApplication({data:{providerId,quoteId,formId:model.form.id,answers:prepared,paymentMethod:model.deposit?.amount>0?method as any:undefined,consentAccepted:true,idempotencyKey:crypto.randomUUID()}});
   const checkoutUrl=result.depositPayment?.checkoutUrl;
   if(checkoutUrl){window.location.href=checkoutUrl;return}
   if(result.depositPayment?.depositPaymentId){window.location.href=`/financing/deposit-return?depositPaymentId=${encodeURIComponent(result.depositPayment.depositPaymentId)}`;return}
   setMessage(result.initialDepositAmount>0?`Application submitted. ${formatGhs(result.initialDepositAmount)} initial deposit is pending.`:"Application submitted to the financing provider for review.");
  }catch(e){setMessage(e instanceof Error?e.message:"Financing application could not be submitted")}finally{setBusy(false)}
 }

 if(!model)return <p className="mt-3 text-xs font-semibold text-market-muted">Loading {providerName} requirements…</p>;
 if(!hasForm)return <p className="mt-3 rounded-xl border bg-white p-3 text-xs font-semibold text-market-muted">{providerName} has not published an application form yet.</p>;
 return <div className="mt-3 rounded-2xl border border-market-line bg-white p-4">
  <h4 className="font-black">{model.form.title}</h4>{model.form.description?<p className="mt-1 text-xs leading-5 text-market-muted">{model.form.description}</p>:null}
  {model.deposit?.amount>0?<div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-sm font-black">Initial deposit: {formatGhs(model.deposit.amount)}</p><p className="mt-1 text-xs text-amber-900">Required by {providerName}. Payment is routed through the configured payment provider to the financing provider's payment account; it does not mark the merchandise order fully paid.</p><div className="mt-2 flex flex-wrap gap-2">{depositMethods.map((m:string)=><button type="button" key={m} onClick={()=>setMethod(m)} className={`rounded-lg border px-3 py-2 text-xs font-black ${method===m?"border-black bg-black text-white":"bg-white"}`}>{m.replaceAll("_"," ")}</button>)}</div></div>:null}
  <div className="mt-4 grid gap-4">
   {fields.map(field=><label key={field.id} className="block text-sm font-bold">{field.label}{field.required?<span className="text-red-600"> *</span>:null}{field.helpText?<span className="mt-1 block text-xs font-normal text-market-muted">{field.helpText}</span>:null}
    {field.fieldType==="textarea"?<textarea value={answers[field.id]??""} maxLength={field.maxLength??4000} onChange={e=>setAnswers(a=>({...a,[field.id]:e.target.value}))} className="mt-2 min-h-24 w-full rounded-xl border p-3"/>:
     field.fieldType==="select"?<select value={answers[field.id]??""} onChange={e=>setAnswers(a=>({...a,[field.id]:e.target.value}))} className="mt-2 h-11 w-full rounded-xl border px-3"><option value="">Select…</option>{(field.options??[]).map(o=><option key={o} value={o}>{o}</option>)}</select>:
     field.fieldType==="checkbox"?<input type="checkbox" checked={answers[field.id]==="true"} onChange={e=>setAnswers(a=>({...a,[field.id]:String(e.target.checked)}))} className="ml-3"/>:
     fileTypes.has(field.fieldType)?<input type="file" accept={field.fieldType==="document"?"application/pdf,image/jpeg,image/png,image/webp":"image/jpeg,image/png,image/webp"} {...(field.fieldType==="selfie"?{capture:"user" as const}:{})} onChange={e=>setFiles(f=>({...f,[field.id]:e.target.files?.[0]}))} className="mt-2 block w-full rounded-xl border p-2 text-xs"/>:
     <input type={field.fieldType==="email"?"email":field.fieldType==="number"?"number":field.fieldType==="phone"?"tel":"text"} value={answers[field.id]??""} maxLength={field.maxLength??undefined} placeholder={field.fieldType==="ghana_card_number"?"GHA-000000000-0":undefined} onChange={e=>setAnswers(a=>({...a,[field.id]:e.target.value}))} className="mt-2 h-11 w-full rounded-xl border px-3"/>}
   </label>)}
  </div>
  <label className="mt-4 flex items-start gap-2 rounded-xl border border-market-line p-3 text-xs font-semibold"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} className="mt-0.5"/><span>I consent to ELEMARKET securely sharing these answers and uploaded documents with <b>{providerName}</b> for this financing application. The financing provider makes the approval decision.</span></label>
  {message?<p role="status" className="mt-4 rounded-xl bg-market-soft p-3 text-xs font-semibold">{message}</p>:null}
  <button type="button" disabled={busy||!consent} onClick={()=>void submit()} className="mt-4 w-full rounded-xl bg-market-green px-4 py-3 text-sm font-black text-white disabled:opacity-50">{busy?"Submitting securely…":"Submit financing application"}</button>
 </div>
}