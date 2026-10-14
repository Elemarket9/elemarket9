import { Link } from "@tanstack/react-router";
import { CircleUserRound, Headphones, LogIn, MapPin, Package, Search, ShoppingBag, Store } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { MerchantWorkspaceLink, SignedIn, SignedOut, UserButton } from "@/modules/identity/public/auth/gates";
import { cartCount, readCart, type CartLine } from "@/modules/ordering/public/cart";
import { portalHref } from "@/lib/portal-links";
import { PushNotificationButton } from "@/components/push-notification-button";

/** A consistent, keyboard-accessible storefront shell for customer routes. */
export function MarketHeader({ afterBrand, trailing }: { afterBrand?: ReactNode; trailing?: ReactNode }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  useEffect(() => {
    const sync = () => setCart(readCart());
    sync();
    window.addEventListener("elemarket:cart-updated", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("elemarket:cart-updated", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const count = cartCount(cart);

  return (
    <>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header className="sticky top-0 z-40 border-b border-market-line bg-white/95 shadow-[0_1px_6px_rgb(0_0_0_/_0.03)] backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 max-w-[1440px] items-center gap-2 px-4 sm:gap-4 sm:px-6 lg:px-8">
          {afterBrand}
          <Link to="/" className="shrink-0 text-lg font-black tracking-[-0.045em] text-market-green sm:text-2xl" aria-label="ELEMARKET home">
            ELE<span className="text-market-orange">MARKET</span>
          </Link>
          <span className="hidden items-center gap-1.5 border-l border-market-line pl-4 text-xs font-semibold text-market-muted xl:inline-flex"><MapPin size={15} aria-hidden="true"/> Shop Ghana</span>
          <nav className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2" aria-label="Storefront navigation">
            {trailing}
            <Link to="/" className="market-icon-link sm:hidden" aria-label="Search products"><Search size={19} aria-hidden="true" /></Link>
            <Link to="/" className="market-text-link hidden sm:inline-flex"><Search size={17} aria-hidden="true" /> Search</Link>
            <Link to="/orders" className="market-text-link hidden lg:inline-flex"><Package size={17} aria-hidden="true" /> Orders</Link>
            <Link to="/help" className="market-text-link hidden xl:inline-flex"><Headphones size={17} aria-hidden="true" /> Help</Link>
            <SignedOut>
              <Link to="/login" className="market-icon-link sm:hidden" aria-label="Sign in"><LogIn size={19} aria-hidden="true" /></Link>
              <Link to="/login" className="market-text-link hidden sm:inline-flex">Sign in</Link>
              <a href={portalHref("seller", "/merchant/register")} className="market-text-link hidden lg:inline-flex"><Store size={17} aria-hidden="true" /> Sell</a>
            </SignedOut>
            <SignedIn>
              <Link to="/profile" className="market-icon-link sm:hidden" aria-label="My account"><CircleUserRound size={19} aria-hidden="true" /></Link>
              <PushNotificationButton />
              <div className="hidden lg:block"><MerchantWorkspaceLink className="market-text-link" /></div>
              <div className="hidden max-w-[180px] truncate sm:block"><UserButton /></div>
            </SignedIn>
            <Link to="/cart" className="market-icon-link relative" aria-label={`Shopping cart, ${count} item${count === 1 ? "" : "s"}`}>
              <ShoppingBag size={19} aria-hidden="true" />
              {count > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-market-orange px-1 text-[10px] font-black text-white">{count > 99 ? "99+" : count}</span>}
            </Link>
          </nav>
        </div>
      </header>
    </>
  );
}

export function MarketFooter() {
  return (
    <footer className="mt-12 border-t border-market-line bg-white" aria-label="Storefront footer">
      <div className="mx-auto grid max-w-[1440px] gap-8 px-4 py-10 text-sm sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
        <div>
          <Link to="/" className="text-xl font-black tracking-[-.045em] text-market-green">ELE<span className="text-market-orange">MARKET</span></Link>
          <p className="mt-3 max-w-xs leading-6 text-market-muted">Discover products from merchants across Ghana, with clear checkout information and customer support.</p>
          <p className="mt-4 text-xs font-semibold text-market-muted">Powered by ELEVORA TRADING LIMITED</p>
        </div>
        <nav aria-label="Shopping and account"><h2 className="font-black text-market-ink">Shop & account</h2><div className="mt-4 grid gap-3 text-market-muted"><Link to="/">Explore products</Link><Link to="/cart">Shopping cart</Link><Link to="/orders">My orders</Link><Link to="/profile">My profile</Link></div></nav>
        <nav aria-label="Customer help"><h2 className="font-black text-market-ink">Help & policies</h2><div className="mt-4 grid gap-3 text-market-muted"><Link to="/help">Help centre</Link><button type="button" onClick={() => window.dispatchEvent(new Event("elemarket:open-support"))} className="text-left hover:text-market-green">Open support chat</button><Link to="/support">Support centre</Link><Link to="/returns-policy">Returns & refunds</Link><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link></div></nav>
        <nav aria-label="Business services"><h2 className="font-black text-market-ink">Work with ELEMARKET</h2><div className="mt-4 grid gap-3 text-market-muted"><a href={portalHref("seller", "/merchant/register")}>Become a merchant</a><a href={portalHref("seller", "/merchant/login")}>Merchant workspace</a><a href={portalHref("provider", "/provider/")}>Delivery & financing partners</a></div></nav>
      </div>
      <div className="border-t border-market-line bg-market-bg/60"><p className="mx-auto max-w-[1440px] px-4 py-4 text-xs leading-5 text-market-muted sm:px-6 lg:px-8">Prices are in Ghana cedis (GHS). Delivery fees and availability are confirmed at checkout. Financing, where available, is subject to independent provider terms and approval.</p></div>
    </footer>
  );
}
