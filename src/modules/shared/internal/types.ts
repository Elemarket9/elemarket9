export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProductMedia = {
  id: string;
  productId: string;
  kind: "image" | "video";
  storageKey: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
};

export type ProductVariant = {
  id: string;
  productId: string;
  sku: string;
  name: string | null;
  attributes: JsonObject;
  price: string;
  stock: number;
  status: "draft" | "active" | "suspended" | "archived";
};
export type ProductCard = {
  attributionReceipt?: string;
  id: string;
  merchantId: string;
  merchantName: string;
  neighborhood: string;
  city: string;
  name: string;
  category: string;
  subcategory: string | null;
  brand: string | null;
  model: string | null;
  sku: string | null;
  condition: "new" | "refurbished" | "used" | "open_box";
  warrantyMonths: number | null;
  fulfillmentType: "delivery" | "pickup" | "delivery_and_pickup";
  status: "draft" | "pending_review" | "active" | "suspended" | "archived";
  returnable: boolean;
  returnWindowDays: number | null;
  attributes: JsonObject;
  financingEligible: boolean;
  financingMinAmount: string | null;
  financingMaxAmount: string | null;
  listingType: "product" | "food" | "stay";
  price: string;
  currency: "GHS";
  stock: number;
  hasVariants?: boolean;
  description: string;
  imagePath: string | null;
  mealType: string | null;
  cuisine: string | null;
  prepMinutes: number | null;
  guests: number | null;
  distanceKm: number | null;
  verified: boolean;
  merchantAddress: string;
  avgRating: number | null;
  reviewCount: number;
};

export type MerchantCard = {
  id: string;
  name: string;
  category: string;
  neighborhood: string;
  city: string;
  address: string;
  description: string;
  tier: string;
  verified: boolean;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
};

export type DeliveryOption = {
  quoteId: string;
  merchantId: string;
  merchantName: string;
  tier: "same_day" | "next_day" | "three_day";
  price: string;
  etaMinutes: number;
  distanceKm: number;
  expiresAt: string;
};

export type OrderSummary = {
  id: string;
  merchantId: string;
  merchantName: string;
  status: string;
  productTotal: string;
  deliveryTotal: string;
  grandTotal: string;
  deliveryTier: string;
  address: string;
  createdAt: string;
  items: { productId: string; name: string; quantity: number; unitPrice: string; imagePath: string | null }[];
};
