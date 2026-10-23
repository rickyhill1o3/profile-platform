-- Run after backend/sql/TARGET_EXTRA_ACCOUNTS.sql on an existing database.
-- Tracks which personal super-admin Target profiles are active and links paused
-- profiles to the shared extra-account pool without deleting assignment history.

alter table if exists public.target_extra_accounts
  add column if not exists source_profile_id uuid references public.profiles(id) on delete set null;

create unique index if not exists target_extra_accounts_source_profile_unique
  on public.target_extra_accounts (source_profile_id)
  where source_profile_id is not null;

create table if not exists public.target_personal_account_status (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  is_enabled boolean not null default true,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists target_personal_account_status_user_idx
  on public.target_personal_account_status (user_id, is_enabled, updated_at desc);

alter table public.target_personal_account_status enable row level security;

comment on table public.target_personal_account_status is
  'Per-profile super-admin Target run state. Disabled profiles are omitted from personal exports and their credentials are made available through the extra Target account pool.';

comment on column public.target_extra_accounts.source_profile_id is
  'Optional personal super-admin Target profile that supplied this shared login. Reactivating the profile disables this pool row and releases its current assignment.';
