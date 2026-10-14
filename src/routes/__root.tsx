import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider } from "@/modules/identity/public/auth/provider";
import { portalHref, isMarketplaceOrigin } from "@/lib/portal-links";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ELEMARKET — Shop Ghana" },
      { name: "description", content: "A modern Ghana marketplace for food, fashion, electronics, groceries and more." },
      { name: "theme-color", content: "#0b3d2e" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootDocument,
  errorComponent: () => (
    <main className="grid min-h-screen place-items-center bg-market-bg px-4">
      <section className="w-full max-w-lg rounded-3xl border border-market-line bg-white p-7 text-center shadow-market">
        <p className="text-xs font-black uppercase tracking-[.14em] text-market-orange">ELEMARKET</p>
        <h1 className="mt-3 text-2xl font-black">We could not load this page</h1>
        <p className="mt-2 text-sm leading-6 text-market-muted">Try again, or return to the marketplace. You can check My orders for the latest order status.</p>
        <div className="mt-6 flex justify-center gap-2"><button type="button" onClick={() => window.location.reload()} className="rounded-xl border border-market-line px-4 py-3 text-sm font-black">Try again</button><a href={portalHref("marketplace")} className="rounded-xl bg-market-green px-4 py-3 text-sm font-black text-white">Marketplace</a></div>
      </section>
    </main>
  ),
  notFoundComponent: () => (
    <main className="grid min-h-screen place-items-center bg-market-bg px-4">
      <section className="w-full max-w-lg rounded-3xl border border-market-line bg-white p-7 text-center shadow-market">
        <p className="text-xs font-black uppercase tracking-[.14em] text-market-orange">404</p>
        <h1 className="mt-3 text-2xl font-black">Page not found</h1>
        <p className="mt-2 text-sm text-market-muted">The page may have moved or the link may be incorrect.</p>
        <a href={portalHref("marketplace")} className="mt-6 inline-flex rounded-xl bg-market-green px-5 py-3 text-sm font-black text-white">Back to marketplace</a>
      </section>
    </main>
  ),
});


function RootDocument() {
  useEffect(() => {
    // Only the public storefront registers the shopping PWA worker.
    // Administrative, merchant, and provider origins are not installable shopping apps.
    if (!isMarketplaceOrigin()) return;
    if (/^\/(admin|merchant|provider)(\/|$)/.test(window.location.pathname)) return;
    if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = document.createElement("link");
      manifest.rel = "manifest";
      manifest.href = "/manifest.webmanifest";
      document.head.appendChild(manifest);
    }
    void navigator.serviceWorker.register("/app-sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return <html lang="en" suppressHydrationWarning><head><HeadContent /></head><body><AuthProvider><Outlet /></AuthProvider><Scripts /></body></html>;
}
