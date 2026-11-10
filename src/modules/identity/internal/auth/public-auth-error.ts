const GENERIC = {
  "sign-in": "Could not sign in. Check your email and password.",
  "sign-up": "Could not create an account with those details. If you have an account, sign in.",
} as const;

/** One message per action so provider text cannot reveal whether an account exists. */
export function publicAuthError(kind: keyof typeof GENERIC): string {
  return GENERIC[kind];
}
