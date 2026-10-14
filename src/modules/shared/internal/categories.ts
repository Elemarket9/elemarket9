export type CatalogGroup = {
  key: string;
  name: string;
  blurb: string;
  subcategories: readonly { key: string; name: string }[];
};

/** Canonical marketplace taxonomy. Product records store the stable keys, not display names. */
export const CATALOG_GROUPS = [
  { key: "food", name: "Food & Dining", blurb: "Prepared meals and food services", subcategories: [
    { key: "prepared-meals", name: "Prepared Meals" }, { key: "fast-food", name: "Fast Food" },
    { key: "bakery", name: "Bakery & Pastry" }, { key: "drinks", name: "Drinks & Beverages" },
    { key: "catering", name: "Catering" },
  ] },
  { key: "restaurants", name: "Restaurants", blurb: "Restaurants, kitchens and dining", subcategories: [
    { key: "ghanaian", name: "Ghanaian" }, { key: "continental", name: "Continental" },
    { key: "african", name: "African" }, { key: "fast-casual", name: "Fast Casual" },
  ] },
  { key: "groceries", name: "Groceries", blurb: "Staples, produce and household consumables", subcategories: [
    { key: "fresh-produce", name: "Fresh Produce" }, { key: "staples", name: "Staples" },
    { key: "meat-seafood", name: "Meat & Seafood" }, { key: "beverages", name: "Beverages" },
    { key: "household-consumables", name: "Household Consumables" },
  ] },
  { key: "electronics", name: "Electronics", blurb: "Consumer electronics and technology", subcategories: [
    { key: "mobile-phones", name: "Mobile Phones" }, { key: "phone-accessories", name: "Phone Accessories" },
    { key: "laptops", name: "Laptops" }, { key: "desktops", name: "Desktops" },
    { key: "tablets", name: "Tablets" }, { key: "computer-accessories", name: "Computer Accessories" },
    { key: "monitors", name: "Monitors" }, { key: "printers", name: "Printers & Scanners" },
    { key: "networking", name: "Networking" }, { key: "storage", name: "Storage" },
    { key: "components", name: "Computer Components" }, { key: "audio", name: "Audio" },
    { key: "cameras", name: "Cameras & Photography" }, { key: "gaming", name: "Gaming" },
    { key: "smart-home", name: "Smart Home" }, { key: "power", name: "Power & Charging" },
    { key: "wearables", name: "Wearables" }, { key: "tv", name: "TV & Video" },
  ] },
  { key: "fashion", name: "Fashion", blurb: "Clothing, footwear and accessories", subcategories: [
    { key: "womens-clothing", name: "Women's Clothing" }, { key: "mens-clothing", name: "Men's Clothing" },
    { key: "kids-clothing", name: "Kids' Clothing" }, { key: "footwear", name: "Footwear" },
    { key: "bags", name: "Bags" }, { key: "jewelry", name: "Jewelry & Watches" },
    { key: "fashion-accessories", name: "Fashion Accessories" },
  ] },
  { key: "beauty", name: "Beauty & Personal Care", blurb: "Beauty, hair and personal care", subcategories: [
    { key: "skincare", name: "Skincare" }, { key: "haircare", name: "Haircare" },
    { key: "makeup", name: "Makeup" }, { key: "fragrance", name: "Fragrance" },
    { key: "personal-care", name: "Personal Care" },
  ] },
  { key: "home", name: "Home & Living", blurb: "Furniture, appliances and household goods", subcategories: [
    { key: "furniture", name: "Furniture" }, { key: "home-decor", name: "Home Decor" },
    { key: "kitchen", name: "Kitchen & Dining" }, { key: "appliances", name: "Home Appliances" },
    { key: "refrigerators", name: "Refrigerators" }, { key: "freezers", name: "Freezers" },
    { key: "washing-machines", name: "Washing Machines" }, { key: "dryers", name: "Dryers" },
    { key: "dishwashers", name: "Dishwashers" }, { key: "cookers-ovens", name: "Cookers & Ovens" },
    { key: "microwaves", name: "Microwaves" }, { key: "blenders-mixers", name: "Blenders & Mixers" },
    { key: "air-conditioners", name: "Air Conditioners" }, { key: "fans", name: "Fans" },
    { key: "water-heaters", name: "Water Heaters" }, { key: "vacuum-cleaners", name: "Vacuum Cleaners" },
    { key: "irons", name: "Irons" }, { key: "small-appliances", name: "Small Appliances" },
    { key: "bedding", name: "Bedding & Bath" }, { key: "lighting", name: "Lighting" },
  ] },
  { key: "agriculture", name: "Agriculture", blurb: "Produce, equipment and farm inputs", subcategories: [
    { key: "farm-produce", name: "Farm Produce" }, { key: "seeds", name: "Seeds" },
    { key: "fertilizer", name: "Fertilizer & Inputs" }, { key: "farm-equipment", name: "Farm Equipment" },
    { key: "livestock", name: "Livestock" },
  ] },
  { key: "automotive", name: "Automotive", blurb: "Vehicles, parts and mobility products", subcategories: [
    { key: "cars", name: "Cars" }, { key: "motorcycles", name: "Motorcycles" },
    { key: "parts", name: "Parts" }, { key: "tires", name: "Tires & Wheels" },
    { key: "car-care", name: "Car Care" }, { key: "accessories", name: "Accessories" },
  ] },
  { key: "health", name: "Health & Wellness", blurb: "Health products and approved services", subcategories: [
    { key: "otc", name: "OTC Products" }, { key: "medical-devices", name: "Medical Devices" },
    { key: "wellness", name: "Wellness" }, { key: "pharmacy-services", name: "Pharmacy Services" },
  ] },
  { key: "hospitality", name: "Stays & Hospitality", blurb: "Accommodation and hospitality services", subcategories: [
    { key: "apartments", name: "Apartments" }, { key: "hotels", name: "Hotels" },
    { key: "guesthouses", name: "Guesthouses" }, { key: "short-stays", name: "Short Stays" },
  ] },
  { key: "baby-kids", name: "Baby & Kids", blurb: "Baby essentials, kids products and school items", subcategories: [
    { key: "baby-care", name: "Baby Care" }, { key: "baby-gear", name: "Baby Gear" }, { key: "kids-toys", name: "Kids Toys" }, { key: "school-items", name: "School Items" },
  ] },
  { key: "books-media", name: "Books & Media", blurb: "Books, educational materials and media", subcategories: [
    { key: "books", name: "Books" }, { key: "school-books", name: "School Books" }, { key: "music-media", name: "Music & Media" },
  ] },
  { key: "sports", name: "Sports & Outdoors", blurb: "Sports equipment, fitness and outdoor goods", subcategories: [
    { key: "fitness", name: "Fitness" }, { key: "football", name: "Football" }, { key: "sports-equipment", name: "Sports Equipment" }, { key: "outdoor", name: "Outdoor" },
  ] },
  { key: "office", name: "Office & School", blurb: "Office equipment, stationery and supplies", subcategories: [
    { key: "stationery", name: "Stationery" }, { key: "office-equipment", name: "Office Equipment" }, { key: "school-supplies", name: "School Supplies" },
  ] },
  { key: "industrial-machinery", name: "Industrial Machinery", blurb: "Industrial equipment, tools and machinery", subcategories: [
    { key: "sewing-machines", name: "Sewing Machines" }, { key: "garment-equipment", name: "Garment Equipment" }, { key: "workshop-tools", name: "Workshop Tools" }, { key: "industrial-equipment", name: "Industrial Equipment" },
  ] },
  { key: "construction", name: "Construction & Tools", blurb: "Building materials, tools and equipment", subcategories: [
    { key: "building-materials", name: "Building Materials" }, { key: "hand-tools", name: "Hand Tools" }, { key: "power-tools", name: "Power Tools" }, { key: "safety-equipment", name: "Safety Equipment" },
  ] },
  { key: "pets", name: "Pets & Supplies", blurb: "Pet products and supplies", subcategories: [
    { key: "pet-food", name: "Pet Food" }, { key: "pet-care", name: "Pet Care" }, { key: "pet-accessories", name: "Pet Accessories" },
  ] },
  { key: "services", name: "Services", blurb: "Local professional and household services", subcategories: [
    { key: "repairs", name: "Repairs" }, { key: "cleaning", name: "Cleaning" },
    { key: "beauty-services", name: "Beauty Services" }, { key: "professional", name: "Professional Services" },
    { key: "lessons", name: "Lessons & Training" }, { key: "events", name: "Events" },
  ] },
] as const;

export const CATEGORIES = CATALOG_GROUPS;
export type CategoryKey = (typeof CATALOG_GROUPS)[number]["key"];
export const CATEGORY_KEYS = CATALOG_GROUPS.map((c) => c.key) as [CategoryKey, ...CategoryKey[]];
export const CATEGORY_SUBCATEGORIES = Object.fromEntries(CATALOG_GROUPS.map((c) => [c.key, c.subcategories]));

export function isValidSubcategory(category: string, subcategory: string): boolean {
  const group = CATALOG_GROUPS.find((c) => c.key === category);
  return Boolean(group?.subcategories.some((s) => s.key === subcategory));
}
