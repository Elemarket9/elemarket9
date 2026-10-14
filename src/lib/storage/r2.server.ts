import { createHash, createHmac } from "node:crypto";
import { env } from "@/lib/env.server";
import type { PresignedUpload, StorageProvider } from "./provider";

const DEFAULT_EXPIRES = 900;
const MAX_EXPIRES = 604800;

function required(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((part) => awsEncode(decodeURIComponent(part)))
    .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([aKey, aValue], [bKey, bValue]) => {
      const keyOrder = aKey.localeCompare(bKey);
      return keyOrder !== 0 ? keyOrder : aValue.localeCompare(bValue);
    })
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join("&");
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[\t ]+/g, " ");
}

function assertContentType(value: string): string {
  const normalized = canonicalHeaderValue(value);
  if (normalized.length < 3 || normalized.length > 100 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(normalized)) {
    throw new Error("Invalid content type");
  }
  return normalized;
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function normalizeExpires(value?: number): number {
  const expires = value ?? DEFAULT_EXPIRES;
  if (!Number.isInteger(expires) || expires < 1 || expires > MAX_EXPIRES) {
    throw new Error(`Storage URL expiry must be between 1 and ${MAX_EXPIRES} seconds`);
  }
  return expires;
}

function validateKey(key: string): string {
  const normalized = key.trim().replace(/^\/+/, "");
  if (!normalized || normalized.length > 1024) throw new Error("Invalid storage object key");
  if (normalized.includes("..") || normalized.includes("\\")) {
    throw new Error("Invalid storage object key");
  }
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      throw new Error("Invalid storage object key");
    }
  }
  return normalized;
}

export class CloudflareR2StorageProvider implements StorageProvider {
  private readonly accountId: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly region = "auto";

  constructor() {
    this.accountId = required("CLOUDFLARE_R2_ACCOUNT_ID");
    this.accessKeyId = required("CLOUDFLARE_R2_ACCESS_KEY_ID");
    this.secretAccessKey = required("CLOUDFLARE_R2_SECRET_ACCESS_KEY");
    this.bucket = required("CLOUDFLARE_R2_BUCKET");

    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(this.bucket)) {
      throw new Error("CLOUDFLARE_R2_BUCKET is invalid");
    }
    if (!/^[a-f0-9]{32}$/i.test(this.accountId)) {
      throw new Error("CLOUDFLARE_R2_ACCOUNT_ID is invalid");
    }

    this.endpoint = `https://${this.bucket}.${this.accountId}.r2.cloudflarestorage.com`;
  }

  private signedUrl(
    method: "GET" | "PUT",
    key: string,
    expiresInSeconds: number,
    contentType?: string,
    contentLength?: number,
  ): { url: string; expiresAt: string } {
    const safeKey = validateKey(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const shortDate = amzDate.slice(0, 8);
    const credential = `${this.accessKeyId}/${shortDate}/${this.region}/s3/aws4_request`;
    const url = new URL(`${this.endpoint}/${safeKey.split("/").map(awsEncode).join("/")}`);

    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", credential);
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    const isUpload = method === "PUT";
    // PUT signatures bind the exact byte count as well as content-type/host.
    // This prevents a 560 KB authorization from being reused for a larger object.
    // AWS SigV4 requires both canonical headers and SignedHeaders to be sorted bytewise.
    // The previous order (content-length, if-none-match, content-type, host) made PUT signatures invalid.
    const headerEntries: Array<[string,string]> = [
      ...(isUpload ? [["content-length", String(contentLength ?? 0)], ["if-none-match", "*"]] as Array<[string,string]> : []),
      ...(contentType ? [["content-type",canonicalHeaderValue(contentType)]] as Array<[string,string]> : []),
      ["host", url.host],
    ];
    headerEntries.sort(([a],[b])=>a<b?-1:a>b?1:0);
    const signedHeaders = headerEntries.map(([key])=>key).join(";");
    url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
    const canonicalHeaders = headerEntries.map(([key,value])=>`${key}:${value}\n`).join("");
    const canonicalRequest = [
      method,
      canonicalUri(url.pathname),
      canonicalQuery(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const signature = createHmac("sha256", signingKey(this.secretAccessKey, shortDate, this.region))
      .update(stringToSign)
      .digest("hex");

    url.searchParams.set("X-Amz-Signature", signature);

    return {
      url: url.toString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async createPresignedUpload(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload> {
    const contentType = assertContentType(input.contentType);
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 560 * 1024) {
      throw new Error("Upload size exceeds the 560 KB maximum");
    }
    const expires = normalizeExpires(input.expiresInSeconds);
    const signed = this.signedUrl("PUT", input.key, expires, contentType, input.sizeBytes);
    return { key: validateKey(input.key), uploadUrl: signed.url, expiresAt: signed.expiresAt, maxBytes: input.sizeBytes, requiredHeaders: { "content-length": String(input.sizeBytes), "content-type": contentType, "if-none-match": "*" } };
  }

  async createPresignedDownload(input: {
    key: string;
    expiresInSeconds?: number;
  }): Promise<{ key: string; downloadUrl: string; expiresAt: string }> {
    const expires = normalizeExpires(input.expiresInSeconds);
    const signed = this.signedUrl("GET", input.key, expires);
    return { key: validateKey(input.key), downloadUrl: signed.url, expiresAt: signed.expiresAt };
  }

  private async signedRequest(method: "DELETE" | "HEAD", key: string): Promise<Response> {
    const safeKey = validateKey(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const shortDate = amzDate.slice(0, 8);
    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const url = new URL(`${this.endpoint}/${safeKey.split("/").map(awsEncode).join("/")}`);
    const payloadHash = sha256Hex("");
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders =
      `host:${url.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const canonicalRequest = [
      method,
      canonicalUri(url.pathname),
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = createHmac("sha256", signingKey(this.secretAccessKey, shortDate, this.region))
      .update(stringToSign)
      .digest("hex");

    return fetch(url, {
      method,
      headers: {
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  }

  async readObject(key: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 560 * 1024) throw new Error("Invalid storage read limit");
    const safeKey = validateKey(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const shortDate = amzDate.slice(0, 8);
    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const url = new URL(`${this.endpoint}/${safeKey.split("/").map(awsEncode).join("/")}`);
    const payloadHash = "UNSIGNED-PAYLOAD";
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = `host:${url.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const canonicalRequest = ["GET", canonicalUri(url.pathname), "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.secretAccessKey, shortDate, this.region)).update(stringToSign).digest("hex");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        Range: `bytes=0-${maxBytes - 1}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`R2 GET failed with HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? "-1");
    if (!Number.isInteger(contentLength) || contentLength < 1 || contentLength > maxBytes) throw new Error("Stored object exceeds the validation read limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== contentLength || bytes.length > maxBytes) throw new Error("Stored object read size mismatch");
    return bytes;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.signedRequest("DELETE", key);
    if (!response.ok && response.status !== 404) {
      throw new Error(`R2 delete failed with HTTP ${response.status}`);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    const response = await this.signedRequest("HEAD", key);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`R2 HEAD failed with HTTP ${response.status}`);
    return true;
  }

  async headObject(key: string): Promise<{ sizeBytes: number; contentType?: string | null }> {
    const response = await this.signedRequest("HEAD", key);
    if (response.status === 404) throw new Error("Object not found");
    if (!response.ok) throw new Error(`R2 HEAD failed with HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? "-1");
    if (!Number.isInteger(size) || size < 1 || size > 560 * 1024) throw new Error("Stored object violates the 560 KiB storage policy");
    return { sizeBytes: size, contentType: response.headers.get("content-type") };
  }
}
