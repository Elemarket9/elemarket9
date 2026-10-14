import { safeImageSource } from "@/modules/shared/public/media";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Minus, Plus, ShoppingBag, Trash2, ArrowRight, ArrowLeft, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatGhs } from "@/modules/shared/public/money";
import { cartCount, cartTotal, readCart, writeCart, type CartLine } from "@/modules/ordering/public/cart";
import { ContactSupportWidget } from "@/components/contact-support-widget";
import { MarketFooter, MarketHeader } from "@/components/market-header";

export const Route = createFileRoute("/cart")({
  head: () => ({ meta: [{ title: "Shopping cart | ELEMARKET" }, { name: "robots", content: "noindex,follow" }] }),
  component: Cart,
});

function Cart() {
  const navigate = useNavigate();
  const [cart, setCart] = useState<CartLine[]>([]);
  useEffect(() => {
    const sync = () => setCart(readCart());
    sync();
    window.addEventListener("elemarket:cart-updated", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("elemarket:cart-updated", sync); window.removeEventListener("storage", sync); };
  }, []);
  const total = useMemo(() => cartTotal(cart), [cart]);
  const count = cartCount(cart);
  const update = (index: number, delta: number) => {
    writeCart(readCart().map((item, i) => {
      if (i !== index) return item;
      // The cart is only a client-side preview. Server stock is checked at checkout.
      return { ...item, quantity: Math.min(20, Math.max(0, item.quantity + delta)) };
    }).filter(item => item.quantity > 0));
  };

  return (
    <div className="min-h-screen bg-market-bg">
      <MarketHeader />
      <ContactSupportWidget mode="order" />
      <main id="main-content" className="mx-auto max-w-[1180px] px-4 py-7 pb-16 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs font-semibold text-market-muted"><Link to="/" className="hover:text-market-green">Shop</Link><span aria-hidden="true">/</span><span aria-current="page" className="text-market-ink">Cart</span></nav>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-3"><div><p className="eyebrow">Ready to order?</p><h1 className="section-title">Your shopping cart</h1><p className="mt-2 text-sm text-market-muted">{count} item{count === 1 ? "" : "s"} · Review your choices before checkout</p></div><Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-market-green"><ArrowLeft size={16} aria-hidden="true"/> Continue shopping</Link></div>
        <div className="mt-7 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-label="Cart items" className="rounded-2xl border border-market-line bg-white p-4 shadow-market sm:p-6">
            {!cart.length ? <div className="py-14 text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-market-soft text-market-green"><ShoppingBag size={30} aria-hidden="true" /></div><h2 className="mt-5 text-xl font-black">Your cart is waiting</h2><p className="mx-auto mt-2 max-w-sm text-sm text-market-muted">Explore stores and add the products you love. They will appear here before checkout.</p><Link to="/" className="market-btn-primary mt-6">Explore products <ArrowRight size={17} aria-hidden="true"/></Link></div>
            : <ul className="divide-y divide-market-line">{cart.map((item, i) => <li key={`${item.productId}:${item.variantId ?? "base"}:${i}`} className="flex min-w-0 flex-wrap gap-4 py-5 first:pt-1 last:pb-1 sm:flex-nowrap">
              <Link to="/products/$id" params={{ id: item.productId }} className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl bg-market-bg sm:h-28 sm:w-28"><CartImage source={item.imagePath} name={item.name} /></Link>
              <div className="min-w-0 flex-1"><Link to="/products/$id" params={{ id: item.productId }} className="line-clamp-2 text-sm font-bold leading-6 hover:text-market-green sm:text-base">{item.name}</Link><p className="mt-1 text-xs text-market-muted">Unit price: {formatGhs(item.price)}</p><div className="mt-3 flex flex-wrap items-center gap-3"><div className="flex items-center overflow-hidden rounded-xl border border-market-line"><button type="button" onClick={() => update(i, -1)} className="grid h-11 w-11 place-items-center hover:bg-market-soft" aria-label={`Decrease quantity of ${item.name}`}><Minus size={16} aria-hidden="true"/></button><span className="w-8 text-center text-sm font-black" aria-label={`${item.quantity} in cart`}>{item.quantity}</span><button type="button" disabled={item.quantity >= 20} onClick={() => update(i, 1)} className="grid h-11 w-11 place-items-center hover:bg-market-soft disabled:opacity-40" aria-label={`Increase quantity of ${item.name}`}><Plus size={16} aria-hidden="true"/></button></div><button type="button" onClick={() => writeCart(readCart().filter((_, j) => j !== i))} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-bold text-red-700 hover:bg-red-50" aria-label={`Remove ${item.name} from cart`}><Trash2 size={16} aria-hidden="true"/> Remove</button></div></div>
              <strong className="ml-auto basis-full text-right text-base font-black sm:basis-auto sm:text-lg">{formatGhs(Number(item.price) * item.quantity)}</strong>
            </li>)}</ul>}
          </section>
          {cart.length > 0 && <aside className="rounded-2xl border border-market-line bg-white p-5 shadow-market sm:p-6 lg:sticky lg:top-24"><h2 className="text-lg font-black">Order summary</h2><div className="mt-5 flex justify-between border-t border-market-line pt-4 text-sm"><span className="text-market-muted">Items ({count})</span><strong>{formatGhs(total)}</strong></div><p className="mt-3 text-xs leading-5 text-market-muted">Delivery costs are calculated from available providers after you enter your address at checkout. Final product prices and availability are confirmed by the server.</p><button type="button" onClick={() => navigate({ to: "/checkout" })} className="market-btn-accent mt-6 w-full">Proceed to checkout <ArrowRight size={17} aria-hidden="true" /></button><div className="mt-5 flex items-start gap-2 border-t border-market-line pt-4 text-xs leading-5 text-market-muted"><ShieldCheck size={17} className="mt-0.5 shrink-0 text-market-green" aria-hidden="true"/>Payment will be completed with an available secure provider after you review the server-confirmed total.</div></aside>}
        </div>
      </main>
      <MarketFooter />
    </div>
  );
}

function CartImage({ source, name }: { source: string | null; name: string }) {
  const image = safeImageSource(source);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [image]);
  return image && !broken ? <img src={image} alt={name} loading="lazy" decoding="async" onError={() => setBroken(true)} className="h-full w-full object-contain p-2"/> : <ShoppingBag size={22} className="text-market-muted" aria-label="Product image unavailable"/>;
}
