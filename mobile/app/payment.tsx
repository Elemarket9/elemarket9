import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { apiJson } from "../src/api";
import { loadPaymentQueue, clearPaymentQueue, savePaymentQueue } from "../src/payment-queue";
import { requireServerCheckoutUrl } from "../src/payment-url";

export default function Payment() {
  // The route can be opened by an untrusted elemarket:// deep link. A URL
  // passed through router parameters is never financial authority.
  const { paymentId, groupId } = useLocalSearchParams<{ paymentId?: string; groupId?: string }>();
  const paymentKey = groupId ?? paymentId;
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);
  const handledPaymentId = useRef<string | null>(null);
  const mounted = useRef(true);
  const currentPaymentId = useRef(paymentKey);
  currentPaymentId.current = paymentKey;

  const checkPayment = useCallback(async () => {
    if (!mounted.current || !paymentKey || inFlight.current || handledPaymentId.current === paymentKey) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const result = await apiJson<{ status: string }>("/api/mobile/payment-status", { method: "POST", body: JSON.stringify(groupId ? { groupId } : { paymentId }) });
      if (!mounted.current || currentPaymentId.current !== paymentKey) return;
      setStatus(result.status);
      if (result.status === "completed") {
        if (groupId) {
          handledPaymentId.current = paymentKey;
          router.replace({pathname:"/order-success",params:{groupId}});
          return;
        }
        const queue = await loadPaymentQueue();
        if (!mounted.current || currentPaymentId.current !== paymentKey) return;
        if (queue.length) {
          const [next, ...rest] = queue;
          const intent = await apiJson<{ paymentId: string; checkoutUrl?: string }>("/api/mobile/payment-intent", { method: "POST", body: JSON.stringify({ paymentId: next.paymentId }) });
          if (!mounted.current || currentPaymentId.current !== paymentKey) return;
          if (!intent.checkoutUrl) throw new Error("The next payment provider did not return a secure checkout URL.");
          await savePaymentQueue(rest);
          if (!mounted.current || currentPaymentId.current !== paymentKey) return;
          handledPaymentId.current = paymentKey;
          router.replace({ pathname: "/payment", params: { paymentId: intent.paymentId } });
        } else {
          await clearPaymentQueue();
          if (!mounted.current || currentPaymentId.current !== paymentKey) return;
          handledPaymentId.current = paymentKey;
          setTimeout(() => { if (mounted.current && currentPaymentId.current === paymentId) router.replace({ pathname: "/order-success", params: { paymentId } }); }, 250);
        }
      }
    } catch (e) { if (mounted.current && currentPaymentId.current === paymentId) setStatus(e instanceof Error ? e.message : "Unable to verify payment"); }
    finally { inFlight.current = false; if (mounted.current && currentPaymentId.current === paymentId) setChecking(false); }
  }, [paymentKey, groupId, paymentId]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setStatus(null); setChecking(false); }, [paymentKey]);
  useEffect(() => {
    let active = true;
    setCheckoutUrl(null);
    setCheckoutError(null);
    if (!paymentKey) { setCheckoutError("Missing payment reference."); return () => { active = false; }; }
    // Re-read the checkout address from the authenticated backend. Its provider
    // host allowlist and ownership checks are authoritative, even after a reload.
    void apiJson<{ checkoutUrl?: unknown }>("/api/mobile/payment-intent", {
      method: "POST", body: JSON.stringify(groupId ? { groupId } : { paymentId }),
    }).then((result) => {
      const verified = requireServerCheckoutUrl(result.checkoutUrl);
      if (active) setCheckoutUrl(verified);
    }).catch(() => {
      if (active) setCheckoutError("Secure checkout is unavailable. Check your order payment status or try again.");
    });
    return () => { active = false; };
  }, [paymentKey, groupId, paymentId]);
  useEffect(() => { if (status === "completed") return; const timer = setInterval(() => void checkPayment(), 5000); return () => clearInterval(timer); }, [checkPayment, status]);
  if (!checkoutUrl) return <SafeAreaView style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
    {checkoutError ? <><Text accessibilityRole="alert" style={{ textAlign: "center", color: "#991b1b" }}>{checkoutError}</Text>
      <Pressable onPress={checkPayment} style={{ marginTop: 18, padding: 14 }}><Text>Check payment status</Text></Pressable>
      <Pressable onPress={() => router.replace("/cart")} style={{ marginTop: 12, padding: 14 }}><Text>Return to cart</Text></Pressable></>
      : <><ActivityIndicator/><Text style={{ marginTop: 12 }}>Opening verified checkout…</Text></>}
    </SafeAreaView>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: "white" }}>
    <View style={{ padding: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#eee" }}><Text style={{ fontWeight: "900" }}>Secure payment</Text><Pressable onPress={checkPayment}><Text style={{ color: "#14532d", fontWeight: "800" }}>{checking ? "Checking…" : "Check payment"}</Text></Pressable></View>
    <WebView source={{ uri: checkoutUrl }} javaScriptEnabled domStorageEnabled startInLoadingState renderLoading={() => <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>} onNavigationStateChange={(nav) => {
      try {
        const target = new URL(nav.url);
        const origin = new URL(process.env.EXPO_PUBLIC_API_BASE_URL ?? "").origin;
        if (target.origin === origin && target.pathname === (groupId ? "/payment/group-return" : "/payment/return")
            && target.searchParams.get(groupId ? "groupId" : "paymentId") === paymentKey) void checkPayment();
      } catch { /* Not a marketplace payment callback. */ }
    }} />
    {status && status !== "completed" && <View style={{ padding: 10 }}><Text style={{ textAlign: "center", color: "#667085" }}>Payment status: {status}. We verify payment with the provider before marking the order paid.</Text></View>}
  </SafeAreaView>;
}
