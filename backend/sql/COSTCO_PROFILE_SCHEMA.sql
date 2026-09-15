-- Costco profile/store support
-- Run this entire file once in Supabase SQL Editor before saving Costco profiles.
-- Existing profile, credential, and run-status rows are preserved.

begin;

alter table public.profiles
  drop constraint if exists profiles_account_type_check;

alter table public.profiles
  add constraint profiles_account_type_check
  check (account_type in (
    'general', 'walmart', 'target', 'samsclub', 'costco', 'amazon', 'bandai',
    'crunchyroll', 'pokemoncenter', 'raffle'
  ));

do $$
begin
  if to_regclass('public.profile_store_assignments') is not null then
    alter table public.profile_store_assignments
      drop constraint if exists profile_store_assignments_store_check;
    alter table public.profile_store_assignments
      add constraint profile_store_assignments_store_check
      check (store in (
        'general', 'walmart', 'target', 'samsclub', 'costco', 'amazon', 'bandai',
        'crunchyroll', 'pokemoncenter'
      ));
  end if;
end $$;

do $$
begin
  if to_regclass('public.profile_store_credentials') is not null then
    alter table public.profile_store_credentials
      drop constraint if exists profile_store_credentials_store_check;
    alter table public.profile_store_credentials
      add constraint profile_store_credentials_store_check
      check (store in (
        'general', 'walmart', 'target', 'samsclub', 'costco', 'amazon', 'bandai',
        'crunchyroll', 'pokemoncenter'
      ));
  end if;
end $$;

do $$
begin
  if to_regclass('public.user_store_run_status') is not null then
    alter table public.user_store_run_status
      drop constraint if exists user_store_run_status_site_check;
    alter table public.user_store_run_status
      add constraint user_store_run_status_site_check
      check (site in (
        'target', 'walmart', 'samsclub', 'costco', 'amazon', 'bandai',
        'general', 'crunchyroll', 'pokemoncenter'
      ));
  end if;
end $$;

commit;
