import * as SecureStore from "expo-secure-store";

const KEY = "elemarket.payment-queue.v1";

type PaymentQueue = { paymentId: string }[];

export async function savePaymentQueue(queue: PaymentQueue) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(queue));
}

export async function loadPaymentQueue(): Promise<PaymentQueue> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is { paymentId: string } => Boolean(x && typeof x === "object" && typeof x.paymentId === "string")) : [];
  } catch {
    return [];
  }
}

export async function clearPaymentQueue() {
  await SecureStore.deleteItemAsync(KEY);
}
