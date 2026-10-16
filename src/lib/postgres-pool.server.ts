import type {Pool} from "pg";
/** Idle PostgreSQL socket loss is an expected outage, not an unhandled EventEmitter
 * error. Log only an error class/code; never query text or connection credentials. */
export function observePostgresPool(pool:Pool):Pool{
 pool.on('error',(error:Error&{code?:string})=>{
  const code=/^[A-Z0-9]{5}$/.test(error.code??'')?error.code:'connection_error';
  console.error('[database] connection unavailable',{code});
 });
 return pool;
}
