-- Adjustable safety cap for the shared Target extra-account pool.
-- Safe to rerun. Existing assignments are not deleted; the saved cap is
-- enforced the next time Fill Open Spots or Start New Assignment Round runs.

create table if not exists public.target_extra_account_settings (
  setting_key text primary key check (setting_key = 'global'),
  max_assignments_per_profile integer not null default 3
    check (max_assignments_per_profile between 1 and 10),
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.target_extra_account_settings (setting_key, max_assignments_per_profile)
values ('global', 3)
on conflict (setting_key) do nothing;

alter table public.target_extra_account_settings enable row level security;

comment on table public.target_extra_account_settings is
  'Super-admin controls for the Target extra-account assignment pool.';

comment on column public.target_extra_account_settings.max_assignments_per_profile is
  'Maximum shared Target accounts that one saved Target profile may receive in an active assignment round.';
