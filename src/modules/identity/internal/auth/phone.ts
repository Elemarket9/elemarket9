import { z } from "zod";

/** Canonical application/storage format. Provider wire formatting belongs in its adapter. */
export function normalizeGhanaPhone(value: string): string {
  const phone = value.trim();
  if (/^0[25]\d{8}$/.test(phone)) return `+233${phone.slice(1)}`;
  if (/^233[25]\d{8}$/.test(phone)) return `+${phone}`;
  if (/^\+233[25]\d{8}$/.test(phone)) return phone;
  throw new Error("Enter a valid Ghana mobile number");
}

export const ghanaPhoneSchema = z.string().trim().transform((value, context) => {
  try { return normalizeGhanaPhone(value); }
  catch { context.addIssue({ code: "custom", message: "Enter a valid Ghana mobile number" }); return z.NEVER; }
});
