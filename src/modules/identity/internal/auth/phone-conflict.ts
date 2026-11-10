/** Generic profile failure. Do not disclose that another profile owns the number. */
export const PHONE_SAVE_REJECTED = "Phone number could not be saved";

export function isPhoneUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && String((error as { code?: unknown }).code) === "23505";
}
