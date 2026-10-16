import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { structuredLog } from "@/lib/observability/logger.server";
import { redisCommand } from "@/lib/security/redis-rate-limit.server";

// One bounded shared check per interval, no externally observable DB/Redis
// names or environment details; negative results are cached as well.
let cached: {until:number; probe:Promise<boolean>}|undefined;
async function probeReadiness():Promise<boolean>{
  try{
    const sql=await getSql();await sql.query("select 1 as ok");
    const redis=process.env.REDIS_URL?.trim();
    if(redis?.startsWith("redis://")||redis?.startsWith("rediss://")){
      try{if(await redisCommand(redis,["PING"])!=="PONG")throw new Error("Invalid cache response");}
      catch(error){structuredLog("warn","health.cache_failed",{metadata:{error:error instanceof Error?error.message:String(error)}});}
    }
    return true;
  }
  catch(error){structuredLog("error","health.database_failed",{metadata:{error:error instanceof Error?error.message:String(error)}});return false;}
}
function health():Promise<boolean>{
  const now=Date.now();
  if(cached && now<cached.until)return cached.probe;
  const probe=probeReadiness();
  cached={until:now+10000,probe};
  return probe;
}
export const Route = createFileRoute("/api/health")({
  server:{handlers:{GET:async()=>{
    const ok=await health();
    return Response.json({ok},{status:ok?200:503,headers:{"cache-control":"no-store"}});
  }}},
});
