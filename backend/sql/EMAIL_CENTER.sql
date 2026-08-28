create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  message_id text not null,
  imap_uid bigint,
  mailbox_email text,
  from_text text,
  to_text text,
  cc_text text,
  subject text,
  received_at timestamptz not null default now(),
  store text not null default 'unknown',
  email_type text not null default 'unknown',
  order_number text,
  tracking_number text,
  snippet text,
  linked_order_id uuid references public.tracked_orders(id) on delete set null,
  is_order_related boolean not null default false,
  keep_forever boolean not null default false,
  has_attachments boolean not null default false,
  attachment_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,message_id)
);
create index if not exists email_messages_user_received_idx on public.email_messages(user_id,received_at desc);
create index if not exists email_messages_user_type_idx on public.email_messages(user_id,email_type);
create index if not exists email_messages_user_order_idx on public.email_messages(user_id,order_number);
create index if not exists email_messages_linked_idx on public.email_messages(linked_order_id);
alter table public.email_messages enable row level security;
drop policy if exists email_messages_service_policy on public.email_messages;
create policy email_messages_service_policy on public.email_messages for all using (true) with check (true);
