import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { createStorageUploadUrl, finalizeStorageUpload } from "@/lib/storage/storage";
import { attachMerchantProductImage, removeMerchantProductImage, setMerchantProductPrimaryImage } from "@/modules/merchants/public/transport/merchant/dashboard.functions";

type Image = { id:string; product_id:string; alt_text:string|null; is_primary:boolean; url:string };
type Props = { merchantId:string; productId:string; productName:string; existing:Image[]; canEdit:boolean };
const allowed = new Set(["image/jpeg","image/png","image/webp"]);
const limit = 560 * 1024;

export function MerchantProductImageManager({merchantId,productId,productName,existing,canEdit}:Props) {
  const router=useRouter();
  const [file,setFile]=useState<File|null>(null);
  const [preview,setPreview]=useState<string|null>(null);
  const [alt,setAlt]=useState(productName);
  const [primary,setPrimary]=useState(existing.length===0);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  useEffect(()=>{setFile(null);setAlt(productName);setPrimary(existing.length===0);setMessage(null)},[productId,productName,existing.length]);
  useEffect(()=>{
    if(!file){setPreview(null);return}
    const url=URL.createObjectURL(file);setPreview(url);
    return()=>URL.revokeObjectURL(url);
  },[file]);

  async function execute(work:()=>Promise<unknown>,done:string){
    setBusy(true);setMessage(null);
    try { await work();setMessage(done);await router.invalidate(); }
    catch(error){setMessage(error instanceof Error?error.message:"Image operation failed. Please try again.");}
    finally {setBusy(false);}
  }
  async function upload(){
    if(!file)throw new Error("Choose an image to upload");
    if(!allowed.has(file.type))throw new Error("Only JPEG, PNG and WebP product photographs are allowed");
    if(file.size<1||file.size>limit)throw new Error("Image must be 560 KB or smaller");
    if(existing.length>=8)throw new Error("Maximum 8 photos per listing");
    const label=alt.trim();if(label.length<3||label.length>240)throw new Error("Describe the product photo in 3–240 characters");
    setMessage("Requesting secure upload…");
    const created=await createStorageUploadUrl({data:{purpose:"product-image",resourceId:productId,contentType:file.type,sizeBytes:file.size}});
    const headers=new Headers(created.requiredHeaders??{});
    headers.set("content-type",file.type);
    // Browsers set Content-Length from the File body automatically; scripts cannot set it.
    headers.delete("content-length");
    setMessage("Uploading and verifying image…");
    const response=await fetch(created.uploadUrl,{method:"PUT",headers,body:file,signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error(`Storage rejected the upload (HTTP ${response.status}). Check storage upload permissions and cross-origin configuration.`);
    const finalized=await finalizeStorageUpload({data:{uploadId:created.uploadId}});
    if(!finalized.verified)throw new Error("The uploaded image could not be verified");
    await attachMerchantProductImage({data:{merchantId,productId,uploadId:created.uploadId,altText:label,makePrimary:primary}});
    setFile(null);
  }
  return <section aria-label={`Product images for ${productName}`} className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h4 className="font-black text-market-ink">Product photography</h4><p className="mt-1 text-xs leading-5 text-market-muted">{existing.length}/8 photographs · JPEG, PNG, or WebP · maximum 560 KB each. Changes return the listing to moderation.</p></div>
      {existing.length===0?<span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">No images yet</span>:null}
    </div>
    {existing.length>0?<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {existing.map(image=><div key={image.id} className="overflow-hidden rounded-xl border border-market-line bg-white">
        <div className="relative aspect-square bg-market-soft"><img loading="lazy" src={image.url} alt={image.alt_text??productName} className="h-full w-full object-contain"/>{image.is_primary?<span className="absolute left-2 top-2 rounded-full bg-market-green px-2 py-1 text-[10px] font-black text-white">Cover</span>:null}</div>
        <div className="flex flex-wrap gap-2 p-2">
          {!image.is_primary?<button type="button" disabled={busy||!canEdit} onClick={()=>void execute(()=>setMerchantProductPrimaryImage({data:{merchantId,productId,mediaId:image.id}}),"Cover updated; listing sent for review.")} className="rounded-lg bg-market-soft px-2 py-1 text-xs font-bold disabled:opacity-50">Set cover</button>:null}
          <button type="button" disabled={busy||!canEdit} onClick={()=>{if(window.confirm("Remove this product photograph?"))void execute(()=>removeMerchantProductImage({data:{merchantId,productId,mediaId:image.id}}),"Photograph removed.")}} className="rounded-lg bg-red-50 px-2 py-1 text-xs font-bold text-red-700 disabled:opacity-50">Remove</button>
        </div>
      </div>)}
    </div>:<p className="rounded-xl border border-dashed border-market-line bg-market-soft p-5 text-sm text-market-muted">Add a clear primary image so customers can recognize this product.</p>}
    {canEdit&&existing.length<8?<form onSubmit={e=>{e.preventDefault();void execute(upload,"Image uploaded and attached. Listing sent for review.")}} className="grid gap-3 rounded-xl border border-market-line p-4 sm:grid-cols-[180px_1fr]">
      <label className="block text-sm font-semibold sm:col-span-2">Choose a product photograph <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e=>{const f=e.target.files?.[0]??null;setFile(f);setMessage(f&&(!allowed.has(f.type)||f.size>limit)?"Unsupported type or file exceeds 560 KB":null)}} className="mt-2 block w-full text-sm"/></label>
      {preview?<img alt="Selected upload preview" src={preview} className="h-40 w-full rounded-lg border border-market-line object-contain"/>:<div className="grid h-40 place-items-center rounded-lg bg-market-soft text-sm text-market-muted">Photo preview</div>}
      <div className="space-y-3"><label className="block text-sm font-semibold">Accessible photo description<input required minLength={3} maxLength={240} value={alt} onChange={e=>setAlt(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3"/></label><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={primary} onChange={e=>setPrimary(e.target.checked)}/> Set as cover image</label><button type="submit" disabled={!file||busy||!allowed.has(file.type)||file.size>limit} className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50">{busy?"Processing…":"Upload photograph"}</button></div>
    </form>:null}
    {message?<p role="status" aria-live="polite" className="rounded-xl bg-market-soft p-3 text-sm font-semibold">{message}</p>:null}
  </section>;
}
