/** Keys must match the category-integrity trigger in migrations/0008 and 0180. */
export const REQUIRED_PRODUCT_ATTRIBUTES: Record<string,readonly string[]> = {
  "mobile-phones": ["network","storage_gb","ram_gb"],
  laptops: ["cpu","ram_gb","storage_gb","screen_inches","os"],
  desktops: ["cpu","ram_gb","storage_gb","os"],
  tablets: ["storage_gb","ram_gb","screen_inches","os"],
  monitors: ["screen_inches","resolution","refresh_rate_hz"],
  printers: ["print_type","connectivity"],
  networking: ["device_type","ports"],
  storage: ["storage_type","capacity_gb"],
  components: ["component_type","compatibility"],
  tv: ["screen_inches","resolution","smart_tv"],
  refrigerators: ["capacity_litres","energy_rating"],
  freezers: ["capacity_litres","energy_rating"],
  "washing-machines": ["capacity_kg","energy_rating"],
  dryers: ["capacity_kg","energy_rating"],
  dishwashers: ["capacity_place_settings","energy_rating"],
  "cookers-ovens": ["fuel_type","burners"],
  microwaves: ["capacity_litres","power_watts"],
  "air-conditioners": ["capacity_btu","energy_rating"],
  fans: ["fan_type","speed_levels"],
  "water-heaters": ["capacity_litres","energy_rating"],
  "vacuum-cleaners": ["vacuum_type","power_watts"],
  irons: ["iron_type","power_watts"],
};
export const NUMERIC_PRODUCT_ATTRIBUTES = new Set([
  "storage_gb","ram_gb","screen_inches","refresh_rate_hz","capacity_litres","capacity_kg",
  "power_watts","capacity_btu","burners","speed_levels","ports","capacity_place_settings",
]);
