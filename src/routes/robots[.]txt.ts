import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () => {
        const raw = process.env.BETTER_AUTH_URL?.trim();
        const base = raw ? new URL(raw).origin : "";
        const body = ["User-agent: *", "Allow: /", "Disallow: /admin/", "Disallow: /checkout", "Disallow: /profile", "Disallow: /orders", "Disallow: /partner/", base ? `Sitemap: ${base}/sitemap.xml` : ""].filter(Boolean).join("\n") + "\n";
        return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
      },
    },
  },
});
