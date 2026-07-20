-- Shared master product catalog and administrator marketplace matching queue
create extension if not exists pgcrypto;

create table if not exists master_products (
  id uuid primary key default gen_random_uuid(),
  normalized_key text not null unique,
  official_name text not null,
  brand text,
  product_set text,
  category text,
  product_type text,
  upc text,
  release_date date,
  msrp numeric(12,2),
  image_url text,
  retailer_skus jsonb not null default '{}'::jsonb,
  marketplace_urls jsonb not null default '{}'::jsonb,
  marketplace_status jsonb not null default '{}'::jsonb,
  current_market_value numeric(12,2),
  market_source text,
  market_updated_at timestamptz,
  match_status text not null default 'pending' check(match_status in ('pending','searching','review','matched','not_found','ignored')),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  last_search_at timestamptz,
  search_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists master_products_status_idx on master_products(match_status, updated_at desc);
create index if not exists master_products_upc_idx on master_products(upc) where upc is not null;

create table if not exists master_product_candidates (
  id uuid primary key default gen_random_uuid(),
  master_product_id uuid not null references master_products(id) on delete cascade,
  marketplace text not null,
  candidate_title text not null,
  candidate_url text not null,
  image_url text,
  observed_price numeric(12,2),
  confidence numeric(5,4) not null default 0,
  raw_data jsonb,
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(master_product_id, marketplace, candidate_url)
);
create index if not exists master_product_candidates_review_idx on master_product_candidates(master_product_id,status,confidence desc);

create table if not exists master_market_observations (
  id uuid primary key default gen_random_uuid(),
  master_product_id uuid not null references master_products(id) on delete cascade,
  marketplace text not null,
  price numeric(12,2) not null,
  title text,
  listing_url text,
  confidence numeric(5,4) not null default .8,
  observed_at timestamptz not null default now(),
  raw_data jsonb
);
create index if not exists master_market_obs_idx on master_market_observations(master_product_id,observed_at desc);

alter table investment_products add column if not exists master_product_id uuid references master_products(id) on delete set null;
create index if not exists investment_products_master_idx on investment_products(master_product_id);

alter table master_products enable row level security;
alter table master_product_candidates enable row level security;
alter table master_market_observations enable row level security;
-- These tables are intentionally service-role managed by the backend. No direct client policies are added.
