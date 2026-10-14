-- Geoapify location cache. Stores normalized provider results so repeated
-- address lookups do not consume the free-tier quota unnecessarily.
create table if not exists geocode_cache (
  cache_key text primary key,
  provider text not null check (provider = 'geoapify'),
  latitude numeric(10,7) not null check (latitude between -90 and 90),
  longitude numeric(10,7) not null check (longitude between -180 and 180),
  formatted_address text not null,
  city text,
  state text,
  postcode text,
  country text,
  country_code text,
  confidence numeric(5,4),
  provider_place_id text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists geocode_cache_expiry_idx on geocode_cache(expires_at);
