-- Target-only pool of super-admin-owned checkout accounts.
-- Passwords are encrypted by the Node backend before they reach this table.

create extension if not exists pgcrypto;

create table if not exists public.target_extra_account_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  opted_in boolean not null default false,
  template_profile_id uuid references public.profiles(id) on delete set null,
  desired_count integer not null default 10 check (desired_count between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.target_extra_accounts (
  id uuid primary key default gen_random_uuid(),
  login_email text not null,
  password_encrypted text not null,
  status text not null default 'available' check (status in ('available', 'disabled')),
  created_by uuid references public.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists target_extra_accounts_login_email_unique
  on public.target_extra_accounts (lower(login_email));

create table if not exists public.target_extra_account_assignments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.target_extra_accounts(id) on delete restrict,
  user_id uuid not null references public.users(id) on delete restrict,
  template_profile_id uuid not null references public.profiles(id) on delete restrict,
  cycle_id uuid not null,
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text
);

create unique index if not exists target_extra_assignments_one_active_owner
  on public.target_extra_account_assignments (account_id)
  where released_at is null;

create index if not exists target_extra_assignments_user_active_idx
  on public.target_extra_account_assignments (user_id, assigned_at desc)
  where released_at is null;

create index if not exists target_extra_assignments_history_idx
  on public.target_extra_account_assignments (account_id, assigned_at desc, released_at);

comment on table public.target_extra_account_assignments is
  'Immutable Target account ownership history. released_at preserves which website user owned an account when a webhook/order occurred.';

alter table public.target_extra_account_preferences enable row level security;
alter table public.target_extra_accounts enable row level security;
alter table public.target_extra_account_assignments enable row level security;

-- The app uses the Supabase service role on the backend. No direct browser policies
-- are intentionally created because account credentials must never be browser-readable.
