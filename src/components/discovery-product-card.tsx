import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CreditCard, Heart, ShieldCheck, ShoppingBag, Star } from "lucide-react";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { toggleWishlistProduct } from "@/modules/engagement/public/customer-engagement.functions";
import { recordSearchObservation } from "@/modules/catalog/public/observations.functions";
import { rememberDiscoveryReceipt } from "@/modules/catalog/public/discovery-receipts";
import { safeImageSource, discountPercent } from "@/modules/shared/public/media";
import { formatGhs } from "@/modules/shared/public/money";
import type { ProductCard } from "@/modules/shared/public/types";

interface DiscoveryProductCardProps {
  product: ProductCard;
  quantity: number;
  onAdd?: () => void;
  sponsored?: boolean;
  officialStore?: boolean;
  originalPrice?: string;
  adTitle?: string;
  adSubtitle?: string;
  onAdClick?: () => void;
  onAdImpression?: () => void;
}

export function DiscoveryProductCard({ product, quantity, onAdd, sponsored, officialStore, originalPrice, adTitle, adSubtitle, onAdClick, onAdImpression }: DiscoveryProductCardProps) {
  const { user } = useCurrentUserState();
  const [wishlistBusy, setWishlistBusy] = useState(false);
  const [wishlistMessage, setWishlistMessage] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  const wishlistLock = useRef(false);
  const [brokenImage, setBrokenImage] = useState(false);
  const source = safeImageSource(product.imagePath);
  const discount = discountPercent(product.price, originalPrice);
  const available = product.stock > 0;
  useEffect(() => setBrokenImage(false), [source]);

  async function toggleWishlist() {
    if (!user) { setWishlistMessage("Sign in to save this product."); return; }
    if (wishlistLock.current) return;
    wishlistLock.current = true;
    setWishlistBusy(true);
    try {
      const result = await toggleWishlistProduct({ data: { productId: product.id } });
      setSaved(result.saved);
      setWishlistMessage(result.saved ? "Added to your wishlist." : "Removed from your wishlist.");
    } catch {
      setWishlistMessage("Could not update wishlist. Try again.");
    } finally { wishlistLock.current = false; setWishlistBusy(false); }
  }

  function productClick() {
    onAdClick?.();
    rememberDiscoveryReceipt(product.id, product.attributionReceipt);
    if (product.attributionReceipt) {
      void recordSearchObservation({ data: { receipt: product.attributionReceipt, eventType: "click" } }).catch(() => undefined);
    }
  }

  const impressionCallback = useRef(onAdImpression);
  impressionCallback.current = onAdImpression;
  const exposureRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const receipt = product.attributionReceipt, node = exposureRef.current;
    if ((!receipt && !impressionCallback.current) || !node || typeof IntersectionObserver === "undefined") return;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    const clearDwell = () => { if (dwell) clearTimeout(dwell); dwell = undefined; };
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(e => e.intersectionRatio >= 0.5) && document.visibilityState === 'visible';
      if (!visible) { clearDwell(); return; }
      if (dwell) return;
      // Count an impression after continuous screen visibility, not merely a
      // component render or a momentary scroll through the page.
      dwell = setTimeout(() => {
        dwell = undefined;
        if (document.visibilityState !== 'visible') return;
        observer.disconnect();
        impressionCallback.current?.();
        if (receipt) void recordSearchObservation({ data: { receipt, eventType: "impression" } }).catch(() => undefined);
      }, 2100);
    }, { threshold: [0, 0.5, 1] });
    observer.observe(node);
    document.addEventListener('visibilitychange', clearDwell);
    return () => { clearDwell(); observer.disconnect(); document.removeEventListener('visibilitychange', clearDwell); };
  }, [product.attributionReceipt, product.id, sponsored]);

  return (
    <article ref={exposureRef} className="group flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-market-line bg-white shadow-market transition-shadow duration-200 hover:border-market-green/25 hover:shadow-market-lg" aria-label={product.name}>
      <div className="relative">
        <Link to="/products/$id" params={{ id: product.id }} onClick={productClick} className="block" aria-label={`View ${product.name}`}>
          <div className="relative aspect-square overflow-hidden bg-[#f8faf9] sm:aspect-[6/5]">
            {source && !brokenImage ? (
              <img src={source} alt={product.name} loading="lazy" decoding="async" onError={() => setBrokenImage(true)} className="h-full w-full object-contain p-3 transition-transform duration-300 group-hover:scale-[1.04]" />
            ) : (
              <div className="grid h-full place-items-center text-market-muted"><ShoppingBag size={26} aria-hidden="true"/><span className="sr-only">Product photo unavailable</span></div>
            )}
            {sponsored && <span className="absolute bottom-2 left-2 rounded-md bg-white/95 px-2 py-1 text-[10px] font-semibold text-market-muted">Sponsored</span>}
            {!available && <span className="absolute left-2 top-2 rounded-lg bg-market-ink px-2 py-1 text-[10px] font-black text-white">Out of stock</span>}
            {discount !== null && available && <span className="absolute left-2 top-2 rounded-lg bg-market-orange px-2 py-1 text-[11px] font-black text-white">-{discount}%</span>}
            {officialStore && <span className="absolute right-2 top-2 rounded-lg border border-market-green/15 bg-white/95 px-2 py-1 text-[10px] font-extrabold text-market-green">Official store</span>}
          </div>
        </Link>
        <button type="button" disabled={wishlistBusy} aria-label={`Save ${product.name} to wishlist`} aria-pressed={saved === true} onClick={() => void toggleWishlist()} className="absolute bottom-2 right-2 inline-flex h-11 w-11 items-center justify-center rounded-full border border-market-line bg-white text-market-ink shadow-sm transition hover:bg-market-soft disabled:opacity-50">
          <Heart size={18} className={saved ? "fill-market-orange text-market-orange" : ""} aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-1 flex-col p-3.5 sm:p-4">
        {adTitle && <p className="mb-1 line-clamp-1 text-[11px] font-black text-market-orange">{adTitle}</p>}
        {adSubtitle && <p className="mb-1 line-clamp-2 text-[11px] text-market-muted">{adSubtitle}</p>}
        <Link to="/products/$id" params={{ id: product.id }} onClick={productClick} className="min-h-10 text-sm font-bold leading-5 text-market-ink hover:text-market-green sm:text-[15px]">
          <span className="line-clamp-2">{product.name}</span>
        </Link>
        <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-market-muted">
          <Link to="/stores/$id" params={{ id: product.merchantId }} className="max-w-full truncate hover:text-market-green hover:underline">{product.merchantName}</Link>
          {product.verified && <ShieldCheck size={14} className="shrink-0 text-market-green" aria-label="Verified merchant" />}
        </div>
        {(product.brand || product.model) && <p className="mt-1 truncate text-[11px] text-market-muted">{[product.brand, product.model].filter(Boolean).join(" · ")}</p>}
        {product.reviewCount > 0 && <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-market-ink"><Star size={13} className="fill-amber-500 text-amber-500" aria-hidden="true" />{product.avgRating?.toFixed(1)} <span className="font-normal text-market-muted">({product.reviewCount} reviews)</span></p>}
        <div className="mt-auto pt-3">
          <strong className="block text-lg font-black tracking-tight text-market-ink sm:text-xl">{formatGhs(product.price)}</strong>
          {discount !== null && <p className="mt-0.5 text-xs text-market-muted"><span className="line-through">{formatGhs(originalPrice!)}</span><span className="ml-2 font-bold text-market-orange">Save {discount}%</span></p>}
          {product.financingEligible && <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-market-green"><CreditCard size={12} aria-hidden="true"/> Financing may be available*</p>}
          {available && product.stock <= 5 && <p className="mt-1 text-[11px] font-bold text-market-orange">Only {product.stock} left</p>}
          {onAdd && !product.hasVariants && available ? (
            <button type="button" onClick={onAdd} className="market-btn-accent mt-3 w-full px-2" aria-label={`Add ${product.name} to cart`}> <ShoppingBag size={16} aria-hidden="true" />{quantity ? `Add another (${quantity} in cart)` : "Add to cart"}</button>
          ) : (
            <Link to="/products/$id" params={{ id: product.id }} onClick={productClick} className="market-btn-secondary mt-3 w-full px-2">{product.hasVariants && available ? "Choose options" : "View details"}<ArrowUpRight size={16} aria-hidden="true" /></Link>
          )}
        </div>
        {wishlistMessage && <p role="status" aria-live="polite" className="mt-2 text-[11px] text-market-muted">{wishlistMessage}</p>}
      </div>
    </article>
  );
}
