import { useEffect, useRef, useState } from "react";
import { createAssistedOrderDraft, searchProductsForAssistedOrder, type AssistedProductRow } from "@/modules/support/public/admin-support.functions";
import { formatGhs } from "@/modules/shared/public/money";

type DraftItem = { productId: string; variantId: string | null; name: string; quantity: number; stock: number };
type Variant = { id: string; name: string; price: string; stock: number };
function variantsOf(product: AssistedProductRow): Variant[] {
  return product.variants.filter((value): value is Variant => Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.price === "string" && typeof value.stock === "number"));
}

export function AssistedOrderComposer({ conversationId, disabled }: { conversationId: string; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssistedProductRow[]>([]);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const version = useRef(0);
  const creating = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current += 1; }; }, []);

  async function search() {
    const q = query.trim();
    const current = ++version.current;
    if (q.length < 2 || q.length > 80) { setResults([]); setNotice("Enter 2–80 characters to search products."); return; }
    setSearching(true); setNotice(null);
    try {
      const rows = await searchProductsForAssistedOrder({ data: { q } });
      if (mounted.current && version.current === current) setResults(rows);
    } catch { if (mounted.current && version.current === current) setNotice("Product search failed. Please try again."); }
    finally { if (mounted.current && version.current === current) setSearching(false); }
  }

  function add(product: AssistedProductRow, variant?: Variant) {
    const stock = Math.min(20, Math.max(0, Math.floor(variant?.stock ?? product.stock)));
    if (stock === 0 || disabled || busy) return;
    setItems(current => {
      const existing = current.find(item => item.productId === product.id && item.variantId === (variant?.id ?? null));
      if (existing) return current.map(item => item === existing ? { ...item, quantity: Math.min(stock, item.quantity + 1), stock } : item);
      if (current.length >= 40) { setNotice("An assisted order can contain at most 40 items."); return current; }
      return [...current, { productId: product.id, variantId: variant?.id ?? null, quantity: 1, stock, name: variant ? `${product.name} · ${variant.name}` : product.name }];
    });
  }

  async function create() {
    if (!items.length || creating.current || disabled) return;
    creating.current = true; setBusy(true); setNotice(null);
    try {
      await createAssistedOrderDraft({ data: { conversationId, items: items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })) } });
      if (mounted.current) { setItems([]); setResults([]); setNotice("Order draft prepared. The customer can review it in their support conversation."); }
    } catch { if (mounted.current) setNotice("The draft could not be confirmed. Refresh this conversation and check for an existing draft before retrying."); }
    finally { creating.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className="border-t border-market-line bg-market-soft p-3" aria-label="Agent-assisted order">
    <h3 className="text-xs font-black">Agent-assisted order</h3>
    <p className="mt-1 text-[10px] text-market-muted">Prepare items for this customer to review. Customer approval and payment are still required.</p>
    <div className="mt-2 flex gap-2">
      <input aria-label="Search assisted-order products" value={query} maxLength={80} onChange={event => { version.current += 1; setSearching(false); setResults([]); setQuery(event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void search(); } }} disabled={disabled || busy} placeholder="Search product…" className="min-w-0 flex-1 rounded-lg border border-market-line bg-white px-3 py-2 text-xs" />
      <button type="button" onClick={() => void search()} disabled={searching || disabled || busy} className="rounded-lg border border-market-line bg-white px-3 text-xs font-black">{searching ? "Searching…" : "Search"}</button>
    </div>
    <div className="mt-2 max-h-40 overflow-auto">{results.map(product => {
      const variants = variantsOf(product);
      return <div key={product.id} className="mb-1 rounded-lg bg-white p-2 text-xs"><b>{product.name}</b><p className="text-[10px] text-market-muted">{product.merchantName} · {formatGhs(product.price)}</p>{variants.length ? variants.map(variant => <button key={variant.id} type="button" disabled={disabled || busy || variant.stock <= 0} onClick={() => add(product, variant)} className="mt-1 block text-left text-[10px] font-black text-market-green">Add {variant.name} · {formatGhs(variant.price)}</button>) : <button type="button" disabled={disabled || busy || product.stock <= 0} onClick={() => add(product)} className="mt-1 text-[10px] font-black text-market-green">Add {product.name}</button>}</div>;
    })}</div>
    {items.map(item => <div key={`${item.productId}:${item.variantId}`} className="mt-1 flex justify-between gap-2 text-xs"><span className="min-w-0 truncate">{item.name} × {item.quantity}</span><button type="button" disabled={busy} onClick={() => setItems(current => current.filter(value => value !== item))} className="text-red-600">Remove</button></div>)}
    <button type="button" disabled={disabled || busy || !items.length} onClick={() => void create()} className="mt-2 rounded-lg bg-market-green px-3 py-2 text-xs font-black text-white disabled:opacity-40">{busy ? "Preparing…" : "Send order for review"}</button>
    {notice && <p role="status" className="mt-2 text-xs text-market-muted">{notice}</p>}
  </section>;
}
