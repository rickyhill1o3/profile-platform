-- Explicitly mark profile store logins that should be matched through AYCD Unified Inbox.
alter table if exists public.profile_store_credentials
  add column if not exists use_aycd_inbox boolean not null default false;

create index if not exists profile_store_credentials_use_aycd_inbox_idx
  on public.profile_store_credentials (profile_id, use_aycd_inbox)
  where use_aycd_inbox = true;

comment on column public.profile_store_credentials.use_aycd_inbox is
  'When true, retailer order emails for this login address are matched from the super-admin AYCD Unified Inbox instead of requiring a direct mailbox app password.';
