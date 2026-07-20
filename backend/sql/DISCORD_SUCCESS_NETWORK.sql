create table if not exists public.discord_success_channels (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references public.users(id) on delete cascade,
  guild_id text not null unique,
  guild_name text not null,
  source_channel_id text not null,
  source_channel_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists discord_success_channels_admin_idx on public.discord_success_channels(admin_user_id);

create table if not exists public.discord_success_master_settings (
  id text primary key default 'master',
  guild_id text not null,
  guild_name text not null,
  channel_id text not null,
  channel_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.discord_success_posts (
  id uuid primary key default gen_random_uuid(),
  discord_message_id text not null unique,
  guild_id text not null,
  guild_name text not null,
  source_channel_id text not null,
  source_channel_name text not null,
  source_admin_user_id uuid references public.users(id) on delete set null,
  author_discord_id text,
  author_name text,
  author_avatar_url text,
  message_text text,
  attachments jsonb not null default '[]'::jsonb,
  stickers jsonb not null default '[]'::jsonb,
  source_message_url text,
  forwarding_status text not null default 'received',
  forwarded_message_id text,
  forwarded_at timestamptz,
  forwarding_error text,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists discord_success_posts_posted_idx on public.discord_success_posts(posted_at desc);
create index if not exists discord_success_posts_guild_idx on public.discord_success_posts(guild_id, posted_at desc);
create index if not exists discord_success_posts_status_idx on public.discord_success_posts(forwarding_status);

-- OAuth-based admin connection used by the one-click Connect Discord flow.
create table if not exists public.discord_success_connections (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null unique references public.users(id) on delete cascade,
  discord_user_id text not null,
  discord_username text,
  manageable_guilds jsonb not null default '[]'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists discord_success_connections_discord_user_idx on public.discord_success_connections(discord_user_id);

alter table public.discord_success_channels
  add column if not exists allow_public_homepage boolean not null default false;

alter table public.discord_success_posts
  add column if not exists public_approved boolean not null default false;
