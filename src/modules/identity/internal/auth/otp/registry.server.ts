import type { OtpProviderAdapter } from "./types";
import { env } from "@/lib/env.server";
import { getArkeselOtpAdapter } from "./providers/arkesel.server";

export function getOtpAdapter(providerKey?: string): OtpProviderAdapter {
  const selected = (providerKey ?? env("ELEMARKET_OTP_PROVIDER") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(selected)) throw new Error("Invalid OTP provider");
  if (selected === "arkesel") return getArkeselOtpAdapter();
  throw new Error(`OTP provider '${selected}' is not configured`);
}
