import type { KYBProvider, KybResult, KybVerifyInput } from "../provider";

const DEFAULT_BASE_URL = "https://www.fylings.com";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

function env(name: string): string | undefined {
  const value = typeof process !== "undefined" ? process.env[name] : undefined;
  return value?.trim() || undefined;
}

function asDecision(value: unknown): KybResult["decision"] {
  if (value === "verified") return "VERIFIED";
  if (value === "not_found") return "NOT_FOUND";
  return "REVIEW";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class FylingsAdapter implements KYBProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey = env("FYLINGS_API_KEY"), baseUrl = env("FYLINGS_BASE_URL") ?? DEFAULT_BASE_URL) {
    if (!apiKey) throw new Error("FYLINGS_API_KEY is not configured");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new Error("FYLINGS_BASE_URL must use HTTPS");
    this.apiKey = apiKey;
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }

  async verifyBusiness(input: KybVerifyInput): Promise<KybResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const payload = {
        ...(input.businessName.trim() ? { name: input.businessName.trim() } : {}),
        ...(input.registrationNumber?.trim() ? { registration_no: input.registrationNumber.trim() } : {}),
        country: input.country.trim().toUpperCase(),
      };

      if (!payload.name && !payload.registration_no) {
        throw new Error("A business name or registration number is required for KYB");
      }

      const response = await fetch(`${this.baseUrl}/api/v1/verify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      });

      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error("KYB provider response is too large");
      }

      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
        throw new Error("KYB provider response is too large");
      }

      let body: Record<string, unknown> = {};
      try {
        body = raw ? asRecord(JSON.parse(raw)) : {};
      } catch {
        throw new Error(`Fylings returned invalid JSON (${response.status})`);
      }

      if (!response.ok) {
        const detail = typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : `Fylings request failed (${response.status})`;
        throw new Error(detail);
      }

      const company = asRecord(body.company);
      const sanctions = asRecord(body.sanctions);
      const result = asDecision(body.result);

      return {
        decision: result,
        registered: body.registered === true,
        provider: "fylings",
        providerReference: typeof company.registration_no === "string" ? company.registration_no : undefined,
        legalName: typeof company.legal_name === "string" ? company.legal_name : undefined,
        registrationNumber: typeof company.registration_no === "string" ? company.registration_no : undefined,
        status: typeof company.status === "string" ? company.status : undefined,
        matchConfidence: asFiniteNumber(body.match_confidence),
        dataConfidence: asFiniteNumber(body.data_confidence),
        sanctionsClear: sanctions.result === "clear" ? true : sanctions.result === "hit" ? false : undefined,
        evidence: {
          result: body.result,
          registered: body.registered,
          match_confidence: body.match_confidence,
          company,
          sanctions,
          data_confidence: body.data_confidence,
          signals: body.signals,
          sources: body.sources,
          checked_at: body.checked_at,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Fylings KYB request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function getKybProvider(): KYBProvider | null {
  if (!env("FYLINGS_API_KEY")) return null;
  return new FylingsAdapter();
}
