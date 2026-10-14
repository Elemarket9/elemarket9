import { router, Link } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import { loadCart, saveCart, type CartItem } from "../src/cart";

export default function Cart() {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => { loadCart().then(setItems); }, []);
  const total = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  async function change(item: CartItem, delta: number) {
    const next = items.map((x) => x.productId === item.productId && x.variantId === item.variantId ? { ...x, quantity: Math.max(0, Math.min(x.stock, x.quantity + delta)) } : x).filter((x) => x.quantity > 0);
    setItems(next); await saveCart(next);
  }
  return <SafeAreaView style={{ flex: 1, backgroundColor: "#f5f7f4" }}>
    <View style={{ padding: 20, flex: 1 }}>
      <Text style={{ fontSize: 28, fontWeight: "900", color: "#14532d" }}>Cart</Text>
      <FlatList data={items} keyExtractor={(x) => `${x.productId}:${x.variantId ?? "default"}`} contentContainerStyle={{ gap: 10, paddingVertical: 15 }} renderItem={({ item }) => <View style={{ backgroundColor: "white", borderRadius: 16, padding: 16 }}>
        <Text style={{ fontWeight: "900", fontSize: 17 }}>{item.name}</Text><Text style={{ color: "#667085" }}>{item.merchantName}</Text><Text style={{ fontWeight: "900", marginTop: 8 }}>GHS {item.price}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 12 }}><Pressable onPress={() => change(item, -1)} style={{ padding: 10, backgroundColor: "#eee", borderRadius: 10 }}><Text>-</Text></Pressable><Text style={{ fontWeight: "900" }}>{item.quantity}</Text><Pressable onPress={() => change(item, 1)} style={{ padding: 10, backgroundColor: "#eee", borderRadius: 10 }}><Text>+</Text></Pressable></View>
      </View>} ListEmptyComponent={<View><Text style={{ color: "#667085", marginTop: 20 }}>Your cart is empty.</Text><Link href="/" asChild><Pressable style={{ marginTop: 15, backgroundColor: "#14532d", padding: 14, borderRadius: 12, alignItems: "center" }}><Text style={{ color: "white", fontWeight: "900" }}>Continue shopping</Text></Pressable></Link></View>} />
      {items.length > 0 && <View style={{ backgroundColor: "white", borderRadius: 16, padding: 16, gap: 10 }}><Text style={{ fontSize: 18, fontWeight: "900" }}>Subtotal: GHS {total.toFixed(2)}</Text><Pressable onPress={() => router.push("/checkout")} style={{ backgroundColor: "#14532d", padding: 15, borderRadius: 12, alignItems: "center" }}><Text style={{ color: "white", fontWeight: "900" }}>Checkout securely</Text></Pressable></View>}
    </View>
  </SafeAreaView>;
}
