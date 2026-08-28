create table if not exists public.email_center_hidden_mailboxes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mailbox_email text not null,
  is_hidden boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, mailbox_email)
);
create index if not exists email_center_hidden_mailboxes_user_idx on public.email_center_hidden_mailboxes(user_id);
alter table public.email_center_hidden_mailboxes enable row level security;
drop policy if exists email_center_hidden_mailboxes_service_policy on public.email_center_hidden_mailboxes;
create policy email_center_hidden_mailboxes_service_policy on public.email_center_hidden_mailboxes for all using (true) with check (true);
