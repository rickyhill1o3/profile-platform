-- Final members-only, manual-entry raffle schema.
-- Run this single file after deploying the matching backend and frontend.

create extension if not exists pgcrypto;

create table if not exists public.storefront_raffles (
  id uuid primary key default gen_random_uuid(),
  linked_storefront_product_id uuid not null references public.storefront_products(id) on delete restrict,
  title text not null,
  description text not null default '',
  image_url text not null default '',
  fulfillment_mode text not null default 'purchase',
  audience_type text not null default 'all_members',
  audience_admin_id uuid,
  audience_label text not null default 'All active members',
  retail_price_cents integer not null default 0,
  shipping_price_cents integer not null default 0,
  market_value_low_cents integer,
  market_value_high_cents integer,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled',
  winner_claim_hours integer not null default 24,
  terms text not null default '',
  hide_linked_product boolean not null default true,
  created_by_user_id uuid references public.users(id) on delete set null,
  winner_entry_id uuid,
  winner_user_id uuid references public.users(id) on delete set null,
  drawn_at timestamptz,
  draw_started_at timestamptz,
  draw_error text,
  entries_locked_at timestamptz,
  claim_expires_at timestamptz,
  paid_at timestamptz,
  fulfilled_at timestamptz,
  stripe_checkout_session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.storefront_raffles add column if not exists fulfillment_mode text not null default 'purchase';
alter table public.storefront_raffles add column if not exists audience_type text not null default 'all_members';
alter table public.storefront_raffles add column if not exists audience_admin_id uuid;
alter table public.storefront_raffles add column if not exists audience_label text not null default 'All active members';
alter table public.storefront_raffles add column if not exists draw_started_at timestamptz;
alter table public.storefront_raffles add column if not exists draw_error text;
alter table public.storefront_raffles add column if not exists entries_locked_at timestamptz;
alter table public.storefront_raffles add column if not exists fulfilled_at timestamptz;

update public.storefront_raffles set fulfillment_mode = 'purchase' where fulfillment_mode is null or fulfillment_mode = '';
update public.storefront_raffles set audience_type = 'all_members' where audience_type is null or audience_type = '';
update public.storefront_raffles set audience_label = 'All active members' where audience_label is null or audience_label = '';

alter table public.storefront_raffles drop constraint if exists storefront_raffles_status_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_retail_price_cents_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_shipping_price_cents_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_market_value_low_cents_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_market_value_high_cents_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_winner_claim_hours_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_fulfillment_mode_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_audience_type_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_audience_group_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_free_price_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_window_check;
alter table public.storefront_raffles drop constraint if exists storefront_raffles_market_window_check;

alter table public.storefront_raffles add constraint storefront_raffles_status_check
  check (status in ('scheduled', 'live', 'closed', 'drawing', 'draw_error', 'no_eligible', 'winner_selected', 'paid', 'fulfilled', 'canceled'));
alter table public.storefront_raffles add constraint storefront_raffles_retail_price_cents_check check (retail_price_cents >= 0);
alter table public.storefront_raffles add constraint storefront_raffles_shipping_price_cents_check check (shipping_price_cents >= 0);
alter table public.storefront_raffles add constraint storefront_raffles_market_value_low_cents_check check (market_value_low_cents is null or market_value_low_cents >= 0);
alter table public.storefront_raffles add constraint storefront_raffles_market_value_high_cents_check check (market_value_high_cents is null or market_value_high_cents >= 0);
alter table public.storefront_raffles add constraint storefront_raffles_winner_claim_hours_check check (winner_claim_hours between 1 and 168);
alter table public.storefront_raffles add constraint storefront_raffles_fulfillment_mode_check check (fulfillment_mode in ('purchase', 'free'));
alter table public.storefront_raffles add constraint storefront_raffles_audience_type_check check (audience_type in ('all_members', 'admin_group'));
alter table public.storefront_raffles add constraint storefront_raffles_audience_group_check check (audience_type <> 'admin_group' or audience_admin_id is not null);
alter table public.storefront_raffles add constraint storefront_raffles_free_price_check check (fulfillment_mode <> 'free' or (retail_price_cents = 0 and shipping_price_cents = 0));
alter table public.storefront_raffles add constraint storefront_raffles_window_check check (ends_at > starts_at);
alter table public.storefront_raffles add constraint storefront_raffles_market_window_check check (market_value_high_cents is null or market_value_low_cents is null or market_value_high_cents >= market_value_low_cents);

do $$
begin
  alter table public.storefront_raffles
    add constraint storefront_raffles_audience_admin_fk
    foreign key (audience_admin_id) references public.users(id) on delete set null;
exception when duplicate_object then null;
end $$;

create table if not exists public.storefront_raffle_entries (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.storefront_raffles(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  user_email text not null,
  entered_at timestamptz not null default now(),
  is_winner boolean not null default false,
  winner_status text not null default 'entered',
  unique (raffle_id, user_id)
);

alter table public.storefront_raffle_entries drop constraint if exists storefront_raffle_entries_winner_status_check;
alter table public.storefront_raffle_entries add constraint storefront_raffle_entries_winner_status_check
  check (winner_status in ('entered', 'selected', 'expired', 'paid', 'fulfilled'));

do $$
begin
  alter table public.storefront_raffles
    add constraint storefront_raffles_winner_entry_fk
    foreign key (winner_entry_id) references public.storefront_raffle_entries(id) on delete set null;
exception when duplicate_object then null;
end $$;

create index if not exists storefront_raffles_window_idx on public.storefront_raffles (starts_at, ends_at);
create index if not exists storefront_raffles_status_idx on public.storefront_raffles (status);
create index if not exists storefront_raffles_audience_idx on public.storefront_raffles (audience_type, audience_admin_id);
create index if not exists storefront_raffles_product_idx on public.storefront_raffles (linked_storefront_product_id);
create index if not exists storefront_raffle_entries_raffle_idx on public.storefront_raffle_entries (raffle_id, entered_at);
create index if not exists storefront_raffle_entries_user_idx on public.storefront_raffle_entries (user_id, entered_at desc);

create or replace function public.guard_storefront_raffle_manual_entry()
returns trigger
language plpgsql
as $$
declare
  target public.storefront_raffles%rowtype;
begin
  select * into target
  from public.storefront_raffles
  where id = new.raffle_id
  for update;

  if not found then
    raise exception 'Raffle not found.';
  end if;
  if now() < target.starts_at then
    raise exception 'Raffle entry has not opened yet.';
  end if;
  if now() >= target.ends_at or target.entries_locked_at is not null or target.status not in ('scheduled', 'live') then
    raise exception 'Raffle entry is closed.';
  end if;
  return new;
end;
$$;

drop trigger if exists storefront_raffle_manual_entry_guard on public.storefront_raffle_entries;
create trigger storefront_raffle_manual_entry_guard
before insert on public.storefront_raffle_entries
for each row execute function public.guard_storefront_raffle_manual_entry();

comment on table public.storefront_raffles is 'Members-only raffles with manual entry and automatic deadline drawings for all members or one admin-owned group.';
comment on table public.storefront_raffle_entries is 'One deliberate member entry per raffle; only these locked entries participate in the drawing.';
