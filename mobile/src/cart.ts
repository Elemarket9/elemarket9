import * as SecureStore from "expo-secure-store";

export type CartItem = {
  productId: string;
  variantId: string | null;
  merchantId: string;
  merchantName: string;
  name: string;
  price: string;
  quantity: number;
  stock: number;
};

const KEY = "elemarket.cart.v1";

export async function loadCart(): Promise<CartItem[]> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function saveCart(items: CartItem[]) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(items));
}

export async function clearCart() { await SecureStore.deleteItemAsync(KEY); }
