-- Direct mailbox credentials imported from AYCD CSV exports.
-- Run once in Supabase SQL Editor. Safe to run more than once.

create table if not exists public.imported_mail_accounts (
  id uuid primary key default gen_random_uuid(),
  imported_by_user_id uuid not null references public.users(id) on delete cascade,
  email text not null,
  provider text,
  category text,
  imap_host text,
  imap_port integer not null default 993,
  imap_secure boolean not null default true,
  folders text,
  login_type text,
  auth_method text not null default 'unsupported',
  password_enc text,
  app_password_enc text,
  refresh_token_enc text,
  client_id_enc text,
  client_secret_enc text,
  mail_proxy_enc text,
  browser_proxy_enc text,
  is_enabled boolean not null default true,
  is_placeholder boolean not null default false,
  status text not null default 'ready',
  last_error text,
  last_test_at timestamptz,
  last_scan_at timestamptz,
  last_success_at timestamptz,
  last_seen_uid bigint,
  uid_validity text,
  folder_state jsonb not null default '{}'::jsonb,
  matched_profile_id uuid references public.profiles(id) on delete set null,
  matched_user_id uuid references public.users(id) on delete set null,
  match_status text not null default 'unmatched',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(imported_by_user_id,email)
);

create index if not exists imported_mail_accounts_scan_idx
  on public.imported_mail_accounts(is_enabled,is_placeholder,last_scan_at);
create index if not exists imported_mail_accounts_email_idx
  on public.imported_mail_accounts(lower(email));
create index if not exists imported_mail_accounts_match_idx
  on public.imported_mail_accounts(matched_user_id,matched_profile_id);

alter table public.imported_mail_accounts enable row level security;
drop policy if exists imported_mail_accounts_service_policy on public.imported_mail_accounts;
create policy imported_mail_accounts_service_policy on public.imported_mail_accounts
  for all using (true) with check (true);

-- Imported AYCD credentials connect directly to the real mailbox, so keep the source
-- distinct from the legacy local AYCD bridge and manually configured direct IMAP.
alter table public.email_messages
  drop constraint if exists email_messages_source_type_check;
alter table public.email_messages
  add constraint email_messages_source_type_check
  check (source_type is null or source_type in ('aycd','aycd_import','direct_imap'));

-- For deployments where the table existed before folder checkpoints were added.
alter table public.imported_mail_accounts add column if not exists folder_state jsonb not null default '{}'::jsonb;
