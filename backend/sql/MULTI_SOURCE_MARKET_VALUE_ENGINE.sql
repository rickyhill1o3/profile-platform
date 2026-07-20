-- Multi-source market value engine, portfolio history, and price alerts
create extension if not exists pgcrypto;

alter table investment_products add column if not exists category text;
alter table investment_products add column if not exists upc text;
alter table investment_products add column if not exists condition text default 'sealed';
alter table investment_products add column if not exists selected_market_source text default 'automatic';
alter table investment_products add column if not exists price_match_status text default 'unmatched';
alter table investment_products add column if not exists source_product_urls jsonb not null default '{}'::jsonb;

create table if not exists market_price_observations (
  id uuid primary key default gen_random_uuid(),
  investment_product_id uuid not null references investment_products(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  source text not null,
  title text,
  price numeric(12,2) not null,
  currency text not null default 'USD',
  confidence numeric(5,4) not null default .7000,
  listing_url text,
  image_url text,
  observed_at timestamptz not null default now(),
  fingerprint text not null unique,
  raw_data jsonb
);
create index if not exists market_price_obs_product_idx on market_price_observations(investment_product_id, observed_at desc);
create index if not exists market_price_obs_user_idx on market_price_observations(user_id, observed_at desc);

create table if not exists portfolio_value_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  snapshot_date date not null,
  purchase_value numeric(14,2) not null default 0,
  credits_value numeric(14,2) not null default 0,
  market_value numeric(14,2) not null default 0,
  gain_value numeric(14,2) not null default 0,
  item_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique(user_id,snapshot_date)
);

create table if not exists market_value_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  investment_product_id uuid not null references investment_products(id) on delete cascade,
  direction text not null check(direction in ('above','below')),
  target_price numeric(12,2) not null,
  is_active boolean not null default true,
  triggered_at timestamptz,
  last_trigger_price numeric(12,2),
  created_at timestamptz not null default now()
);

alter table market_price_observations enable row level security;
alter table portfolio_value_snapshots enable row level security;
alter table market_value_alerts enable row level security;
do $$ begin create policy "market_price_observations_own" on market_price_observations for all using(auth.uid()=user_id) with check(auth.uid()=user_id); exception when duplicate_object then null; end $$;
do $$ begin create policy "portfolio_value_snapshots_own" on portfolio_value_snapshots for all using(auth.uid()=user_id) with check(auth.uid()=user_id); exception when duplicate_object then null; end $$;
do $$ begin create policy "market_value_alerts_own" on market_value_alerts for all using(auth.uid()=user_id) with check(auth.uid()=user_id); exception when duplicate_object then null; end $$;
