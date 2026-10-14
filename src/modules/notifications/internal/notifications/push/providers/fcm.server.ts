import { SignJWT, importPKCS8 } from "jose";
import type { PushMessage, PushProviderAdapter, PushSendResult } from "../types";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is not configured`);
  return value;
}

function serviceAccount(): { projectId: string; clientEmail: string; privateKey: string } {
  const raw = requiredEnv("FCM_SERVICE_ACCOUNT_JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("FCM service account is invalid");
  const value = parsed as Record<string, unknown>;
  const projectId = typeof value.project_id === "string" ? value.project_id.trim() : "";
  const clientEmail = typeof value.client_email === "string" ? value.client_email.trim() : "";
  const privateKey = typeof value.private_key === "string" ? value.private_key : "";
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("FCM service account must contain project_id, client_email and private_key");
  }
  return { projectId, clientEmail, privateKey };
}

let accessTokenCache: { token: string; expiresAt: number } | undefined;

async function getAccessToken(): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache.token;
  }
  const { clientEmail, privateKey } = serviceAccount();
  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "RS256");
  const assertion = await new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null) as { access_token?: string; expires_in?: number; error?: string } | null;
  if (!response.ok || !payload?.access_token) {
    throw new Error(`FCM OAuth token request failed (${payload?.error || response.status})`);
  }
  accessTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(60_000, Number(payload.expires_in ?? 3600) * 1000),
  };
  return payload.access_token;
}

export class FcmPushAdapter implements PushProviderAdapter {
  readonly key = "fcm";

  async sendToToken(token: string, message: PushMessage): Promise<PushSendResult> {
    const { projectId } = serviceAccount();
    const accessToken = await getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
    const body = JSON.stringify({
      message: {
        token,
        notification: { title: message.title, body: message.body },
        ...(message.imageUrl ? { android: { notification: { image: message.imageUrl } } } : {}),
        ...(message.data ? { data: message.data } : {}),
      },
    });

    let lastError: Error & { status?: number; code?: string } | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body,
        redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null) as { name?: string; error?: { message?: string; status?: string; details?: Array<{ errorCode?: string }> } } | null;
      if (response.ok) return { accepted: true, providerId: payload?.name };

      const code = payload?.error?.details?.find((detail) => detail.errorCode)?.errorCode || payload?.error?.status;
      const error = new Error(`FCM send failed (${payload?.error?.message || response.status})`) as Error & { status?: number; code?: string };
      error.status = response.status;
      error.code = code;
      lastError = error;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** attempt));
    }
    throw lastError || new Error("FCM send failed");
  }
}

let singleton: FcmPushAdapter | undefined;
export function getFcmPushAdapter(): FcmPushAdapter {
  singleton ??= new FcmPushAdapter();
  return singleton;
}
