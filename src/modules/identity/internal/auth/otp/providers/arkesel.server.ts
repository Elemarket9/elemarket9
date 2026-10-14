import type {
  OtpGenerateInput,
  OtpGenerateResult,
  OtpProviderAdapter,
  OtpVerifyResult,
} from "../types";

const ARKESEL_BASE_URL = "https://sms.arkesel.com/api/otp";

function optionalEnv(name: string): string | undefined { return process.env[name]?.trim() || undefined; }

function getApiKey(): string {
  const key = process.env.ARKESEL_API_KEY?.trim();
  if (!key) throw new Error("Arkesel OTP API key is not configured");
  return key;
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${ARKESEL_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": getApiKey(),
    },
    body: JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(`Arkesel OTP request failed with HTTP ${response.status}`);
  }

  return payload as Record<string, unknown>;
}

function mapGenerateCode(code: unknown): OtpGenerateResult["code"] {
  return String(code) === "1000" ? "accepted" : "rejected";
}

function mapVerifyCode(code: unknown): OtpVerifyResult["code"] {
  switch (String(code)) {
    case "1100":
      return "verified";
    case "1104":
      return "invalid";
    case "1105":
      return "expired";
    default:
      return "rejected";
  }
}

export class ArkeselOtpAdapter implements OtpProviderAdapter {
  readonly key = "arkesel";

  async send(input: OtpGenerateInput): Promise<OtpGenerateResult> {
    const payload = await post("generate", {
      expiry: input.expiryMinutes,
      length: input.length,
      medium: "sms",
      message: optionalEnv("ARKESEL_OTP_MESSAGE") || input.message,
      number: input.number.replace(/^\+/, ""),
      sender_id: optionalEnv("ARKESEL_OTP_SENDER_ID") || input.senderId || "ELEMARKET",
      type: "numeric",
    });

    return {
      code: mapGenerateCode(payload.code),
      providerMessage: typeof payload.message === "string" ? payload.message : undefined,
    };
  }

  async verify(input: { number: string; code: string }): Promise<OtpVerifyResult> {
    const payload = await post("verify", {
      code: input.code,
      number: input.number.replace(/^\+/, ""),
    });

    return {
      code: mapVerifyCode(payload.code),
      providerMessage: typeof payload.message === "string" ? payload.message : undefined,
    };
  }
}

export function getArkeselOtpAdapter(): ArkeselOtpAdapter {
  return new ArkeselOtpAdapter();
}
