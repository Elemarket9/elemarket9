import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ACTIVE_KEY_ENV = "ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV = "ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY_PREVIOUS";
const VERSION = "v1";


function parseKey(raw: string | undefined, envName: string): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 32) return decoded;
  throw new Error(`${envName} must be a 32-byte base64url or 64-character hex value`);
}

function getActiveKey(): Buffer {
  const key = parseKey(process.env[ACTIVE_KEY_ENV], ACTIVE_KEY_ENV);
  if (!key) throw new Error(`${ACTIVE_KEY_ENV} is not configured`);
  return key;
}

function decryptWithKey<T>(payload: string, key: Buffer): T {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = payload.split(".");
  if (version !== VERSION || !ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Invalid encrypted merchant data");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function encryptMerchantSensitiveData(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getActiveKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/**
 * Decryption supports one previous key during an intentional rotation window.
 * Encryption always uses the active key. The previous key must be removed after
 * the rotation job completes and all rows have been re-encrypted.
 */
export function decryptMerchantSensitiveData<T>(payload: string): T {
  try {
    return decryptWithKey<T>(payload, getActiveKey());
  } catch (activeError) {
    const previous = parseKey(process.env[PREVIOUS_KEY_ENV], PREVIOUS_KEY_ENV);
    if (!previous) throw activeError;
    return decryptWithKey<T>(payload, previous);
  }
}

export function sensitiveValueFingerprint(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}
