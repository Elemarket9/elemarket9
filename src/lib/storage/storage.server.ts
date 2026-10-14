import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { StoragePurpose, UploadPolicy } from "./provider";
import { getStorageProvider } from "./registry.server";

export const MAX_UPLOAD_BYTES = 560 * 1024;

const MAX_BYTES: Record<StoragePurpose, number> = {
  "product-image": MAX_UPLOAD_BYTES,
  "profile-image": MAX_UPLOAD_BYTES,
  "business-document": MAX_UPLOAD_BYTES,
  "refund-evidence": MAX_UPLOAD_BYTES,
  "order-attachment": MAX_UPLOAD_BYTES,
  "financing-application-document": MAX_UPLOAD_BYTES,
};

const ALLOWED_TYPES: Record<StoragePurpose, readonly string[]> = {
  "product-image": ["image/jpeg", "image/png", "image/webp"],
  "profile-image": ["image/jpeg", "image/png", "image/webp"],
  "business-document": ["application/pdf", "image/jpeg", "image/png"],
  "refund-evidence": ["application/pdf", "image/jpeg", "image/png", "image/webp"],
  "order-attachment": ["application/pdf", "image/jpeg", "image/png", "image/webp"],
  "financing-application-document": ["application/pdf", "image/jpeg", "image/png", "image/webp"],
};

