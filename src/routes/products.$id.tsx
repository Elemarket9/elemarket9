import {chooseProductVariant} from '@/modules/catalog/public/variant-choice';
import {DiscoveryProductCard} from '@/components/discovery-product-card';
import {recallDiscoveryReceipt} from '@/modules/catalog/public/discovery-receipts';
import {safeImageSource} from '@/modules/shared/public/media';
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BadgeCheck, Check, ChevronLeft, ChevronRight, CreditCard, Heart, RotateCcw, ShieldCheck, ShoppingBag, Star, Truck } from "lucide-react";
import { getProduct } from "@/modules/catalog/public/catalog";
import { recordSearchObservation } from "@/modules/catalog/public/observations.functions";
import { getCustomerProductEngagement, askProductQuestion, listProductQuestions, listProductReviews, recordProductEvent, recordRecentProduct, setBackInStockSubscription, toggleWishlistProduct } from "@/modules/engagement/public/customer-engagement.functions";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { formatGhs } from "@/modules/shared/public/money";
import type { JsonValue, ProductVariant } from "@/modules/shared/public/types";
import { addCartLine, readCart } from "@/modules/ordering/public/cart";
import { MarketFooter, MarketHeader } from "@/components/market-header";
import { ContactSupportWidget } from "@/components/contact-support-widget";

export const Route = createFileRoute("/products/$id")({
  loader: ({ params }) => getProduct({ data: { id: params.id } }),
  head: ({ loaderData }) => {
    const product = loaderData?.product;
    if (!product) return { meta: [{ title: "Product — ELEMARKET" }, { name: "robots", content: "noindex" }] };
    const description = (product.description || `${product.name} on ELEMARKET in Ghana.`).replace(/\s+/g, " ").trim().slice(0, 155);
    const canonical = `/products/${encodeURIComponent(product.id)}`;
    return {
      meta: [
        { title: `${product.name} | ELEMARKET Ghana` },
        { name: "description", content: description },
        { name: "robots", content: loaderData?.seo?.indexDecision === "index" && product.stock > 0 ? "index,follow,max-image-preview:large" : "noindex,follow" },
        { property: "og:type", content: "product" },
        { property: "og:title", content: product.name },
        { property: "og:description", content: description },
        ...(product.imagePath ? [{ property: "og:image", content: product.imagePath }] : []),
        { property: "product:price:amount", content: String(product.price) },
        { property: "product:price:currency", content: "GHS" },
      ],
      links: [{ rel: "canonical", href: canonical }],
    };
  },
  component: ProductPage,
});

function ProductPage() {
  const { id } = Route.useParams();
  return <ProductContent key={id} />;
}

