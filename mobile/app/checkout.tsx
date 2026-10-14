import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { apiJson } from "../src/api";
import { loadCart, clearCart, type CartItem } from "../src/cart";
import { savePaymentQueue } from "../src/payment-queue";

export default function Checkout() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState<"mobile_money" | "card" | "bank_transfer">("mobile_money");
  const [tier, setTier] = useState<"same_day" | "next_day" | "three_day">("next_day");
  const [quotes, setQuotes] = useState<Array<{ merchantId: string; quoteId: string; price: string; etaMinutes: number }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadCart().then(setItems); }, []);
  const subtotal = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  const delivery = quotes.reduce((sum, quote) => sum + Number(quote.price), 0);

  async function getQuote() {
    if (address.trim().length < 8) return Alert.alert("Delivery address", "Enter a complete delivery address.");
    setBusy(true);
    try {
      const merchantIds = [...new Set(items.map((item) => item.merchantId))];
      const result = [] as typeof quotes;
      for (const merchantId of merchantIds) {
        const q = await apiJson<{ id: string; price: string; etaMinutes: number }>("/api/mobile/delivery-quote", { method: "POST", body: JSON.stringify({ merchantId, address: address.trim(), tier }) });
        result.push({ merchantId, quoteId: q.id, price: q.price, etaMinutes: q.etaMinutes });
      }
      setQuotes(result);
    } catch (e) { Alert.alert("Delivery quote failed", e instanceof Error ? e.message : "Please try again"); }
    finally { setBusy(false); }
  }

  async function pay() {
    if (!items.length) return Alert.alert("Cart", "Your cart is empty.");
    if (address.trim().length < 8) return Alert.alert("Delivery address", "Enter a complete delivery address.");
    if (!quotes.length) return Alert.alert("Delivery", "Get a live delivery quote first.");
    setBusy(true);
    try {
      const payload = { items: items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })), quotes: quotes.map(({ merchantId, quoteId }) => ({ merchantId, quoteId })), address: address.trim(), method, promoCode: null };
      const fingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(payload), { encoding: Crypto.CryptoEncoding.HEX });
      const orderResult = await apiJson<{ orders?: Array<{ paymentId?: string }> } | null>("/api/mobile/checkout", { method: "POST", body: JSON.stringify({ ...payload, fingerprint, idempotencyKey: Crypto.randomUUID() }) });
      const paymentIds = (orderResult?.orders ?? []).map((x) => x.paymentId).filter((x): x is string => Boolean(x));
      if (!paymentIds.length) throw new Error("No payable order was created.");
      const intent = await apiJson<{ paymentId: string; checkoutUrl?: string }>("/api/mobile/payment-intent", { method: "POST", body: JSON.stringify({ paymentId: paymentIds[0] }) });
      if (!intent.checkoutUrl) throw new Error("The payment provider did not return a secure checkout URL.");
      await savePaymentQueue(paymentIds.slice(1).map((paymentId) => ({ paymentId })));
      await clearCart();
      router.replace({ pathname: "/payment", params: { url: intent.checkoutUrl, paymentId: intent.paymentId } });
    } catch (e) { Alert.alert("Payment", e instanceof Error ? e.message : "Could not start payment"); }
    finally { setBusy(false); }
  }

  return <SafeAreaView style={{ flex: 1, backgroundColor: "#f5f7f4" }}><ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
    <Text style={{ fontSize: 28, fontWeight: "900", color: "#14532d" }}>Secure checkout</Text>
    <View style={{ backgroundColor: "white", borderRadius: 16, padding: 16 }}><Text style={{ fontWeight: "900", fontSize: 18 }}>Delivery address</Text><TextInput value={address} onChangeText={setAddress} placeholder="House number, street, area, city" multiline style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, marginTop: 10, minHeight: 80 }} /><View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>{(["same_day", "next_day", "three_day"] as const).map((x) => <Pressable key={x} onPress={() => setTier(x)} style={{ flex: 1, padding: 10, borderRadius: 10, backgroundColor: tier === x ? "#14532d" : "#eee" }}><Text style={{ color: tier === x ? "white" : "#111", textAlign: "center", fontSize: 12, fontWeight: "800" }}>{x.replace("_", " ")}</Text></Pressable>)}</View><Pressable disabled={busy} onPress={getQuote} style={{ marginTop: 12, padding: 14, borderRadius: 12, backgroundColor: "#eee", alignItems: "center" }}><Text style={{ fontWeight: "900" }}>{busy ? "Working…" : "Get live delivery quote"}</Text></Pressable>{quotes.map((q) => <Text key={q.quoteId} style={{ marginTop: 8, color: "#667085" }}>Delivery: GHS {q.price} · {q.etaMinutes} min</Text>)}</View>
    <View style={{ backgroundColor: "white", borderRadius: 16, padding: 16 }}><Text style={{ fontWeight: "900", fontSize: 18 }}>Payment method</Text><View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>{(["mobile_money", "card", "bank_transfer"] as const).map((x) => <Pressable key={x} onPress={() => setMethod(x)} style={{ flex: 1, padding: 11, borderRadius: 10, backgroundColor: method === x ? "#14532d" : "#eee" }}><Text style={{ color: method === x ? "white" : "#111", textAlign: "center", fontSize: 12, fontWeight: "800" }}>{x.replaceAll("_", " ")}</Text></Pressable>)}</View></View>
    <View style={{ backgroundColor: "white", borderRadius: 16, padding: 16, gap: 8 }}><Text>Items: GHS {subtotal.toFixed(2)}</Text><Text>Delivery: GHS {delivery.toFixed(2)}</Text><Text style={{ fontSize: 20, fontWeight: "900" }}>Total: GHS {(subtotal + delivery).toFixed(2)}</Text><Pressable disabled={busy} onPress={pay} style={{ marginTop: 8, backgroundColor: "#14532d", padding: 16, borderRadius: 12, alignItems: "center" }}><Text style={{ color: "white", fontWeight: "900" }}>{busy ? "Starting secure payment…" : "Pay securely"}</Text></Pressable></View>
  </ScrollView></SafeAreaView>;
}
