export type CartLine = {
  productId: string;
  variantId: string | null;
  quantity: number;
  name: string;
  price: string;
  imagePath: string | null;
  merchantId?: string;
  attributionReceipt?:string;
};

export const CART_KEY = "elemarket:cart:v2";
export const QUOTE_KEY = "elemarket:delivery-quotes:v1";
export const PAYMENT_QUEUE_KEY = "elemarket:payment-queue:v1";
let memoryCart: CartLine[] = [];
let memoryOnly = false;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;

/** Browser storage is untrusted and can contain values from older app versions. */
export function normalizeCart(value: unknown): CartLine[] {
  if (!Array.isArray(value)) return [];
  const lines: CartLine[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || !identifier(row.productId) || (row.variantId != null && !identifier(row.variantId)) || typeof row.name !== "string" || typeof row.price !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(row.price) || !Number.isSafeInteger(Math.round(Number(row.price) * 100) * Math.min(20, row.quantity)) || !Number.isInteger(row.quantity) || row.quantity < 1) continue;
    const variantId = row.variantId ?? null;
    const existing = lines.find(line => line.productId === row.productId && line.variantId === variantId);
    if (existing) { existing.quantity = Math.min(20, existing.quantity + row.quantity); continue; }
    if (lines.length >= 40) break;
    lines.push({ productId: row.productId, variantId, quantity: Math.min(20, row.quantity), name: row.name.slice(0, 400), price: row.price, imagePath: typeof row.imagePath === "string" ? row.imagePath : null, ...(typeof row.attributionReceipt==='string'&&row.attributionReceipt.length<=1024?{attributionReceipt:row.attributionReceipt}:{}), ...(identifier(row.merchantId) ? { merchantId: row.merchantId } : {}) });
  }
  return lines;
}

export function readCart(): CartLine[] {
  if (typeof window === "undefined") return [];
  if (memoryOnly) return memoryCart.map(line => ({ ...line }));
  let stored: string | null;
  try { stored = localStorage.getItem(CART_KEY); }
  catch { memoryOnly = true; return memoryCart.map(line => ({ ...line })); }
  try { return normalizeCart(JSON.parse(stored || "[]")); }
  catch { return []; }
}

export function writeCart(lines: CartLine[]) {
  if (typeof window === "undefined") return;
  memoryCart = normalizeCart(lines);
  try { localStorage.setItem(CART_KEY, JSON.stringify(memoryCart)); memoryOnly = false; }
  catch { memoryOnly = true; }
  window.dispatchEvent(new Event("elemarket:cart-updated"));
}

export function addCartLine(line: Omit<CartLine, "quantity"> & { quantity?: number; stock?: number }) {
  const lines = readCart();
  const stock = line.stock == null ? 20 : Math.max(0, Math.min(20, Math.floor(line.stock)));
  if (!Number.isFinite(stock) || stock === 0) return lines;
  const qty = Math.min(stock, Math.max(1, Math.floor(line.quantity ?? 1)));
  if (!Number.isFinite(qty)) return lines;
  const existing = lines.find(item => item.productId === line.productId && item.variantId === (line.variantId ?? null));
  if (existing){existing.quantity = Math.min(stock, existing.quantity + qty);if(line.attributionReceipt&&line.attributionReceipt.length<=1024)existing.attributionReceipt=line.attributionReceipt;}
  else if (lines.length < 40) lines.push({ ...line, variantId: line.variantId ?? null, quantity: qty });
  writeCart(lines);
  return readCart();
}

export function cartCount(lines: CartLine[]) {
  return normalizeCart(lines).reduce((sum, line) => sum + line.quantity, 0);
}

export function cartTotal(lines: CartLine[]) {
  return normalizeCart(lines).reduce((sum, line) => sum + Math.round(Number(line.price) * 100) * line.quantity, 0) / 100;
}
