import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { apiJson } from "../src/api";
import { loadPaymentQueue, clearPaymentQueue, savePaymentQueue } from "../src/payment-queue";

export default function Payment() {
  const { url, paymentId } = useLocalSearchParams<{ url: string; paymentId: string }>();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);
  const handledPaymentId = useRef<string | null>(null);
  const mounted = useRef(true);
  const currentPaymentId = useRef(paymentId);
  currentPaymentId.current = paymentId;

  const checkPayment = useCallback(async () => {
    if (!mounted.current || !paymentId || inFlight.current || handledPaymentId.current === paymentId) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const result = await apiJson<{ status: string }>("/api/mobile/payment-status", { method: "POST", body: JSON.stringify({ paymentId }) });
      if (!mounted.current || currentPaymentId.current !== paymentId) return;
      setStatus(result.status);
      if (result.status === "completed") {
        const queue = await loadPaymentQueue();
        if (!mounted.current || currentPaymentId.current !== paymentId) return;
        if (queue.length) {
          const [next, ...rest] = queue;
          const intent = await apiJson<{ paymentId: string; checkoutUrl?: string }>("/api/mobile/payment-intent", { method: "POST", body: JSON.stringify({ paymentId: next.paymentId }) });
          if (!mounted.current || currentPaymentId.current !== paymentId) return;
          if (!intent.checkoutUrl) throw new Error("The next payment provider did not return a secure checkout URL.");
          await savePaymentQueue(rest);
          if (!mounted.current || currentPaymentId.current !== paymentId) return;
          handledPaymentId.current = paymentId;
          router.replace({ pathname: "/payment", params: { url: intent.checkoutUrl, paymentId: intent.paymentId } });
        } else {
          await clearPaymentQueue();
          if (!mounted.current || currentPaymentId.current !== paymentId) return;
          handledPaymentId.current = paymentId;
          setTimeout(() => { if (mounted.current && currentPaymentId.current === paymentId) router.replace({ pathname: "/order-success", params: { paymentId } }); }, 250);
        }
      }
    } catch (e) { if (mounted.current && currentPaymentId.current === paymentId) setStatus(e instanceof Error ? e.message : "Unable to verify payment"); }
    finally { inFlight.current = false; if (mounted.current && currentPaymentId.current === paymentId) setChecking(false); }
  }, [paymentId]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setStatus(null); setChecking(false); }, [paymentId]);
  useEffect(() => { if (status === "completed") return; const timer = setInterval(() => void checkPayment(), 5000); return () => clearInterval(timer); }, [checkPayment, status]);
  if (!url) return <SafeAreaView style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><Text>Invalid payment session.</Text></SafeAreaView>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: "white" }}>
    <View style={{ padding: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#eee" }}><Text style={{ fontWeight: "900" }}>Secure payment</Text><Pressable onPress={checkPayment}><Text style={{ color: "#14532d", fontWeight: "800" }}>{checking ? "Checking…" : "Check payment"}</Text></Pressable></View>
    <WebView source={{ uri: url }} javaScriptEnabled domStorageEnabled startInLoadingState renderLoading={() => <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>} onNavigationStateChange={(nav) => { if (nav.url.includes("/payment/return") && nav.url.includes("paymentId=")) checkPayment(); }} />
    {status && status !== "completed" && <View style={{ padding: 10 }}><Text style={{ textAlign: "center", color: "#667085" }}>Payment status: {status}. We verify payment with the provider before marking the order paid.</Text></View>}
  </SafeAreaView>;
}
