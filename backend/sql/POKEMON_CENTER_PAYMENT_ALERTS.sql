-- Run once in the Supabase SQL Editor before deploying the payment-alert build.
-- Safe to run again.

create table if not exists public.retailer_account_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  email_id uuid references public.email_messages(id) on delete set null,
  message_id text not null,
  dedupe_key text not null,
  store text not null,
  alert_type text not null,
  severity text not null default 'urgent',
  state text not null default 'open',
  mailbox_email text not null,
  product_hint text,
  deadline_text text,
  action_url text,
  subject text,
  received_at timestamptz not null default now(),
  body_excerpt text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, message_id),
  constraint retailer_account_alerts_state_check check (state in ('open','resolved')),
  constraint retailer_account_alerts_severity_check check (severity in ('urgent','warning','info'))
);

create index if not exists retailer_account_alerts_user_state_received_idx
  on public.retailer_account_alerts(user_id, state, received_at desc);
create index if not exists retailer_account_alerts_user_dedupe_idx
  on public.retailer_account_alerts(user_id, dedupe_key);

alter table public.retailer_account_alerts enable row level security;
drop policy if exists retailer_account_alerts_service_policy on public.retailer_account_alerts;
create policy retailer_account_alerts_service_policy
  on public.retailer_account_alerts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
