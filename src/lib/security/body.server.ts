/** Deadlines apply even if the sender never completes a body chunk. */
export async function readBodyWithLimit(request: Request, maxBytes: number, timeoutMs = 10000): Promise<string> {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new Error("Invalid body byte limit");
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>60000)throw new Error("Invalid body deadline");
  const declared = Number(request.headers.get("content-length") ?? "");
  if(Number.isFinite(declared) && declared>maxBytes)throw new Error("Payload too large");
  if(!request.body)return "";
  const reader=request.body.getReader();
  const chunks:Uint8Array[]=[];
  let total=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let timedOut=false;
  const deadline=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{timedOut=true;reject(new Error("Request body timed out"));void reader.cancel("Request body timed out").catch(()=>undefined);},timeoutMs);
  });
  try {
    while(true){
      const {done,value}=await Promise.race([reader.read(),deadline]);
      if(timedOut)throw new Error("Request body timed out");
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){void reader.cancel().catch(()=>undefined);throw new Error("Payload too large");}
      chunks.push(value);
    }
  }finally{
    if(timer)clearTimeout(timer);
    try{reader.releaseLock();}catch{/* an outstanding cancelled read releases asynchronously */}
  }
  const out=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder("utf-8",{fatal:false}).decode(out);
}

export async function readResponseBodyWithLimit(response: Response, maxBytes: number, timeoutMs = 10000): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid body byte limit");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new Error("Invalid body deadline");
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel("Response too large").catch(() => undefined);
    throw new Error("Response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("Response body timed out"));
      void reader.cancel("Response body timed out").catch(() => undefined);
    }, timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (timedOut) throw new Error("Response body timed out");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel("Response too large").catch(() => undefined);
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
  } finally {
    if (timer) clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* Cancellation can finish asynchronously. */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(out);
}
