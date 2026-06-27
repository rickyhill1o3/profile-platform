-- Webhook database upgrade for The Shore Shack profile-platform.
-- Run this in Supabase SQL Editor before deploying the updated folder.

create table if not exists public.webhook_events (
  id text primary key,
  created_at timestamptz not null default now(),
  type text not null default 'unknown',
  status text not null default 'received',
  site text,
  bot text,
  product_type text,
  product text,
  sku text,
  error text,
  payload jsonb,
  parsed_items jsonb not null default '[]'::jsonb,
  discord_targets jsonb not null default '[]'::jsonb,
  fingerprint text
);

create index if not exists webhook_events_created_at_idx on public.webhook_events (created_at desc);
create index if not exists webhook_events_type_idx on public.webhook_events (type);
create index if not exists webhook_events_site_idx on public.webhook_events (site);
create index if not exists webhook_events_bot_idx on public.webhook_events (bot);
create index if not exists webhook_events_sku_idx on public.webhook_events (sku);
create index if not exists webhook_events_fingerprint_idx on public.webhook_events (fingerprint);

create table if not exists public.webhook_parser_rules (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  bot text not null default '',
  site text not null default '',
  event_type text not null default 'checkout',
  label text not null default '',
  admin_fields jsonb not null default '[]'::jsonb,
  super_admin_fields jsonb not null default '[]'::jsonb,
  sample_payload jsonb,
  is_active boolean not null default true
);

create index if not exists webhook_parser_rules_lookup_idx on public.webhook_parser_rules (bot, site, event_type, is_active);
