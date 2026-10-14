import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
export const authClient = createAuthClient({ plugins: [twoFactorClient({ twoFactorPage: "/two-factor" })] });
export const authEnabled = import.meta.env.VITE_AUTH_ENABLED !== "false";
export async function signOut(redirectTo = "/"): Promise<void> {
  const { error } = await authClient.signOut();
  if (error) throw new Error(error.message ?? "Sign-out failed");
  if (typeof window !== "undefined" && redirectTo) window.location.href = redirectTo;
}
