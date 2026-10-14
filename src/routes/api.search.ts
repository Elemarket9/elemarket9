import { createFileRoute } from "@tanstack/react-router";
import { searchProducts } from "@/modules/catalog/public/search.server";
import { enforceRateLimit, rateLimitResponse } from "@/lib/security/rate-limit.server";

const SEARCH_SORTS = new Set(["relevance", "price_asc", "price_desc", "newest"]);
const LISTING_TYPES = new Set(["product", "food", "stay"]);
const CONDITIONS = new Set(["new", "refurbished", "used", "open_box"]);

function enumParam<T extends string>(value: string | null, valid: Set<string>, label: string): T | undefined {
  if (value === null) return undefined;
  if (!valid.has(value)) throw new Error(`invalid ${label}`);
  return value as T;
}
function boundedNumber(value: string | null, label: string, minimum: number, maximum: number) {
  const parsed = numberParam(value);
  if (parsed !== undefined && (parsed < minimum || parsed > maximum)) throw new Error(`invalid ${label}`);
  return parsed;
}
function boolParam(value: string | null, fallback: boolean) {
  if (value == null) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("invalid boolean");
}
function numberParam(value: string | null) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("invalid number");
  return n;
}

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await enforceRateLimit("api-search", { windowSeconds: 60, maxRequests: 120 });
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          throw error;
        }
        const url = new URL(request.url);
        try {
          const rawQuery = (url.searchParams.get("q") ?? "").trim();
          if (rawQuery.length > 120) throw new Error("invalid query");
          const q = rawQuery;
          const lat = boundedNumber(url.searchParams.get("lat"), "latitude", -90, 90);
          const lon = boundedNumber(url.searchParams.get("lon"), "longitude", -180, 180);
          const radiusKm = boundedNumber(url.searchParams.get("radiusKm"), "radius", 3, 100);
          if ((lat === undefined) !== (lon === undefined)) throw new Error("invalid location");
          if (radiusKm !== undefined && lat === undefined) throw new Error("invalid location");
          const minPrice = boundedNumber(url.searchParams.get("minPrice"), "price", 0, 1000000000);
          const maxPrice = boundedNumber(url.searchParams.get("maxPrice"), "price", 0, 1000000000);
          if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) throw new Error("invalid price range");
          const sort = enumParam<"relevance" | "price_asc" | "price_desc" | "newest">(url.searchParams.get("sort"), SEARCH_SORTS, "sort") ?? "relevance";
          const rawLimit = url.searchParams.get("limit");
          const requestedLimit = rawLimit == null ? 40 : Number(rawLimit);
          if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 60) {
            return Response.json({ error: "Invalid search limit" }, { status: 400, headers: { "Cache-Control": "no-store" } });
          }
          const limit = requestedLimit;
          const result = await searchProducts({
            q,
            category: url.searchParams.get("category") ?? undefined,
            subcategory: url.searchParams.get("subcategory") ?? undefined,
            brand: url.searchParams.get("brand") ?? undefined,
            model: url.searchParams.get("model") ?? undefined,
            merchantId: url.searchParams.get("merchantId") ?? undefined,
            listingType: enumParam<"product" | "food" | "stay">(url.searchParams.get("listingType"), LISTING_TYPES, "listing type"),
            condition: enumParam<"new" | "refurbished" | "used" | "open_box">(url.searchParams.get("condition"), CONDITIONS, "condition"),
            lat,
            lon,
            radiusKm,
            minPrice,
            maxPrice,
            inStock: boolParam(url.searchParams.get("inStock"), true),
            sort,
            limit,
            cursor: url.searchParams.get("cursor") ?? undefined,
          });
          return Response.json(result, { headers: { "Cache-Control": "no-store", "X-Search-Version": result.searchVersion } });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Search unavailable";
          if (error instanceof Error && error.name === "ZodError") return Response.json({ error: "Invalid search filters" }, { status: 400, headers: { "Cache-Control": "no-store" } });
          if (message.startsWith("invalid ") || message.startsWith("invalid location") || message === "invalid price range" || message.startsWith("invalid or expired search cursor") || message.startsWith("search cursor does not match")) return Response.json({ error: "Invalid search filters or cursor" }, { status: 400, headers: { "Cache-Control": "no-store" } });
          if (message.startsWith("Search catalog changed") || message.startsWith("Search ranking refreshed")) return Response.json({ error: "Search results changed; restart pagination" }, { status: 409, headers: { "Cache-Control": "no-store" } });
          return new Response("Search unavailable", { status: 503 });
        }
      },
    },
  },
});
