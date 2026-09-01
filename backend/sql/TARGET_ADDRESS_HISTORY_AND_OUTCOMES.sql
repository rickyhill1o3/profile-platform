-- Target address-version history + checkout outcome analytics.
-- Exact addresses remain associated with their owning user/profile. Cross-user API output is aggregate-only.

create table if not exists public.target_profile_address_versions (
    id bigint generated always as identity primary key,
    user_id uuid not null,
    profile_id uuid not null,
    address_fingerprint text not null,
    address1 text not null default '',
    address2 text not null default '',
    city text not null default '',
    state text not null default '',
    zip text not null default '',
    pattern_key text not null default '',
    pattern_label text not null default '',
    secondary_type text not null default 'none',
    secondary_location text not null default 'none',
    valid_from timestamptz not null default now(),
    valid_to timestamptz null,
    created_at timestamptz not null default now()
);

create index if not exists target_address_versions_user_profile_idx
    on public.target_profile_address_versions(user_id, profile_id, valid_from desc);
create index if not exists target_address_versions_pattern_idx
    on public.target_profile_address_versions(pattern_key);
create unique index if not exists target_address_versions_one_active_idx
    on public.target_profile_address_versions(user_id, profile_id)
    where valid_to is null;

create table if not exists public.target_profile_address_events (
    id bigint generated always as identity primary key,
    webhook_log_id text not null unique,
    user_id uuid not null,
    profile_id uuid not null,
    address_version_id bigint not null references public.target_profile_address_versions(id) on delete cascade,
    event_at timestamptz not null default now(),
    category text not null check (category in ('success','reseller','order_id','other')),
    reason text not null default '',
    order_id text not null default '',
    account_email text not null default '',
    profile_name text not null default '',
    created_at timestamptz not null default now()
);

create index if not exists target_address_events_user_profile_idx
    on public.target_profile_address_events(user_id, profile_id, event_at desc);
create index if not exists target_address_events_version_idx
    on public.target_profile_address_events(address_version_id, event_at desc);
create index if not exists target_address_events_category_idx
    on public.target_profile_address_events(category, event_at desc);

alter table public.target_profile_address_versions enable row level security;
alter table public.target_profile_address_events enable row level security;

-- The application backend uses the Supabase service-role key for these tables.
-- No browser/client policies are intentionally created, preventing direct cross-user reads.
