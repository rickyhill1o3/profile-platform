-- Queue-pass routing hotfix v2.
-- Run this AFTER the original QUEUE_PASS_ROUND_ROBIN_ROUTING.sql migration.
-- Fixes ambiguous destination_scope/webhook_url references and records a readable destination name.

alter table public.queue_pass_deliveries
  add column if not exists destination_name text;

drop function if exists public.claim_queue_pass_destination(text, integer);

create function public.claim_queue_pass_destination(
  p_event_key text,
  p_reserved_count integer default 2
)
returns table (
  route_id uuid,
  destination_scope text,
  destination_user_id uuid,
  webhook_url text,
  brand_label text,
  destination_name text,
  reused boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.queue_pass_deliveries%rowtype;
  v_route_id uuid;
  v_scope text;
  v_user_id uuid;
  v_webhook_url text;
  v_brand_label text;
  v_destination_name text;
  v_reserved_used integer;
  v_candidate_count integer;
  v_current_index bigint;
  v_selected_position integer;
begin
  perform pg_advisory_xact_lock(hashtext('queue_pass_round_robin'));

  select qpd.*
    into v_existing
  from public.queue_pass_deliveries as qpd
  where qpd.event_key = p_event_key
  limit 1;

  if found then
    select
      dwr.id,
      dwr.scope,
      dwr.user_id,
      dwr.webhook_url,
      coalesce(nullif(trim(aps.value_json->>'brand_label'), ''), ''),
      coalesce(
        nullif(trim(v_existing.destination_name), ''),
        case
          when v_existing.destination_scope = 'super_admin_reserved' then 'theshoreshacktcg super admin'
          when v_existing.destination_scope = 'super_admin_public' then 'theshoreshacktcg public'
          else coalesce(nullif(trim(u.discord_username), ''), nullif(trim(u.discord_display_name), ''), nullif(trim(aps.value_json->>'brand_label'), ''), 'Admin group')
        end
      )
    into v_route_id, v_scope, v_user_id, v_webhook_url, v_brand_label, v_destination_name
    from public.discord_webhook_routes as dwr
    left join public.users as u on u.id = dwr.user_id
    left join public.app_settings as aps
      on aps.key = 'admin_webhook_settings:' || dwr.user_id::text
    where dwr.id = v_existing.route_id
    limit 1;

    return query
    select
      v_route_id,
      v_existing.destination_scope,
      v_existing.destination_user_id,
      v_webhook_url,
      v_brand_label,
      v_destination_name,
      true;
    return;
  end if;

  select count(*)::integer
    into v_reserved_used
  from public.queue_pass_deliveries as qpd
  where qpd.created_at >= now() - interval '24 hours'
    and qpd.destination_scope = 'super_admin_reserved';

  if v_reserved_used < greatest(0, p_reserved_count) then
    select
      dwr.id,
      dwr.scope,
      dwr.user_id,
      dwr.webhook_url,
      ''::text,
      'theshoreshacktcg super admin'::text
    into v_route_id, v_scope, v_user_id, v_webhook_url, v_brand_label, v_destination_name
    from public.discord_webhook_routes as dwr
    where dwr.scope = 'super_admin'
      and dwr.webhook_type = 'checkout_success'
      and dwr.category = 'all'
      and dwr.is_active = true
      and nullif(trim(dwr.webhook_url), '') is not null
    order by dwr.created_at, dwr.id
    limit 1;

    if v_route_id is null then
      raise exception 'Private super-admin checkout webhook is not configured';
    end if;

    insert into public.queue_pass_deliveries
      (event_key, route_id, destination_scope, destination_user_id, destination_name)
    values
      (p_event_key, v_route_id, 'super_admin_reserved', null, v_destination_name);

    return query
    select v_route_id, 'super_admin_reserved'::text, null::uuid,
           v_webhook_url, v_brand_label, v_destination_name, false;
    return;
  end if;

  -- Active admin checkout webhooks are first; the public Shore Shack webhook is last.
  -- Example with Apex only: Apex -> Shore Shack public -> Apex -> Shore Shack public.
  -- Example with Apex + Guppie: Apex -> Guppie -> Shore Shack public -> repeat.
  with candidates as (
    select
      dwr.id,
      dwr.scope,
      dwr.user_id,
      dwr.webhook_url,
      dwr.created_at,
      coalesce(nullif(trim(aps.value_json->>'brand_label'), ''), '') as candidate_brand,
      case
        when dwr.scope = 'super_admin_public' then 'theshoreshacktcg public'
        else coalesce(nullif(trim(u.discord_username), ''), nullif(trim(u.discord_display_name), ''), nullif(trim(aps.value_json->>'brand_label'), ''), 'Admin group')
      end as candidate_name,
      row_number() over (
        order by
          case when dwr.scope = 'admin' then 0 else 1 end,
          dwr.created_at,
          dwr.id
      ) - 1 as candidate_position
    from public.discord_webhook_routes as dwr
    left join public.users as u on u.id = dwr.user_id
    left join public.app_settings as aps
      on aps.key = 'admin_webhook_settings:' || dwr.user_id::text
    where dwr.webhook_type = 'checkout_success'
      and dwr.category = 'all'
      and dwr.is_active = true
      and nullif(trim(dwr.webhook_url), '') is not null
      and dwr.scope in ('admin', 'super_admin_public')
  )
  select count(*)::integer into v_candidate_count from candidates;

  if v_candidate_count = 0 then
    raise exception 'No active admin or public checkout webhooks are configured for queue-pass rotation';
  end if;

  select qprs.cycle_index
    into v_current_index
  from public.queue_pass_routing_state as qprs
  where qprs.id = true
  for update;

  v_selected_position := mod(v_current_index, v_candidate_count);

  with candidates as (
    select
      dwr.id,
      dwr.scope,
      dwr.user_id,
      dwr.webhook_url,
      dwr.created_at,
      coalesce(nullif(trim(aps.value_json->>'brand_label'), ''), '') as candidate_brand,
      case
        when dwr.scope = 'super_admin_public' then 'theshoreshacktcg public'
        else coalesce(nullif(trim(u.discord_username), ''), nullif(trim(u.discord_display_name), ''), nullif(trim(aps.value_json->>'brand_label'), ''), 'Admin group')
      end as candidate_name,
      row_number() over (
        order by
          case when dwr.scope = 'admin' then 0 else 1 end,
          dwr.created_at,
          dwr.id
      ) - 1 as candidate_position
    from public.discord_webhook_routes as dwr
    left join public.users as u on u.id = dwr.user_id
    left join public.app_settings as aps
      on aps.key = 'admin_webhook_settings:' || dwr.user_id::text
    where dwr.webhook_type = 'checkout_success'
      and dwr.category = 'all'
      and dwr.is_active = true
      and nullif(trim(dwr.webhook_url), '') is not null
      and dwr.scope in ('admin', 'super_admin_public')
  )
  select
    c.id,
    c.scope,
    c.user_id,
    c.webhook_url,
    c.candidate_brand,
    c.candidate_name
  into v_route_id, v_scope, v_user_id, v_webhook_url, v_brand_label, v_destination_name
  from candidates as c
  where c.candidate_position = v_selected_position
  limit 1;

  update public.queue_pass_routing_state as qprs
  set cycle_index = v_current_index + 1,
      updated_at = now()
  where qprs.id = true;

  insert into public.queue_pass_deliveries
    (event_key, route_id, destination_scope, destination_user_id, destination_name)
  values (
    p_event_key,
    v_route_id,
    case when v_scope = 'super_admin_public' then 'super_admin_public' else 'admin' end,
    case when v_scope = 'admin' then v_user_id else null end,
    v_destination_name
  );

  return query
  select
    v_route_id,
    case when v_scope = 'super_admin_public' then 'super_admin_public' else 'admin' end,
    case when v_scope = 'admin' then v_user_id else null end,
    v_webhook_url,
    v_brand_label,
    v_destination_name,
    false;
end;
$$;

revoke all on function public.claim_queue_pass_destination(text, integer) from public;
grant execute on function public.claim_queue_pass_destination(text, integer) to service_role;

-- Optional: reset the round-robin to start with the first active admin after this hotfix.
update public.queue_pass_routing_state
set cycle_index = 0,
    updated_at = now()
where id = true;
