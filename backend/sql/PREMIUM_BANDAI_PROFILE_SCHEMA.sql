-- Premium Bandai profile/store support
-- Run this entire file once in Supabase SQL Editor before saving Bandai profiles.
-- It updates the existing CHECK constraints without deleting profile data.

begin;

-- profiles.account_type is the constraint currently blocking Bandai saves.
alter table public.profiles
  drop constraint if exists profiles_account_type_check;

alter table public.profiles
  add constraint profiles_account_type_check
  check (account_type in (
    'general', 'walmart', 'target', 'samsclub', 'amazon', 'bandai',
    'crunchyroll', 'pokemoncenter', 'raffle'
  ));

-- Multi-store assignment table. Only run the replacement when the table exists.
do $$
begin
  if to_regclass('public.profile_store_assignments') is not null then
    alter table public.profile_store_assignments
      drop constraint if exists profile_store_assignments_store_check;
    alter table public.profile_store_assignments
      add constraint profile_store_assignments_store_check
      check (store in (
        'general', 'walmart', 'target', 'samsclub', 'amazon', 'bandai',
        'crunchyroll', 'pokemoncenter'
      ));
  end if;
end $$;

-- Per-store credential table used by the current profile editor.
do $$
begin
  if to_regclass('public.profile_store_credentials') is not null then
    alter table public.profile_store_credentials
      drop constraint if exists profile_store_credentials_store_check;
    alter table public.profile_store_credentials
      add constraint profile_store_credentials_store_check
      check (store in (
        'general', 'walmart', 'target', 'samsclub', 'amazon', 'bandai',
        'crunchyroll', 'pokemoncenter'
      ));
  end if;
end $$;

-- Store run-status table also accepts Bandai when present.
do $$
begin
  if to_regclass('public.user_store_run_status') is not null then
    alter table public.user_store_run_status
      drop constraint if exists user_store_run_status_site_check;
    alter table public.user_store_run_status
      add constraint user_store_run_status_site_check
      check (site in (
        'target', 'walmart', 'samsclub', 'amazon', 'bandai',
        'general', 'crunchyroll', 'pokemoncenter'
      ));
  end if;
end $$;

commit;
