create table if not exists public.aycd_bridge_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  device_name text,
  device_secret_hash text unique,
  pair_code_hash text,
  pair_expires_at timestamptz,
  is_paired boolean not null default false,
  status text not null default 'waiting',
  last_seen_at timestamptz,
  last_scan_at timestamptz,
  last_error text,
  pending_command text,
  command_id uuid,
  command_payload jsonb,
  last_result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists aycd_bridge_devices_user_idx on public.aycd_bridge_devices(user_id);
create index if not exists aycd_bridge_devices_pair_idx on public.aycd_bridge_devices(pair_code_hash);