export function validateUploadPolicy(input: UploadPolicy): void {
  if (!Object.hasOwn(MAX_BYTES, input.purpose)) throw new Error("Unsupported storage purpose");
  if (!ALLOWED_TYPES[input.purpose].includes(input.contentType)) throw new Error("File type is not allowed for this upload");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_BYTES[input.purpose]) {
    throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES} byte limit`);
  }
  if (input.resourceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.resourceId)) {
    throw new Error("Invalid resource id");
  }
}

async function authorizeUpload(userId: string, input: UploadPolicy): Promise<void> {
  if (input.purpose === "profile-image") return;
  if (!input.resourceId) throw new Error("A resource id is required for this upload purpose");
  const sql = await getSql();
  if (input.purpose === "product-image") {
    const rows = await sql.query(`select 1 from products p
      join merchant_accounts ma on ma.merchant_id=p.merchant_id
      join merchants m on m.id=p.merchant_id
      where p.id=$1 and ma.user_id=$2 and ma.status='active'
        and p.status not in ('archived','suspended') and m.status='active' limit 1`, [input.resourceId, userId]);
    if (!rows[0]) throw new Error("Forbidden");
    return;
  }
  if (input.purpose === "business-document") {
    const rows = await sql.query(`select 1 from merchants m join merchant_accounts ma on ma.merchant_id=m.id where m.id=$1 and ma.user_id=$2 and ma.status='active' and m.status <> 'suspended' limit 1`, [input.resourceId, userId]);
    if (!rows[0]) throw new Error("Forbidden");
    return;
  }
  if (input.purpose === "order-attachment") {
    const rows = await sql.query(`select 1 from orders o left join merchant_accounts ma on ma.merchant_id=o.merchant_id and ma.user_id=$2 and ma.status='active' where o.id=$1 and (o.user_id=$2 or ma.user_id=$2) limit 1`, [input.resourceId, userId]);
    if (!rows[0]) throw new Error("Forbidden");
    return;
  }
  if (input.purpose === "refund-evidence") {
    const rows = await sql.query(`select 1 from provider_refund_requests r join orders o on o.id=r.order_id left join merchant_accounts ma on ma.merchant_id=o.merchant_id and ma.user_id=$2 and ma.status='active' where r.id=$1 and (o.user_id=$2 or ma.user_id=$2) limit 1`, [input.resourceId, userId]);
    if (!rows[0]) throw new Error("Forbidden");
    return;
  }
  if (input.purpose === "financing-application-document") {
    const rows = await sql.query(`select 1 from customer_financing_quotes where id=$1 and user_id=$2 and used_at is null and expires_at>now() limit 1`, [input.resourceId, userId]);
    if (!rows[0]) throw new Error("Forbidden");
    return;
  }
  throw new Error("Unsupported storage purpose");
}

function extensionFor(contentType: string, _requested?: string): string {
  const fromType: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
  };
  const ext = (fromType[contentType] || "").toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error("Invalid file extension");
  return ext;
}

export function createStorageObjectKey(userId: string, input: UploadPolicy): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid user id");
  const ext = extensionFor(input.contentType, input.extension);
  const resource = input.resourceId ? `/${input.resourceId}` : "";
  return `${input.purpose}/${userId}${resource}/${crypto.randomUUID()}.${ext}`;
}

// Legacy direct presigning is intentionally disabled. Every upload must have a durable intent.
export async function createUploadUrl(_userId: string, _input: UploadPolicy): Promise<never> {
  throw new Error("Direct storage upload URLs are disabled; create an upload intent first");
}

function bytesAscii(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return new TextDecoder("latin1").decode(bytes.slice(start, end));
}

function hasTrailingNonWhitespace(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < bytes.length; i++) if (![0x00,0x09,0x0a,0x0d,0x20].includes(bytes[i])) return true;
  return false;
}

function matchesMagic(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
    // A JPEG must contain a real EOI marker; reject appended polyglot/script bytes.
    for (let i = 2; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return !hasTrailingNonWhitespace(bytes, i + 2);
    }
    return false;
  }
  if (contentType === "image/png") {
    if (bytes.length < 33 || bytes.slice(0,8).join(",") !== [137,80,78,71,13,10,26,10].join(",")) return false;
    const end = bytes.length - 12;
    const tail = bytes.slice(end);
    const type = bytesAscii(tail, 4, 8);
    const length = new DataView(tail.buffer, tail.byteOffset, 4).getUint32(0);
    return length === 0 && type === "IEND" && !hasTrailingNonWhitespace(bytes, bytes.length);
  }
  if (contentType === "image/webp") {
    if (bytes.length < 12 || bytesAscii(bytes,0,4) !== "RIFF" || bytesAscii(bytes,8,12) !== "WEBP") return false;
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
    return declared === bytes.length;
  }
  if (contentType === "application/pdf") {
    if (bytes.length < 8 || bytesAscii(bytes,0,5) !== "%PDF-") return false;
    const text = bytesAscii(bytes).replace(/\0/g, "");
    if (/\/(?:JS|JavaScript|AA|OpenAction)\b/i.test(text) || /<script\b|javascript:/i.test(text)) return false;
    return /%%EOF\s*$/s.test(text);
  }
  return false;
}
export class InvalidUploadedObjectError extends Error {}

export async function verifyUploadedObject(key: string, expected: Pick<UploadPolicy, "contentType" | "sizeBytes">): Promise<void> {
  const provider = getStorageProvider();
  // Propagate provider failures without deleting potentially valid content.
  const meta = await provider.headObject(key);
    if (meta.sizeBytes !== expected.sizeBytes) throw new InvalidUploadedObjectError("Stored object size does not match the authorized upload");
    if ((meta.contentType ?? "").toLowerCase() !== expected.contentType.toLowerCase()) throw new InvalidUploadedObjectError("Stored object content type does not match the authorized upload");
    const bytes = await provider.readObject(key, expected.sizeBytes);
    if (bytes.length !== expected.sizeBytes || !matchesMagic(expected.contentType, bytes)) throw new InvalidUploadedObjectError("Stored object content does not match the authorized file type");
}

export async function createUploadIntent(userId: string, input: UploadPolicy) {
  validateUploadPolicy(input);
  await authorizeUpload(userId, input);
  const key = createStorageObjectKey(userId, input);
  const id = `upi_${randomUUID().replaceAll("-", "")}`;
  const sql = await getSql();
  await sql.query(`insert into storage_upload_intents(id,user_id,purpose,resource_id,object_key,content_type,size_bytes,status,expires_at) values($1,$2,$3,$4,$5,$6,$7,'authorized',now()+interval '10 minutes')`, [id,userId,input.purpose,input.resourceId ?? null,key,input.contentType,input.sizeBytes]);
  const upload = await getStorageProvider().createPresignedUpload({ key, contentType: input.contentType, sizeBytes: input.sizeBytes, expiresInSeconds: 300 });
  return { uploadId: id, ...upload };
}

export async function finalizeUpload(userId: string, uploadId: string) {
  const sql = await getSql();
  const claimed = await sql.query<{ id:string; purpose:StoragePurpose; resource_id:string|null; object_key:string; content_type:string; size_bytes:number }>(`update storage_upload_intents set status='verifying' where id=$1 and user_id=$2 and status='authorized' and expires_at > now() returning id,purpose,resource_id,object_key,content_type,size_bytes`, [uploadId,userId]);
  const intent = claimed[0];
  if (!intent) throw new Error("Upload intent is invalid, expired, or already finalized");
  try {
    await verifyUploadedObject(intent.object_key, { contentType: intent.content_type, sizeBytes: intent.size_bytes });
    await sql.query(`update storage_upload_intents set status='verified',verified_at=now() where id=$1 and user_id=$2 and status='verifying'`, [uploadId,userId]);
    return { uploadId, key: intent.object_key, purpose: intent.purpose, resourceId: intent.resource_id, verified: true };
  } catch (error) {
    const invalid = error instanceof InvalidUploadedObjectError;
    await sql.query(`update storage_upload_intents set status=$3 where id=$1 and user_id=$2 and status='verifying'`,
      [uploadId,userId,invalid ? 'rejected' : 'authorized']);
    throw error;
  }
}
