import {linkSearchOrders} from '@/modules/catalog/public/observations.functions';
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CreditCard, LockKeyhole, ShieldCheck, ShoppingBag, Truck } from "lucide-react";
import { RedirectToSignIn, SignInGate } from "@/modules/identity/public/auth/gates";
import { createPendingCheckout, listAvailableCheckoutPaymentMethods, type CheckoutPaymentMethod } from "@/modules/ordering/public/checkout";
import { getAssistedOrderDraft } from "@/modules/support/public/support.functions";
import { fingerprintCheckout } from "@/modules/ordering/public/checkout-fingerprint";
import { createPaymentIntent } from "@/modules/payments/public/payment";
import { requestDeliveryQuote } from "@/modules/logistics/public/adapters/delivery";
import { resolveProductMerchants } from "@/modules/catalog/public/catalog";
import { formatGhs } from "@/modules/shared/public/money";
import { previewCustomerFinancing, type FinancingProvider } from "@/modules/financing/public/financing";
import { FinancingProviderApplicationForm } from "@/components/financing-provider-application-form";
import { ContactSupportWidget } from "@/components/contact-support-widget";

import { PAYMENT_QUEUE_KEY, cartTotal, readCart, writeCart, type CartLine } from "@/modules/ordering/public/cart";

export const Route = createFileRoute("/checkout")({ component: Checkout });

function Checkout() {
  return (
    <SignInGate fallback={<RedirectToSignIn />}>
      <CheckoutForm />
    </SignInGate>
  );
}

