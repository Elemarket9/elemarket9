import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
export const authClient = createAuthClient({ plugins: [twoFactorClient({ twoFactorPage: "/two-factor" })] });
// Authentication is always real; legacy preview flags cannot disable it.
export const authEnabled = true;
export async function signOut(redirectTo = "/"): Promise<void> {
  const { error } = await authClient.signOut();
  if (error) throw new Error(error.message ?? "Sign-out failed");
  if (typeof window !== "undefined" && redirectTo) window.location.href = redirectTo;
}
