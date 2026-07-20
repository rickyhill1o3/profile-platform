-- IMAP order tracker, receipt archive, and investment valuation
create extension if not exists pgcrypto;

create table if not exists tracked_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  source_email text not null,
  store text not null,
  order_number text not null,
  status text not null default 'confirmed' check (status in ('confirmed','processing','shipped','delivered','canceled','refunded','unknown')),
  order_date timestamptz,
  last_status_at timestamptz not null default now(),
  subtotal numeric(12,2),
  tax numeric(12,2),
  shipping numeric(12,2),
  total numeric(12,2),
  credits_spent numeric(12,2) not null default 0,
  tracking_number text,
  carrier text,
  product_summary text,
  receipt_html text,
  receipt_text text,
  raw_subject text,
  last_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, store, order_number)
);

create index if not exists tracked_orders_user_status_idx on tracked_orders(user_id, status, order_date desc);
create index if not exists tracked_orders_user_year_idx on tracked_orders(user_id, order_date desc);

create table if not exists tracked_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references tracked_orders(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null,
  event_at timestamptz not null,
  subject text,
  message_id text,
  source_email text,
  body_excerpt text,
  created_at timestamptz not null default now(),
  unique(user_id, message_id)
);

create index if not exists tracked_order_events_order_idx on tracked_order_events(order_id, event_at desc);

create table if not exists imap_scan_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  email text not null,
  provider text,
  last_scan_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_seen_uid bigint,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, email)
);

create table if not exists investment_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  order_id uuid references tracked_orders(id) on delete cascade,
  store text,
  order_number text,
  product_name text not null,
  sku text,
  quantity integer not null default 1,
  purchase_price numeric(12,2) not null default 0,
  credits_value numeric(12,2) not null default 0,
  market_price numeric(12,2),
  market_source text,
  market_updated_at timestamptz,
  tcgplayer_product_id bigint,
  tcgplayer_sku bigint,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists investment_products_user_idx on investment_products(user_id, created_at desc);
create index if not exists investment_products_tcg_idx on investment_products(tcgplayer_product_id, tcgplayer_sku);

alter table tracked_orders enable row level security;
alter table tracked_order_events enable row level security;
alter table imap_scan_accounts enable row level security;
alter table investment_products enable row level security;

-- Backend uses the Supabase service role. These policies also permit authenticated direct reads if enabled later.
do $$ begin
  create policy "tracked_orders_own" on tracked_orders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "tracked_order_events_own" on tracked_order_events for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "imap_scan_accounts_own" on imap_scan_accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "investment_products_own" on investment_products for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
