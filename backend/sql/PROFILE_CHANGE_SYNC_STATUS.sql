create table if not exists public.profile_sync_status (
  user_id uuid not null references public.users(id) on delete cascade,
  site text not null,
  changed_at timestamptz,
  acknowledged_at timestamptz,
  change_reason text,
  updated_at timestamptz not null default now(),
  primary key (user_id, site)
);

create index if not exists profile_sync_status_changed_idx
  on public.profile_sync_status (changed_at desc);

comment on table public.profile_sync_status is
  'Tracks whether a user changed profiles after an admin last updated the bot profile exports.';
