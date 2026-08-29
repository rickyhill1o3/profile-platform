-- Item-level retailer reconciliation for Target filler cancellations and Supreme split shipments.
create table if not exists public.tracked_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.tracked_orders(id) on delete cascade,
  retailer_order_number text,
  product_name text not null,
  sku text,
  size text,
  style text,
  quantity integer not null default 1,
  price numeric(12,2),
  role text not null default 'normal' check (role in ('main','filler','normal')),
  status text not null default 'confirmed' check (status in ('waiting_confirmation','confirmed','processing','shipped','delivered','canceled','refunded','missing')),
  last_event_at timestamptz,
  last_email_id uuid references public.email_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tracked_order_items_order_idx on public.tracked_order_items(order_id);
create index if not exists tracked_order_items_retailer_order_idx on public.tracked_order_items(retailer_order_number);

create table if not exists public.tracked_order_shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.tracked_orders(id) on delete cascade,
  retailer_order_number text,
  tracking_number text not null,
  carrier text,
  status text not null default 'shipped' check (status in ('shipped','delivered')),
  shipped_at timestamptz,
  delivered_at timestamptz,
  last_email_id uuid references public.email_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id,tracking_number)
);
create index if not exists tracked_order_shipments_order_idx on public.tracked_order_shipments(order_id);

create table if not exists public.tracked_order_shipment_items (
  shipment_id uuid not null references public.tracked_order_shipments(id) on delete cascade,
  item_id uuid not null references public.tracked_order_items(id) on delete cascade,
  quantity integer not null default 1,
  primary key (shipment_id,item_id)
);

alter table public.tracked_order_items enable row level security;
alter table public.tracked_order_shipments enable row level security;
alter table public.tracked_order_shipment_items enable row level security;
drop policy if exists tracked_order_items_service_policy on public.tracked_order_items;
create policy tracked_order_items_service_policy on public.tracked_order_items for all using (true) with check (true);
drop policy if exists tracked_order_shipments_service_policy on public.tracked_order_shipments;
create policy tracked_order_shipments_service_policy on public.tracked_order_shipments for all using (true) with check (true);
drop policy if exists tracked_order_shipment_items_service_policy on public.tracked_order_shipment_items;
create policy tracked_order_shipment_items_service_policy on public.tracked_order_shipment_items for all using (true) with check (true);

alter table public.tracked_orders add column if not exists reconciliation_status text;
alter table public.tracked_orders add column if not exists reconciliation_score numeric(6,2);
alter table public.tracked_orders add column if not exists reconciliation_note text;
