create table if not exists storefront_price_overrides (
  id uuid primary key default gen_random_uuid(),
  site text not null,
  sku text not null,
  sale_price_cents integer not null check (sale_price_cents >= 0),
  is_active boolean not null default true,
  created_by_user_id uuid null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site, sku)
);

create table if not exists storefront_products (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  title text not null,
  description text null,
  image_url text null,
  primary_site text null,
  primary_sku text null,
  source_product_url text null,
  sale_price_cents integer null check (sale_price_cents >= 0),
  pricing_source text null,
  purchase_reference_unit_cents integer null check (purchase_reference_unit_cents >= 0),
  manual_price_override_id uuid null references storefront_price_overrides(id) on delete set null,
  total_purchased_qty integer not null default 0 check (total_purchased_qty >= 0),
  total_sold_qty integer not null default 0 check (total_sold_qty >= 0),
  stock_on_hand integer not null default 0 check (stock_on_hand >= 0),
  total_purchase_cost_cents bigint not null default 0 check (total_purchase_cost_cents >= 0),
  total_sales_revenue_cents bigint not null default 0 check (total_sales_revenue_cents >= 0),
  total_tax_collected_cents bigint not null default 0 check (total_tax_collected_cents >= 0),
  total_shipping_collected_cents bigint not null default 0 check (total_shipping_collected_cents >= 0),
  total_gross_collected_cents bigint not null default 0 check (total_gross_collected_cents >= 0),
  total_allocated_cost_cents bigint not null default 0 check (total_allocated_cost_cents >= 0),
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists storefront_receipts (
  id uuid primary key default gen_random_uuid(),
  storefront_product_id uuid not null references storefront_products(id) on delete cascade,
  site text not null,
  sku text not null,
  source_order_id text null,
  source_user_id uuid null,
  quantity_purchased integer not null check (quantity_purchased > 0),
  quantity_remaining integer not null check (quantity_remaining >= 0),
  purchase_unit_price_cents integer null check (purchase_unit_price_cents >= 0),
  purchase_total_price_cents integer null check (purchase_total_price_cents >= 0),
  receipt_data jsonb not null default '{}'::jsonb,
  purchased_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists storefront_sales (
  id uuid primary key default gen_random_uuid(),
  storefront_product_id uuid not null references storefront_products(id) on delete cascade,
  stripe_session_id text not null unique,
  quantity integer not null check (quantity > 0),
  sale_unit_price_cents integer not null check (sale_unit_price_cents >= 0),
  sale_subtotal_cents integer not null check (sale_subtotal_cents >= 0),
  shipping_cents integer not null default 0 check (shipping_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  allocated_cost_cents integer not null default 0 check (allocated_cost_cents >= 0),
  customer_email text null,
  shipping_zip text null,
  shipping_state text null,
  metadata jsonb not null default '{}'::jsonb,
  sold_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_products_status_idx on storefront_products(status);
create index if not exists storefront_products_primary_source_idx on storefront_products(primary_site, primary_sku);
create index if not exists storefront_receipts_product_idx on storefront_receipts(storefront_product_id);
create index if not exists storefront_receipts_site_sku_idx on storefront_receipts(site, sku);
create index if not exists storefront_sales_product_idx on storefront_sales(storefront_product_id);
create index if not exists storefront_sales_sold_at_idx on storefront_sales(sold_at);
