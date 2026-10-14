import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ACTIVE_KEY_ENV="ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV="ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY_PREVIOUS";
const VERSION="v1";

function parseKey(raw:string|undefined,name:string):Buffer|null{
  const value=raw?.trim();if(!value)return null;
  if(/^[0-9a-fA-F]{64}$/.test(value))return Buffer.from(value,"hex");
  const decoded=Buffer.from(value,"base64url");
  if(decoded.length===32)return decoded;
  throw new Error(`${name} must be a 32-byte base64url or 64-character hex value`);
}
function activeKey(){const key=parseKey(process.env[ACTIVE_KEY_ENV],ACTIVE_KEY_ENV);if(!key)throw new Error(`${ACTIVE_KEY_ENV} is not configured`);return key}
function decryptWith<T>(payload:string,key:Buffer):T{
  const [v,iv,tag,ciphertext]=payload.split(".");
  if(v!==VERSION||!iv||!tag||!ciphertext)throw new Error("Invalid encrypted financing data");
  const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext,"base64url")),decipher.final()]).toString("utf8")) as T;
}
export function encryptFinancingSensitiveData(value:unknown):string{
  const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",activeKey(),iv);
  const encrypted=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value),"utf8")),cipher.final()]);
  return [VERSION,iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),encrypted.toString("base64url")].join(".");
}
export function decryptFinancingSensitiveData<T>(payload:string):T{
  try{return decryptWith<T>(payload,activeKey())}catch(first){const previous=parseKey(process.env[PREVIOUS_KEY_ENV],PREVIOUS_KEY_ENV);if(!previous)throw first;return decryptWith<T>(payload,previous)}
}
