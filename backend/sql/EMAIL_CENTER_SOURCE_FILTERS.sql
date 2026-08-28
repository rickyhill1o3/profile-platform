-- Email Center source tracking for AYCD Unified Inbox vs direct IMAP.
-- Safe to run more than once.

alter table public.email_messages
  add column if not exists source_type text;

alter table public.email_messages
  drop constraint if exists email_messages_source_type_check;

alter table public.email_messages
  add constraint email_messages_source_type_check
  check (source_type is null or source_type in ('aycd','direct_imap'));

create index if not exists email_messages_user_source_received_idx
  on public.email_messages(user_id, source_type, received_at desc);

-- Older rows did not record their ingestion source. Only rows that explicitly used
-- the AYCD unified fallback mailbox can be classified safely. Other historical rows
-- remain NULL and appear as "Legacy source" in Email Center rather than being mislabeled.
update public.email_messages
set source_type = 'aycd'
where source_type is null
  and lower(coalesce(mailbox_email,'')) = 'inbox@aycd.me';
