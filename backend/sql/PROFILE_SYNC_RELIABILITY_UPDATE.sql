-- Makes profile synchronization status resilient to missed application events.
-- Safe to run more than once.

alter table if exists public.profile_sync_status
    add column if not exists acknowledged_profile_count integer,
    add column if not exists acknowledged_run_enabled boolean;

create index if not exists profile_sync_status_user_site_idx
    on public.profile_sync_status (user_id, site);
