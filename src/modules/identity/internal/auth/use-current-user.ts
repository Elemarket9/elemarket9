import { useMemo } from "react";
import { authClient } from "./client";

/** Normalized session user shape used across the app. */
export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: string | null;
  /** Retained for compatibility; session-backed users always have false here. */
  isDevFallback: boolean;
};

/** `useCurrentUserState()` result: the user plus the session-loading flag. */
export type CurrentUserState = {
  /** The user — `null` BOTH while the session loads and when signed out. */
  user: AppUser | null;
  /** True while the session is still resolving — don't treat `user: null` as signed out yet. */
  isPending: boolean;
};

/** Session-backed identity only; signed-out visitors never receive a synthetic user. */
export function useCurrentUserState(): CurrentUserState {
  const { data, isPending } = authClient.useSession();
  const sessionUser = data?.user;
  const id = sessionUser?.id;
  const name = sessionUser?.name;
  const email = sessionUser?.email;
  const image = sessionUser?.image;
  const user = useMemo<AppUser | null>(
    () =>
      id
        ? {
            id,
            displayName: name ?? null,
            primaryEmail: email ?? null,
            profileImageUrl: image ?? null,
            isDevFallback: false,
          }
        : null,
    [id, name, email, image],
  );
  return { user, isPending };
}

/**
 * Convenience view of `useCurrentUserState().user` for display (e.g.
 * `user?.displayName ?? "Guest"`). NOTE: `null` means *loading OR signed out* —
 * for redirects/guards use `useCurrentUserState()` and check `isPending`.
 */
export function useCurrentUser(): AppUser | null {
  return useCurrentUserState().user;
}