type PreparedMerchantOrder = {orderId: string; merchantId: string; paymentId: string; grandTotal: number; productTotal: number; deliveryTotal: number; promoDiscount: number};
function CheckoutForm() {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [assistedDraftId, setAssistedDraftId] = useState<string | null>(null);
  const [assistedDraftNotice, setAssistedDraftNotice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState<CheckoutPaymentMethod | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<CheckoutPaymentMethod[]>([]);
  const [paymentMethodsLoading, setPaymentMethodsLoading] = useState(true);
  const [promoCode, setPromoCode] = useState("");
  const [tier, setTier] = useState<"same_day" | "next_day" | "three_day">("next_day");
  const [quotes, setQuotes] = useState<Array<{ merchantId: string; quoteId: string; price: string; etaMinutes: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  // Orders are written atomically before payment. The customer must see the
  // authoritative DB prices, promotions and delivery amount before redirect.
  const [prepared, setPrepared] = useState<{groupId: string; orders: PreparedMerchantOrder[]} | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const checkoutAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [financingProviders, setFinancingProviders] = useState<FinancingProvider[]>([]);
  const [financingQuote, setFinancingQuote] = useState<{ quoteId: string; amount: number; expiresAt: string } | null>(null);
  const [selectedFinancingProvider, setSelectedFinancingProvider] = useState("");
  const [financingStatus, setFinancingStatus] = useState<string | null>(null);
  const [financingBusy, setFinancingBusy] = useState(false);
  const total = useMemo(() => cartTotal(cart), [cart]);
  const deliveryTotal = quotes.reduce((sum, q) => sum + Number(q.price || 0), 0);

  useEffect(() => {
    let active = true;
    void listAvailableCheckoutPaymentMethods().then((methods) => {
      if (!active) return;
      setPaymentMethods(methods);
      setMethod((current) => current && methods.includes(current) ? current : (methods[0] ?? null));
    }).catch(() => {
      if (!active) return;
      setPaymentMethods([]);
      setMethod(null);
    }).finally(() => { if (active) setPaymentMethodsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setCart(readCart());
    const draftId = new URLSearchParams(window.location.search).get("draftId");
    if (!draftId) return;
    setAssistedDraftId(draftId);
    void getAssistedOrderDraft({ data: { draftId } }).then((draft) => {
      if (!active) return;
      if (!draft || !Array.isArray((draft as any).items)) throw new Error("draft unavailable");
      const next = (draft as any).items.map((item: any) => ({
        productId: item.productId, variantId: item.variantId ?? null, quantity: Number(item.quantity),
        name: item.name, price: String(item.price), imagePath: null, merchantId: item.merchantId,
      }));
      setCart(next);
      setQuotes([]);
      setAssistedDraftNotice("Support prepared this order for you. Review the address, delivery quote and final total before payment.");
    }).catch(() => { if (active) { setAssistedDraftId(null); setAssistedDraftNotice("This assisted order is no longer available. Please contact ELEMARKET Support."); } });
    return () => { active = false; };
  }, []);

  async function quote() {
    if (operation.current) return;
    setError(null);
    if (!cart.length) return setError("Your cart is empty.");
    if (address.trim().length < 8) return setError("Enter a complete delivery address.");
    operation.current = true;
    setBusy(true);
    try {
      const missing = cart.filter((line) => !line.merchantId).map((line) => line.productId);
      const resolved = missing.length ? await resolveProductMerchants({ data: { productIds: [...new Set(missing)] } }) : {};
      const merchantIds = [...new Set(cart.map((line) => line.merchantId || resolved[line.productId]).filter(Boolean))] as string[];
      if (!merchantIds.length) throw new Error("Could not resolve merchants for this cart.");
      const next: Array<{ merchantId: string; quoteId: string; price: string; etaMinutes: number }> = [];
      for (const merchantId of merchantIds) {
        const result = await requestDeliveryQuote({ data: { merchantId, address: address.trim(), tier } });
        if (!result?.id) throw new Error("Delivery provider did not return a quote.");
        next.push({ merchantId, quoteId: result.id, price: result.price, etaMinutes: result.etaMinutes });
      }
      setQuotes(next);

    } catch {
      setError("Could not quote delivery. Please try again.");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function prepareFinancing() {
    setFinancingStatus(null);
    if (financingBusy || operation.current) return;
    if (!quotes.length) return setFinancingStatus("Get a live delivery quote before requesting financing.");
    setFinancingBusy(true);
    try {
      const preview = await previewCustomerFinancing({
        data: {
          items: cart.map(({ productId, variantId, quantity }) => ({ productId, variantId: variantId ?? null, quantity })),
          quoteIds: quotes.map((q) => q.quoteId),
        },
      });
      setFinancingQuote({ quoteId: preview.quoteId, amount: preview.amount, expiresAt: preview.expiresAt });
      setFinancingProviders(preview.providers);
      if (!selectedFinancingProvider && preview.providers[0]) setSelectedFinancingProvider(preview.providers[0].id);
      if (!preview.providers.length) setFinancingStatus("No financing provider is currently available for this purchase.");
    } catch {
      setFinancingStatus("Financing options could not be loaded. Please try again.");
    } finally {
      setFinancingBusy(false);
    }
  }


  async function submit() {
    if (operation.current) return;
    setError(null);
    if (!cart.length) return setError("Your cart is empty.");
    if (address.trim().length < 8) return setError("Enter a complete delivery address.");
    if (!method) return setError("No payment method is currently available. Please try again later or contact support.");
    // The transactional promo engine intentionally prevents allocating one
    // coupon across multiple merchants until group-wide discount accounting exists.
    if (promoCode.trim() && quotes.length > 1) return setError("Promo codes currently require a single-merchant checkout. Remove the code to continue with all merchants, or check out that merchant separately.");
    operation.current = true;
    setBusy(true);
    try {
      const stored = quotes;
      if (!Array.isArray(stored) || stored.length === 0) {
        throw new Error("Delivery pricing is not available yet. Get a live delivery quote before placing the order.");
      }
      // The SQL checkout creates one payment per merchant in an atomic order group.
      // The return page resumes the remaining payments after each confirmation.
      if (stored.length !== new Set(stored.map(q => q.merchantId)).size) {
        throw new Error("Delivery quotes contain duplicate merchants. Refresh the quotes.");
      }
      const payload = {
        items: cart.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
        quotes: stored.map(({ merchantId, quoteId }) => ({ merchantId, quoteId })),
        address: address.trim(),
        method,
        promoCode: promoCode.trim() || null,
        assistedDraftId,
      };
      const fingerprint = await fingerprintCheckout(payload);
      if (checkoutAttempt.current?.fingerprint !== fingerprint) checkoutAttempt.current = { fingerprint, key: crypto.randomUUID() };
      const result = await createPendingCheckout({ data: { ...payload, fingerprint, idempotencyKey: checkoutAttempt.current.key } });
      if (!result) throw new Error("Checkout could not be created.");
      const response=result as {groupId?:unknown; orders?:unknown};
      if(typeof response.groupId!=="string" || !Array.isArray(response.orders)||!response.orders.length) throw new Error("Unexpected checkout response.");
      const orders:PreparedMerchantOrder[]=response.orders.map((raw:unknown)=>{
        const o=raw as Record<string,unknown>;
        const monetary=(key:string)=>{
          const n=Number(o[key]);
          if(o[key]==null||!Number.isFinite(n)||n<0) throw new Error("Invalid authoritative checkout total.");
          return n;
        };
        if(typeof o.orderId!=="string"||typeof o.merchantId!=="string"||typeof o.paymentId!=="string") throw new Error("Invalid merchant order.");
        return {orderId:o.orderId,merchantId:o.merchantId,paymentId:o.paymentId,
          grandTotal:monetary("grandTotal"),productTotal:monetary("productTotal"),
          deliveryTotal:monetary("deliveryTotal"),promoDiscount:monetary("promoDiscount")};
      });
      const links=orders.flatMap(order=>cart.filter(line=>line.attributionReceipt&&line.merchantId===order.merchantId).map(line=>({orderId:order.orderId,receipt:line.attributionReceipt!}))).slice(0,40);
      if(links.length)void linkSearchOrders({data:{links}}).catch(()=>undefined);
      setPrepared({groupId:response.groupId,orders});
    } catch (error) {
      setError(error instanceof Error && error.message.startsWith("Please check out items") ? error.message : "Checkout could not be completed. Verify product availability and delivery quotes, then try again.");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function proceedWithConfirmedPayment() {
    if(!prepared||operation.current)return;
    operation.current=true;setBusy(true);setError(null);
    try {
      // Only initialize the first merchant payment. Remaining payments are
      // fetched from the authenticated server-side checkout group after return.
      const first=prepared.orders[0];
      const intent=await createPaymentIntent({data:{paymentId:first.paymentId}});
      if(!intent?.checkoutUrl)throw new Error("The payment provider did not return a secure checkout URL.");
      localStorage.setItem(PAYMENT_QUEUE_KEY,JSON.stringify(prepared.orders.map(({paymentId})=>({paymentId}))));
      writeCart([]);
      window.location.assign(intent.checkoutUrl);
    }catch {setError("Payment could not be started. Your pending order is saved; please try again or visit your orders.");}
    finally{operation.current=false;setBusy(false);}
  }

  if(prepared){
    const grandTotal=prepared.orders.reduce((sum,o)=>sum+o.grandTotal,0);
    return <main className="min-h-screen bg-market-bg px-4 py-12"><section className="mx-auto max-w-2xl rounded-3xl border border-market-line bg-white p-7 shadow-market">
      <ShieldCheck className="text-market-green" size={38}/>
      <h1 className="mt-3 text-2xl font-black">Review your final payment amount</h1>
      <p className="mt-2 text-sm text-market-muted">These amounts were calculated by the server from current prices, promotions and verified delivery quotes. Your items are reserved for a limited time. Do not pay unless you agree with this amount.</p>
      <div className="mt-6 space-y-3">{prepared.orders.map((order,index)=><div key={order.orderId} className="rounded-xl border border-market-line p-4">
        <div className="flex justify-between font-black"><span>Merchant order {index+1}</span><span>{formatGhs(order.grandTotal)}</span></div>
        <div className="mt-2 flex justify-between text-xs text-market-muted"><span>Products after discounts</span><span>{formatGhs(order.productTotal)}</span></div>
        <div className="mt-1 flex justify-between text-xs text-market-muted"><span>Delivery</span><span>{formatGhs(order.deliveryTotal)}</span></div>
        {order.promoDiscount>0?<div className="mt-1 flex justify-between text-xs text-market-green"><span>Discount applied</span><span>{formatGhs(order.promoDiscount)}</span></div>:null}
      </div>)}</div>
      <div className="mt-6 flex items-center justify-between border-t border-market-line pt-5 text-lg font-black"><span>Total to pay</span><span>{formatGhs(grandTotal)}</span></div>
      {error?<p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>:null}
      <button type="button" disabled={busy} onClick={()=>void proceedWithConfirmedPayment()} className="mt-6 w-full rounded-xl bg-market-orange px-5 py-4 font-black text-white disabled:opacity-50">{busy?'Opening secure payment…':'Confirm amount and continue to payment'}</button>
      <p className="mt-3 text-xs text-market-muted">If the price is unexpected, do not continue. Pending unpaid orders automatically expire under the marketplace reservation policy.</p>
    </section></main>;
  }

  if (!cart.length) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-16">
        <Link to="/" className="inline-flex items-center gap-2 text-sm font-bold"><ArrowLeft size={16} /> Back to marketplace</Link>
        <div className="mt-12 rounded-3xl border border-market-line bg-white p-10 text-center shadow-market">
          <ShoppingBag className="mx-auto text-market-green" size={42} />
          <h1 className="mt-4 text-3xl font-black">Your cart is empty</h1>
          <Link to="/" className="mt-6 inline-flex rounded-xl bg-market-orange px-5 py-3 font-black text-white">Continue shopping</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-market-bg">
      <ContactSupportWidget mode="order" />
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <nav aria-label="Checkout progress" className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-market-line bg-white px-4 py-3 text-xs font-bold text-market-muted"><Link to="/cart" className="text-market-green hover:underline">1. Cart</Link><span aria-hidden="true">→</span><span aria-current="step" className="rounded-md bg-market-soft px-2 py-1 text-market-green">2. Delivery & payment options</span><span aria-hidden="true">→</span><span>3. Review & pay</span></nav>
        <Link to="/" className="inline-flex items-center gap-2 text-sm font-bold"><ArrowLeft size={16} /> Marketplace</Link>
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
          <section className="rounded-3xl border border-market-line bg-white p-5 shadow-market sm:p-7">
            {assistedDraftNotice && <div role="status" className="mb-5 rounded-2xl border border-market-green/20 bg-market-soft p-4 text-sm font-semibold text-market-muted">{assistedDraftNotice}</div>}
            <div className="flex items-center gap-3">
              <Truck className="text-market-green" />
              <div>
                <h1 className="text-2xl font-black">Checkout</h1>
                <p className="text-sm text-market-muted">Secure order creation. Payment is completed separately.</p>
              </div>
            </div>
            <label className="mt-7 block text-sm font-black">
              Delivery address
              <input
                value={address}
                disabled={busy || financingBusy}
                onChange={(e) => { setAddress(e.target.value); setQuotes([]); setFinancingQuote(null); setFinancingProviders([]); setSelectedFinancingProvider(""); }}
                maxLength={400}
                className="mt-2 h-12 w-full rounded-xl border border-market-line px-4 outline-none focus:border-market-green"
                placeholder="Street, area, city"
              />
            </label>
            <div className="mt-6">
              <p className="text-sm font-black">Delivery speed</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {([["same_day", "Same day"], ["next_day", "Next day"], ["three_day", "3-day"]] as const).map(([id, label]) => (
                  <button key={id} disabled={busy || financingBusy} onClick={() => { setTier(id); setQuotes([]); setFinancingQuote(null); setFinancingProviders([]); setSelectedFinancingProvider(""); }} className={`rounded-xl border px-4 py-3 text-sm font-black ${tier === id ? "border-market-green bg-market-green/10" : "border-market-line"}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="mt-7">
              <p className="text-sm font-black">Payment method</p>
              {paymentMethodsLoading ? <p className="mt-2 text-xs font-semibold text-market-muted">Checking available payment methods…</p> : paymentMethods.length ? <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {paymentMethods.map((id) => { const label = id === "mobile_money" ? "Mobile Money" : id === "card" ? "Card" : "Bank"; return (
                  <button type="button" key={id} onClick={() => setMethod(id)} className={`rounded-xl border px-4 py-3 text-sm font-black ${method === id ? "border-market-green bg-market-green/10" : "border-market-line"}`}>
                    <CreditCard size={16} className="mr-2 inline" />{label}
                  </button>
                ); })}
              </div> : <div role="status" className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-900">Secure payment is temporarily unavailable. Your cart is safe; please try again later or contact ELEMARKET Support.</div>}
            </div>
            <div className="mt-7 rounded-2xl border border-market-line bg-market-soft p-4">
              <div className="flex items-start gap-3">
                <CreditCard className="mt-0.5 shrink-0 text-market-green" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black">Pay over time</p>
                  <p className="mt-1 text-xs leading-5 text-market-muted">BNPL and installment financing are separate provider applications, not ELEMARKET payment methods. Every application is subject to the selected provider's approval, terms and availability.</p>
                  {!financingQuote ? (
                    <button type="button" onClick={() => void prepareFinancing()} disabled={financingBusy || quotes.length === 0} className="mt-3 rounded-xl border border-market-green bg-white px-4 py-2.5 text-xs font-black text-market-green disabled:cursor-not-allowed disabled:opacity-50">
                      {financingBusy ? "Loading financing options…" : "View BNPL / installment options"}
                    </button>
                  ) : financingProviders.length ? (
                    <div className="mt-3 space-y-2">
                      {financingProviders.map((provider) => (
                        <label key={provider.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-white p-3 ${selectedFinancingProvider === provider.id ? "border-market-green" : "border-market-line"}`}>
                          <input type="radio" name="financing-provider" value={provider.id} checked={selectedFinancingProvider === provider.id} onChange={() => setSelectedFinancingProvider(provider.id)} />
                          <span className="min-w-0 flex-1"><span className="block text-sm font-black">{provider.name}</span><span className="block text-[11px] font-semibold text-market-muted">{provider.productType === "bnpl" ? "BNPL" : "Installment financing"} · Provider approval required</span>{provider.providerLegalName ? <span className="block text-[10px] text-market-muted">Offered by {provider.providerLegalName}</span> : null}<span className="mt-1 block text-[10px]">{provider.termsUrl ? <a className="underline" href={provider.termsUrl} target="_blank" rel="noopener noreferrer">Terms</a> : <span>Terms: ask provider</span>}{" · "}{provider.privacyUrl ? <a className="underline" href={provider.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy</a> : <span>Privacy: ask provider</span>}</span></span>
                        </label>
                      ))}
                      <p className="text-[11px] leading-5 text-market-muted">Indicative application amount: {formatGhs(financingQuote.amount)}. This is not an approved credit limit. Final approval, fees, schedule and terms come only from the financing provider.</p>
                      {selectedFinancingProvider ? <FinancingProviderApplicationForm
                        providerId={selectedFinancingProvider}
                        quoteId={financingQuote.quoteId}
                        providerName={financingProviders.find((p) => p.id === selectedFinancingProvider)?.name ?? "Selected provider"}
                      /> : null}
                    </div>
                  ) : null}
                  {financingStatus && <p role="status" className="mt-3 rounded-xl border border-market-line bg-white p-3 text-xs font-semibold text-market-muted">{financingStatus}</p>}
                  {!financingProviders.length && financingQuote && <div className="mt-3 rounded-xl border border-dashed border-market-line bg-white p-3 text-[11px] leading-5 text-market-muted"><b className="text-market-ink">Financing unavailable:</b> no enabled financing partner currently supports this purchase amount. Availability, pricing, terms and approval always come from the provider.</div>}
                </div>
              </div>
            </div>
            <label className="mt-7 block text-sm font-black">
              Promo code (optional)
              <input
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 64))}
                maxLength={64}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="mt-2 h-12 w-full rounded-xl border border-market-line px-4 uppercase outline-none focus:border-market-green"
                placeholder="ENTER CODE"
              />
              <span className="mt-1 block text-xs font-normal text-market-muted">Discounts are re-validated server-side at order creation. Codes cannot change the delivery quote.</span>
            </label>
            <div className="mt-7 rounded-2xl bg-market-soft p-4">
              <div className="flex gap-3">
                <ShieldCheck className="shrink-0 text-market-green" />
                <p className="text-xs leading-5 text-market-muted">ELEMARKET never treats a browser-supplied price as authoritative. Inventory, product price, merchant ownership and delivery quote validity are verified server-side.</p>
              </div>
            </div>
            {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>}
            {quotes.length === 0 ? (
              <button disabled={busy} onClick={quote} className="mt-7 h-12 w-full rounded-xl bg-market-green font-black text-white disabled:opacity-50">
                {busy ? "Requesting live quote…" : "Get a live delivery quote"}
              </button>
            ) : (
              <button disabled={busy || paymentMethodsLoading || !method} onClick={submit} className="mt-7 h-12 w-full rounded-xl bg-market-orange font-black text-white disabled:opacity-50">
                {busy ? "Creating secure order…" : "Review final server-calculated amount"}
              </button>
            )}
          </section>
          <aside className="h-fit rounded-3xl border border-market-line bg-white p-5 shadow-market sm:p-7 lg:sticky lg:top-24">
            <h2 className="text-lg font-black">Order summary</h2>
            <div className="mt-5 space-y-3">
              {cart.map((item, i) => (
                <div key={`${item.productId}:${item.variantId}:${i}`} className="flex justify-between gap-3 text-sm">
                  <span className="font-semibold">{item.name || "Product"} × {item.quantity}</span>
                  <span className="font-black">{formatGhs(Number(item.price || 0) * item.quantity)}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-between border-t border-market-line pt-5">
              <span className="font-black">Products</span>
              <span className="text-xl font-black">{formatGhs(total)}</span>
            </div>
            {quotes.length > 0 && (
              <div className="mt-3 flex justify-between text-sm">
                <span className="font-bold text-market-muted">Delivery</span>
                <span className="font-black">{formatGhs(deliveryTotal)}</span>
              </div>
            )}
            <p className="mt-3 text-xs text-market-muted">Delivery is quoted separately and must be live, unexpired and tied to this address before an order is created.</p>{import.meta.env.VITE_ELEMARKET_LOCATION_ATTRIBUTION_LABEL && import.meta.env.VITE_ELEMARKET_LOCATION_ATTRIBUTION_URL ? <p className="mt-2 text-[11px] text-market-muted">Location lookup powered by <a href={import.meta.env.VITE_ELEMARKET_LOCATION_ATTRIBUTION_URL} target="_blank" rel="noreferrer" className="underline">{import.meta.env.VITE_ELEMARKET_LOCATION_ATTRIBUTION_LABEL}</a>.</p> : null}
            <div className="mt-5 flex items-center gap-2 text-xs font-bold"><LockKeyhole size={14} /> Protected checkout</div>
          </aside>
        </div>
      </div>
    </main>
  );
}
