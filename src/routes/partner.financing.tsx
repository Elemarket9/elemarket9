import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy address. This page was a stale copy of /provider/financing (same
// screen, missing the application-form features); old bookmarks land on the
// maintained one.
export const Route = createFileRoute("/partner/financing")({
  beforeLoad: () => {
    throw redirect({ to: "/provider/financing" });
  },
});