function ProductContent() {
  const data = Route.useLoaderData() as Awaited<ReturnType<typeof getProduct>>;
  const [brokenImage,setBrokenImage]=useState(false);
  const [mediaIndex, setMediaIndex] = useState(0);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(data.variants[0]?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [cartItems, setCartItems] = useState<ReturnType<typeof readCart>>([]);
  const [addedNotice, setAddedNotice] = useState(false);
  const { user } = useCurrentUserState();
  const [saved, setSaved] = useState(false);
  const [engagementBusy, setEngagementBusy] = useState(false);
  const [engagementLoading, setEngagementLoading] = useState(false);
  const wishlistPending = useRef(false);
  const account = useRef(user?.id);
  account.current = user?.id;
  const [stockAlert, setStockAlert] = useState(false);
  const [compareSelected, setCompareSelected] = useState(false);
  const [question, setQuestion] = useState("");
  const [questions, setQuestions] = useState<Array<{id:string;question:string;created_at:string;answer:string|null;answered_at:string|null}>>([]);
  const [engagementMessage, setEngagementMessage] = useState<string | null>(null);
  const [reviews,setReviews]=useState<Array<{id:string;rating:number;body:string;created_at:string;merchant_response:string|null;response_at:string|null}>>([]);
  const [reviewCursor,setReviewCursor]=useState<string|null>(null);
  useEffect(() => {
    const sync = () => setCartItems(readCart());
    sync();
    window.addEventListener("elemarket:cart-updated", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("elemarket:cart-updated", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const variantGroups = useMemo(() => groupVariantAttributes(data.variants), [data.variants]);
  const productId = data.product?.id;
  const userId = user?.id;
  useEffect(() => {
    if (!productId) return;
    const receipt=recallDiscoveryReceipt(productId);if(receipt)void recordSearchObservation({data:{receipt,eventType:'view'}}).catch(()=>undefined);
    let active = true;
    void listProductQuestions({ data: { productId } }).then(rows => { if (active) setQuestions(rows); }).catch(() => undefined);
    if(!receipt)void recordProductEvent({ data: { eventId: `view_${crypto.randomUUID().replaceAll("-", "")}`, productId, eventType: "view" } }).catch(() => undefined);
    void listProductReviews({ data: { productId, limit: 10 } }).then(result => { if (active) { setReviews(result.reviews); setReviewCursor(result.nextBefore); } }).catch(() => undefined);
    try {
      const value: unknown = JSON.parse(localStorage.getItem("elemarket:compare-products") ?? "[]");
      setCompareSelected(Array.isArray(value) && value.includes(productId));
    } catch { setCompareSelected(false); }
    return () => { active = false; };
  }, [productId]);
  useEffect(() => {
    setSaved(false); setStockAlert(false);
    if (!productId || !userId) { setEngagementLoading(false); return; }
    let active = true;
    setEngagementLoading(true);
    void recordRecentProduct({ data: { productId } }).catch(() => undefined);
    void getCustomerProductEngagement({ data: { productId } }).then(state => { if (active) { setSaved(state.saved); setStockAlert(state.stockAlert); } }).catch(() => { if (active) setEngagementMessage("Saved-product settings could not be loaded."); }).finally(() => { if (active) setEngagementLoading(false); });
    return () => { active = false; };
  }, [productId, userId]);

  async function toggleSavedProduct(productId: string) {
    if (!user) { setEngagementMessage("Sign in to save products."); return; }
    if (wishlistPending.current || engagementLoading) return;
    wishlistPending.current = true; setEngagementBusy(true);
    const actor = user.id;
    try { const result = await toggleWishlistProduct({ data: { productId } }); if (account.current === actor) { setSaved(result.saved);if(result.saved){const receipt=recallDiscoveryReceipt(productId);if(receipt)void recordSearchObservation({data:{receipt,eventType:'wishlist'}}).catch(()=>undefined);} setEngagementMessage(result.saved ? "Saved to your wishlist." : "Removed from your wishlist."); } }
    catch { if (account.current === actor) setEngagementMessage("Could not update your wishlist."); }
    finally { wishlistPending.current = false; setEngagementBusy(false); }
  }
  function toggleCompare(productId: string) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem("elemarket:compare-products") ?? "[]");
      const current = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
      const next = current.includes(productId) ? current.filter((x) => x !== productId) : [...current.filter(Boolean), productId].slice(-4);
      localStorage.setItem("elemarket:compare-products", JSON.stringify(next));
      setCompareSelected(next.includes(productId));
      setEngagementMessage(next.includes(productId) ? `Added to compare (${next.length}/4).` : "Removed from compare.");
    } catch { setEngagementMessage("Comparison is unavailable in this browser."); }
  }

  if (!data.product) {
    return <main className="mx-auto max-w-3xl px-5 py-20 text-center"><h1 className="text-3xl font-black">Product unavailable</h1><p className="mt-3 text-market-muted">This product may have been removed, suspended, or is no longer available.</p><Link to="/" className="mt-7 inline-flex rounded-xl bg-market-green px-5 py-3 text-sm font-bold text-white">Back to marketplace</Link></main>;
  }

  const { product, variants, media, related } = data;
  const selectedVariant = variants.find((v) => v.id === selectedVariantId) ?? null;
  const effectivePrice = selectedVariant?.price ?? product.price;
  const effectiveStock = selectedVariant?.stock ?? product.stock;
  const images = media.length ? media : [{ id: "fallback", productId: product.id, kind: "image" as const, storageKey: product.imagePath ?? "", altText: product.name, sortOrder: 0, isPrimary: true }];
  const currentImage = images[mediaIndex] ?? images[0];
  const productJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description || undefined,
    sku: product.sku || undefined,
    brand: product.brand ? { "@type": "Brand", name: product.brand } : undefined,
    image: product.imagePath ? [product.imagePath] : undefined,
    url: `/products/${encodeURIComponent(product.id)}`,
    offers: {
      "@type": "Offer",
      priceCurrency: "GHS",
      price: String(effectivePrice),
      availability: effectiveStock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: product.condition === "used" ? "https://schema.org/UsedCondition" : product.condition === "refurbished" ? "https://schema.org/RefurbishedCondition" : "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: product.merchantName },
    },
  }).replaceAll("<", "\\u003c");
  const attributes: Array<[string, JsonValue]> = Object.entries({ ...product.attributes, ...(selectedVariant?.attributes ?? {}) }).filter(([_, value]) => value !== null && value !== undefined && value !== "");
  const addToCart = () => {
    const attributionReceipt=recallDiscoveryReceipt(product.id);
    if(attributionReceipt)void recordSearchObservation({data:{receipt:attributionReceipt,eventType:'add_to_cart'}}).catch(()=>undefined);
    if(!attributionReceipt)void recordProductEvent({data:{eventId:`cart_${crypto.randomUUID().replaceAll("-","")}`,productId:product.id,eventType:"add_to_cart"}}).catch(()=>undefined);
    const next = addCartLine({
      productId: product.id,
      variantId: selectedVariant?.id ?? null,
      quantity,
      name: selectedVariant?.name ? `${product.name} · ${selectedVariant.name}` : product.name,
      price: effectivePrice,
      imagePath: currentImage?.storageKey || product.imagePath,
      merchantId: product.merchantId,
      stock: effectiveStock,attributionReceipt,
    });
    setCartItems(next);
    setAddedNotice(true);
    window.setTimeout(() => setAddedNotice(false), 2200);
  };

  return <div className="min-h-screen bg-market-bg text-market-ink">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: productJsonLd }} />
    <MarketHeader trailing={<button type="button" disabled={engagementBusy || engagementLoading} aria-pressed={saved} aria-label={saved ? "Remove from saved products" : "Save product"} onClick={() => data.product && void toggleSavedProduct(data.product.id)} className={`market-icon-link ${saved ? "bg-market-soft text-market-orange" : ""}`}><Heart size={18} className={saved ? "fill-current" : ""}/></button>} />
    <ContactSupportWidget />
    <main id="main-content" className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-semibold text-market-muted"><Link to="/" className="hover:text-market-green">Home</Link><span>/</span><span>{product.category}</span>{product.subcategory && <><span>/</span><span>{product.subcategory}</span></>}<span>/</span><span className="text-market-ink">{product.name}</span></div>

      <section className="grid gap-7 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,.9fr)] lg:items-start">
        <div className="grid gap-3 sm:grid-cols-[82px_minmax(0,1fr)]">
          <div className="order-2 flex gap-2 overflow-x-auto sm:order-1 sm:flex-col">{images.map((image, index) => <button key={image.id} onClick={() => {setMediaIndex(index);setBrokenImage(false);}} aria-label={`View image ${index + 1}`} className={`h-20 w-20 shrink-0 overflow-hidden rounded-xl border-2 bg-white ${index === mediaIndex ? "border-market-green" : "border-market-line"}`}><img src={safeImageSource(image.storageKey)} alt={image.altText ?? product.name} className="h-full w-full object-cover"/></button>)}</div>
          <div className="relative order-1 aspect-square overflow-hidden rounded-[28px] border border-market-line bg-white shadow-market sm:order-2">
            {safeImageSource(currentImage.storageKey)&&!brokenImage ? <img onError={()=>setBrokenImage(true)} src={safeImageSource(currentImage.storageKey)} alt={currentImage.altText ?? product.name} className="h-full w-full object-contain p-4 sm:p-8"/> : <div className="flex h-full items-center justify-center text-market-muted">No product image</div>}
            {images.length > 1 && <><button onClick={() => setMediaIndex((mediaIndex - 1 + images.length) % images.length)} aria-label="Previous image" className="absolute left-3 top-1/2 rounded-full bg-white/95 p-2 shadow-lg"><ChevronLeft/></button><button onClick={() => setMediaIndex((mediaIndex + 1) % images.length)} aria-label="Next image" className="absolute right-3 top-1/2 rounded-full bg-white/95 p-2 shadow-lg"><ChevronRight/></button></>}
          </div>
        </div>

        <div className="rounded-[28px] border border-market-line bg-white p-5 shadow-market sm:p-7">
          <div className="flex flex-wrap gap-2"><span className="rounded-full bg-market-soft px-3 py-1 text-[11px] font-black uppercase tracking-wider text-market-green">{product.condition.replace("_", " ")}</span>{product.verified && <span className="inline-flex items-center gap-1 rounded-full bg-market-green/10 px-3 py-1 text-[11px] font-black text-market-green"><BadgeCheck size={13}/> Verified merchant</span>}{product.financingEligible && <span className="rounded-full bg-market-orange/10 px-3 py-1 text-[11px] font-black text-market-orange">Pay over time</span>}</div>
          <h1 className="mt-4 text-3xl font-black leading-tight tracking-[-.04em] sm:text-4xl">{product.name}</h1>
          {(product.brand || product.model) && <p className="mt-2 text-sm font-semibold text-market-muted">{[product.brand, product.model].filter(Boolean).join(" · ")}</p>}{product.reviewCount > 0 && <div className="mt-3 flex items-center gap-1.5 text-sm font-bold"><Star size={16} className="fill-current text-amber-500" aria-hidden="true"/><span>{product.avgRating?.toFixed(1)}</span><span className="font-medium text-market-muted">· {product.reviewCount} verified purchase review{product.reviewCount===1?"":"s"}</span></div>}
          <div className="mt-6 flex items-end justify-between gap-4"><div><p className="text-3xl font-black tracking-[-.03em]">{formatGhs(effectivePrice)}</p>{product.financingEligible && <p className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-market-green"><CreditCard size={14}/> Financing may be available at checkout*</p>}</div><span className={`text-xs font-bold ${effectiveStock > 0 ? "text-market-green" : "text-red-600"}`}>{effectiveStock > 0 ? `${effectiveStock} available` : "Out of stock"}</span></div>

          {variants.length > 0 && <div className="mt-7 space-y-5">{variantGroups.map((group) => <div key={group.key}><div className="mb-2 flex justify-between"><span className="text-sm font-black capitalize">{humanize(group.key)}</span><span className="text-xs text-market-muted">{selectedVariant?.attributes[group.key] as string ?? "Select"}</span></div><div className="flex flex-wrap gap-2">{group.values.map((value) => { const variant = chooseProductVariant(variants,selectedVariant,group.key,value); return <button type="button" aria-pressed={String(selectedVariant?.attributes[group.key]??"")===value} key={value} disabled={!variant} onClick={() => { if (variant) { setSelectedVariantId(variant.id); setQuantity(q => Math.max(1, Math.min(20, variant.stock, q))); } }} className={`min-h-11 rounded-xl border px-3.5 py-2.5 text-sm font-bold transition ${String(selectedVariant?.attributes[group.key]??"") === value ? "border-market-green bg-market-green text-white" : "border-market-line hover:border-market-green disabled:cursor-not-allowed disabled:opacity-35"}`}>{value}{String(selectedVariant?.attributes[group.key]??"") === value && <Check size={14} className="ml-1 inline"/>}</button>})}</div></div>)}</div>}

          {engagementMessage && <p role="status" className="mt-5 rounded-xl bg-market-soft p-3 text-sm font-semibold text-market-ink">{engagementMessage}</p>}
          <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => toggleCompare(product.id)} className={`rounded-xl border px-4 py-2 text-sm font-bold ${compareSelected ? "border-market-green bg-market-green text-white" : "border-market-line"}`}>{compareSelected ? "Added to compare" : "Compare"}</button>{effectiveStock < 1 && <button type="button" disabled={stockAlert || engagementLoading} onClick={async()=>{if(!user){setEngagementMessage("Sign in to receive stock alerts.");return;}try{await setBackInStockSubscription({data:{productId:product.id,active:true}});setStockAlert(true);setEngagementMessage("Back-in-stock alert saved.");}catch{setEngagementMessage("Could not save the stock alert.");}}} className="rounded-xl border border-market-line px-4 py-2 text-sm font-bold">{stockAlert ? "Stock alert saved" : "Notify me when available"}</button>}</div>
          <div className="mt-7 flex flex-col gap-2 xs:flex-row sm:flex-row"><div className="flex h-12 w-full shrink-0 items-center justify-center rounded-xl border border-market-line sm:w-auto"><button onClick={() => setQuantity(q => Math.max(1, q - 1))} className="h-full w-11 text-lg font-black" aria-label="Decrease quantity">−</button><span className="w-8 text-center text-sm font-black">{quantity}</span><button onClick={() => setQuantity(q => Math.max(1,Math.min(20,effectiveStock,q+1)))} disabled={quantity >= Math.min(20, effectiveStock)} className="h-full w-11 text-lg font-black disabled:opacity-30" aria-label="Increase quantity">+</button></div><button disabled={effectiveStock < 1} onClick={addToCart} className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-market-orange px-5 text-sm font-black text-white shadow-lg shadow-market-orange/15 hover:bg-market-orange/90 disabled:cursor-not-allowed disabled:opacity-40">Add to cart <ShoppingBag size={17}/></button></div>
          <p className="mt-2 text-[11px] text-market-muted">* Financing is subject to the selected provider's eligibility and approval. ELEMARKET does not guarantee credit.</p>

          <div className="mt-7 grid grid-cols-2 gap-2 border-t border-market-line pt-5 sm:grid-cols-4"><Feature icon={<Truck/>} title="Delivery" text={product.fulfillmentType.replaceAll("_", " ")}/><Feature icon={<ShieldCheck/>} title="Secure" text="Protected checkout"/><Feature icon={<RotateCcw/>} title="Returns" text={product.returnable ? `${product.returnWindowDays ?? 0} days` : "Not offered"}/><Feature icon={<BadgeCheck/>} title="Warranty" text={product.warrantyMonths ? `${product.warrantyMonths} months` : "See listing"}/></div>
        </div>
      </section>

      <section className="mt-8 grid gap-5 lg:grid-cols-[1.4fr_.6fr]">
        <div className="rounded-[24px] border border-market-line bg-white p-5 sm:p-7"><p className="eyebrow">Product information</p><h2 className="mt-1 text-2xl font-black">Specifications</h2>{attributes.length ? <div className="mt-5 grid gap-2 sm:grid-cols-2">{attributes.map(([key,value]) => <div key={key} className="flex items-center justify-between gap-4 rounded-xl bg-market-bg px-4 py-3 text-sm"><span className="font-semibold text-market-muted">{humanize(key)}</span><span className="max-w-[60%] text-right font-black">{formatAttribute(value)}</span></div>)}</div> : <p className="mt-4 text-sm text-market-muted">No additional specifications have been provided.</p>}<div className="mt-7 border-t border-market-line pt-6"><h3 className="font-black">Description</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-market-muted">{product.description || "No description provided."}</p></div></div>
        <aside className="rounded-[24px] border border-market-line bg-market-ink p-5 text-white shadow-market sm:p-7"><p className="text-xs font-black uppercase tracking-[.16em] text-market-mint">Merchant</p><h2 className="mt-2 text-xl font-black"><Link to="/stores/$id" params={{id:product.merchantId}}>{product.merchantName}</Link></h2><p className="mt-1 text-sm text-white/60">{product.neighborhood}, {product.city}</p><div className="mt-5 flex items-center gap-2 text-sm font-bold"><ShieldCheck className="text-market-mint" size={17}/> Verified merchant</div><p className="mt-5 text-sm leading-6 text-white/65">Shop with confidence. Merchant identity and listing eligibility are validated by ELEMARKET before products are publicly available.</p></aside>
      </section>

      <section className="mt-10 rounded-[28px] border border-market-line bg-white p-5 shadow-market sm:p-7"><div className="flex items-end justify-between gap-3"><div><p className="eyebrow">Verified purchases</p><h2 className="mt-1 text-2xl font-black">Customer reviews</h2></div>{product.reviewCount>0&&<span className="text-sm font-black">{product.avgRating?.toFixed(1)} / 5 · {product.reviewCount}</span>}</div><div className="mt-5 space-y-3">{reviews.length===0?<p className="text-sm text-market-muted">No verified-purchase reviews yet.</p>:reviews.map(review=><article key={review.id} className="rounded-2xl border border-market-line p-4"><div className="flex items-center gap-2"><span className="font-black">{review.rating}/5</span><span className="text-xs font-bold text-market-green">Verified purchase</span></div><p className="mt-2 text-sm leading-6 text-market-ink">{review.body}</p>{review.merchant_response&&<div className="mt-3 rounded-xl bg-market-soft p-3 text-sm"><strong>Merchant response:</strong> {review.merchant_response}</div>}</article>)}</div>{reviewCursor&&<button type="button" onClick={async()=>{try { const r=await listProductReviews({data:{productId:product.id,before:reviewCursor,limit:10}});setReviews(v=>[...new Map([...v,...r.reviews].map(review=>[review.id,review])).values()]);setReviewCursor(r.nextBefore); } catch { setEngagementMessage("More reviews could not be loaded. Please try again."); }}} className="mt-4 rounded-xl border border-market-line px-4 py-2 text-sm font-bold">Load more reviews</button>}</section>

      <section className="mt-10 rounded-[28px] border border-market-line bg-white p-5 shadow-market sm:p-7"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="eyebrow">Product Q&A</p><h2 className="mt-1 text-2xl font-black">Questions from shoppers</h2></div><span className="text-xs text-market-muted">Merchant answers are public</span></div><div className="mt-5 space-y-3">{questions.length===0?<p className="text-sm text-market-muted">No questions yet.</p>:questions.map(q=><article key={q.id} className="rounded-2xl border border-market-line p-4"><p className="font-bold">Q: {q.question}</p>{q.answer?<p className="mt-2 text-sm text-market-muted"><strong className="text-market-ink">Merchant:</strong> {q.answer}</p>:<p className="mt-2 text-xs font-semibold text-market-orange">Awaiting merchant response</p>}</article>)}</div><form className="mt-5 flex flex-col gap-2 sm:flex-row" onSubmit={async(e)=>{e.preventDefault();if(!user){setEngagementMessage("Sign in to ask a product question.");return;}try{await askProductQuestion({data:{productId:product.id,question}});setQuestion("");setQuestions(await listProductQuestions({data:{productId:product.id}}));setEngagementMessage("Your question was posted.");}catch{setEngagementMessage("Could not post that question.");}}}><input value={question} onChange={e=>setQuestion(e.target.value)} minLength={5} maxLength={1000} required aria-label="Ask a product question" placeholder="Ask about size, compatibility, warranty…" className="h-11 flex-1 rounded-xl border border-market-line px-3"/><button className="h-11 rounded-xl bg-market-green px-5 text-sm font-black text-white">Ask question</button></form></section>

      {related.length > 0 && <section className="mt-10 pb-14"><p className="eyebrow">You may also like</p><h2 className="section-title">More from this category</h2><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{related.map(p => <DiscoveryProductCard key={p.id} product={p} quantity={0}/>)}</div></section>}
    </main>
    <MarketFooter />
    {addedNotice && <div className="fixed inset-x-3 bottom-3 z-50 sm:inset-auto sm:bottom-6 sm:right-6 sm:left-auto"><Link to="/cart" className="flex min-h-14 items-center gap-3 rounded-2xl bg-market-ink px-4 py-3 text-white shadow-2xl"><ShoppingBag size={18} className="text-market-mint"/><span className="text-sm font-bold">Added to cart</span><span className="rounded-xl bg-market-orange px-3 py-2 text-xs font-black">View cart</span></Link></div>}
  </div>;
}

function Feature({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="rounded-xl bg-market-bg p-3"><div className="text-market-green [&_svg]:h-4 [&_svg]:w-4">{icon}</div><p className="mt-2 text-xs font-black">{title}</p><p className="mt-0.5 text-[10px] font-semibold capitalize text-market-muted">{text}</p></div>; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }
function formatAttribute(value: JsonValue) { if (typeof value === "boolean") return value ? "Yes" : "No"; if (Array.isArray(value)) return value.join(", "); return String(value); }
function groupVariantAttributes(variants: ProductVariant[]) { const keys = [...new Set(variants.flatMap(v => Object.keys(v.attributes)))]; return keys.map(key => ({ key, values: [...new Set(variants.map(v => String(v.attributes[key] ?? "")).filter(Boolean))] })); }
