-- Queue-it raffle/queue pass round-robin routing.
-- Run once in the Supabase SQL Editor before deploying this release.

create table if not exists public.queue_pass_routing_state (
  id boolean primary key default true check (id = true),
  cycle_index bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.queue_pass_routing_state (id, cycle_index)
values (true, 0)
on conflict (id) do nothing;

create table if not exists public.queue_pass_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  route_id uuid,
  destination_scope text not null,
  destination_user_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists queue_pass_deliveries_created_at_idx
  on public.queue_pass_deliveries (created_at desc);

create or replace function public.claim_queue_pass_destination(
  p_event_key text,
  p_reserved_count integer default 2
)
returns table (
  route_id uuid,
  destination_scope text,
  destination_user_id uuid,
  webhook_url text,
  brand_label text,
  reused boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_delivery public.queue_pass_deliveries%rowtype;
  selected_route public.discord_webhook_routes%rowtype;
  reserved_used integer;
  candidate_count integer;
  current_index bigint;
  selected_position integer;
begin
  perform pg_advisory_xact_lock(hashtext('queue_pass_round_robin'));

  select qpd.* into existing_delivery
  from public.queue_pass_deliveries qpd
  where qpd.event_key = p_event_key;

  if found then
    select dwr.* into selected_route
    from public.discord_webhook_routes dwr
    where dwr.id = existing_delivery.route_id;
    return query select selected_route.id, existing_delivery.destination_scope,
      existing_delivery.destination_user_id, selected_route.webhook_url,
      coalesce((select value_json->>'brand_label' from public.app_settings aps where aps.key = 'admin_webhook_settings:' || existing_delivery.destination_user_id::text limit 1), ''),
      true;
    return;
  end if;

  select count(*)::integer into reserved_used
  from public.queue_pass_deliveries qpd
  where qpd.created_at >= now() - interval '24 hours'
    and qpd.destination_scope = 'super_admin_reserved';

  if reserved_used < greatest(0, p_reserved_count) then
    select * into selected_route
    from public.discord_webhook_routes dwr
    where dwr.scope = 'super_admin'
      and dwr.webhook_type = 'checkout_success'
      and dwr.category = 'all'
      and dwr.is_active = true
      and nullif(trim(dwr.webhook_url), '') is not null
    order by dwr.created_at, dwr.id
    limit 1;

    if selected_route.id is null then
      raise exception 'Private super-admin checkout webhook is not configured';
    end if;

    insert into public.queue_pass_deliveries(event_key, route_id, destination_scope, destination_user_id)
    values (p_event_key, selected_route.id, 'super_admin_reserved', null);

    return query select selected_route.id, 'super_admin_reserved'::text, null::uuid,
      selected_route.webhook_url, ''::text, false;
    return;
  end if;

  -- Rotation candidates: your public/user checkout group first, then all active admin checkout groups.
  with candidates as (
    select r.id, r.scope, r.user_id, r.webhook_url, r.created_at,
           row_number() over (order by case when r.scope = 'super_admin_public' then 0 else 1 end, r.created_at, r.id) - 1 as pos
    from public.discord_webhook_routes r
    where r.webhook_type = 'checkout_success'
      and r.category = 'all'
      and r.is_active = true
      and nullif(trim(r.webhook_url), '') is not null
      and (r.scope = 'super_admin_public' or r.scope = 'admin')
  )
  select count(*)::integer into candidate_count from candidates;

  if candidate_count = 0 then
    raise exception 'No public/user or admin checkout webhooks are configured for queue-pass rotation';
  end if;

  select qprs.cycle_index into current_index
  from public.queue_pass_routing_state qprs
  where qprs.id = true
  for update;

  selected_position := mod(current_index, candidate_count);

  with candidates as (
    select r.*,
           row_number() over (order by case when r.scope = 'super_admin_public' then 0 else 1 end, r.created_at, r.id) - 1 as pos
    from public.discord_webhook_routes r
    where r.webhook_type = 'checkout_success'
      and r.category = 'all'
      and r.is_active = true
      and nullif(trim(r.webhook_url), '') is not null
      and (r.scope = 'super_admin_public' or r.scope = 'admin')
  )
  select id, created_at, updated_at, scope, user_id, webhook_type, category, webhook_url,
         ping_mode, role_mention, is_active
  into selected_route
  from candidates
  where pos = selected_position
  limit 1;

  update public.queue_pass_routing_state qprs
  set cycle_index = current_index + 1, updated_at = now()
  where qprs.id = true;

  insert into public.queue_pass_deliveries(event_key, route_id, destination_scope, destination_user_id)
  values (
    p_event_key,
    selected_route.id,
    case when selected_route.scope = 'super_admin_public' then 'super_admin_public' else 'admin' end,
    case when selected_route.scope = 'admin' then selected_route.user_id else null end
  );

  return query select selected_route.id,
    case when selected_route.scope = 'super_admin_public' then 'super_admin_public' else 'admin' end,
    case when selected_route.scope = 'admin' then selected_route.user_id else null end,
    selected_route.webhook_url,
    coalesce((select value_json->>'brand_label' from public.app_settings aps where aps.key = 'admin_webhook_settings:' || selected_route.user_id::text limit 1), ''),
    false;
end;
$$;

revoke all on function public.claim_queue_pass_destination(text, integer) from public;
grant execute on function public.claim_queue_pass_destination(text, integer) to service_role;
