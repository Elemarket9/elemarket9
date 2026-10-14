import { z } from "zod";
import { readResponseBodyWithLimit } from "@/lib/security/body.server";
import type { GeocodedLocation, LocationProvider } from "@/modules/logistics/internal/adapters/location.server";

const geoapifyResult = z.object({
  lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180),
  formatted: z.string().min(1).max(500),
  city: z.string().max(120).optional(), state: z.string().max(120).optional(),
  postcode: z.string().max(40).optional(), country: z.string().max(120).optional(),
  country_code: z.string().max(8).optional(), confidence: z.number().min(0).max(1).optional(),
  place_id: z.string().max(256).optional(),
});

// Geoapify serializes `format=json` as { results: [...] }, not as a
// GeoJSON FeatureCollection ({ features: [{ properties: ... }] }).
// Both forward and reverse API requests below explicitly set format=json.
const geoapifyResponse = z.object({ results: z.array(geoapifyResult).max(100) });

function toLocation(properties: z.infer<typeof geoapifyResult>): GeocodedLocation {
  return {
    latitude: properties.lat,
    longitude: properties.lon,
    formattedAddress: properties.formatted,
    city: properties.city,
    state: properties.state,
    postcode: properties.postcode,
    country: properties.country,
    countryCode: properties.country_code,
    confidence: properties.confidence,
    providerPlaceId: properties.place_id,
  };
}

export class GeoapifyLocationProvider implements LocationProvider {
  constructor(private readonly apiKey: string, private readonly baseUrl = "https://api.geoapify.com/v1") {}

  private async request(url: URL): Promise<GeocodedLocation> {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Location provider returned HTTP ${response.status}`);
    const body = await readResponseBodyWithLimit(response, 512 * 1024);
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { throw new Error("Location provider returned invalid JSON"); }
    const parsed = geoapifyResponse.safeParse(payload);
    if (!parsed.success || parsed.data.results.length === 0) throw new Error("Location could not be found");
    return toLocation(parsed.data.results[0]);
  }

  async geocode(address: string): Promise<GeocodedLocation> {
    const url = new URL(`${this.baseUrl}/geocode/search`);
    url.searchParams.set("text", address);
    url.searchParams.set("filter", "countrycode:gh");
    url.searchParams.set("limit", "1");
    url.searchParams.set("format", "json");
    url.searchParams.set("apiKey", this.apiKey);
    return this.request(url);
  }

  async reverseGeocode(lat: number, lon: number): Promise<GeocodedLocation> {
    const url = new URL(`${this.baseUrl}/geocode/reverse`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "json");
    url.searchParams.set("apiKey", this.apiKey);
    return this.request(url);
  }
}
