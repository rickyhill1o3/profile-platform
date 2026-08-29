-- Order Tracker email timeline + multi-order shipment support.
-- Run once in Supabase SQL Editor before deploying the matching code.

begin;

alter table public.email_messages
  add column if not exists body_text text,
  add column if not exists body_html text;


-- Recover as much historical email body content as possible without forcing a full mailbox
-- rescan. Confirmation bodies already stored on tracked_orders are copied back to Email Center,
-- and older event excerpts are used when that is all the previous version retained.
update public.email_messages em
set body_html=coalesce(em.body_html,t.receipt_html),
    body_text=coalesce(em.body_text,t.receipt_text),
    updated_at=now()
from public.tracked_orders t
where em.linked_order_id=t.id
  and em.email_type='confirmed'
  and (em.body_html is null or em.body_text is null);

update public.email_messages em
set body_text=coalesce(em.body_text,e.body_excerpt),
    updated_at=now()
from public.tracked_order_events e
where em.user_id=e.user_id
  and em.message_id=e.message_id
  and em.body_text is null;

-- Repair the known Books-A-Million false-delivered classification caused by generic
-- delivery wording in confirmation emails. This is intentionally narrow: only rows
-- whose stored confirmation body explicitly says the order is still being processed
-- and that another email will be sent when it ships are changed.
update public.email_messages
set email_type='confirmed', updated_at=now()
where store='booksamillion'
  and email_type='delivered'
  and coalesce(snippet,'') ilike '%processing your order%'
  and coalesce(snippet,'') ilike '%shipped%';

update public.tracked_orders
set status='confirmed', updated_at=now()
where store='booksamillion'
  and status='delivered'
  and coalesce(receipt_text,'') ilike '%processing your order%'
  and coalesce(receipt_text,'') ilike '%shipped%';

update public.tracked_order_events
set status='confirmed'
where status='delivered'
  and coalesce(body_excerpt,'') ilike '%processing your order%'
  and coalesce(body_excerpt,'') ilike '%shipped%';

update public.orders o
set status='confirmed'
from public.tracked_orders t
where t.source_order_id=o.id
  and t.store='booksamillion'
  and t.status='confirmed'
  and coalesce(t.receipt_text,'') ilike '%processing your order%'
  and coalesce(t.receipt_text,'') ilike '%shipped%';

create table if not exists public.tracked_order_emails (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.tracked_orders(id) on delete cascade,
  email_id uuid not null references public.email_messages(id) on delete cascade,
  event_type text not null default 'unknown',
  event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id,email_id)
);

create index if not exists tracked_order_emails_order_idx
  on public.tracked_order_emails(order_id,event_at);
create index if not exists tracked_order_emails_email_idx
  on public.tracked_order_emails(email_id);
create index if not exists tracked_order_emails_type_idx
  on public.tracked_order_emails(order_id,event_type);

alter table public.tracked_order_emails enable row level security;
drop policy if exists tracked_order_emails_service_policy on public.tracked_order_emails;
create policy tracked_order_emails_service_policy
  on public.tracked_order_emails for all using (true) with check (true);

-- Backfill the legacy one-email -> one-order links. New code can add additional
-- links when one Amazon shipment/delivery message belongs to several orders.
insert into public.tracked_order_emails (order_id,email_id,event_type,event_at)
select em.linked_order_id, em.id, coalesce(em.email_type,'unknown'), em.received_at
from public.email_messages em
where em.linked_order_id is not null
on conflict (order_id,email_id) do update
set event_type=excluded.event_type,
    event_at=excluded.event_at,
    updated_at=now();

-- Backfill messages that already had an extracted retailer order number but were not linked.
insert into public.tracked_order_emails (order_id,email_id,event_type,event_at)
select t.id, em.id, coalesce(em.email_type,'unknown'), em.received_at
from public.email_messages em
join public.tracked_orders t
  on t.user_id=em.user_id
 and lower(coalesce(t.store,''))=lower(coalesce(em.store,''))
 and coalesce(t.order_number,'')<>''
 and coalesce(em.order_number,'')<>''
 and upper(regexp_replace(t.order_number,'[^A-Z0-9]','','g'))=upper(regexp_replace(em.order_number,'[^A-Z0-9]','','g'))
on conflict (order_id,email_id) do nothing;

-- Amazon may combine several separately placed orders into one shipment email. Link that one
-- message to every already-confirmed Amazon order number that is actually present in the
-- subject/snippet instead of turning the combined shipment total into one giant order.
insert into public.tracked_order_emails (order_id,email_id,event_type,event_at)
select t.id, em.id, coalesce(em.email_type,'unknown'), em.received_at
from public.email_messages em
join public.tracked_orders t
  on t.user_id=em.user_id
 and lower(coalesce(t.store,''))='amazon'
 and lower(coalesce(em.store,''))='amazon'
 and coalesce(t.order_number,'') ~ '^\d{3}-\d{7}-\d{7}$'
where (coalesce(em.subject,'') || ' ' || coalesce(em.snippet,'')) like ('%' || t.order_number || '%')
on conflict (order_id,email_id) do nothing;

-- Rebuild current tracker status from the strongest linked retailer email. Waiting rows with no
-- linked email remain waiting/yellow.
with ranked as (
  select toe.order_id,
         max(case toe.event_type
               when 'refunded' then 6
               when 'canceled' then 5
               when 'delivered' then 4
               when 'shipped' then 3
               when 'processing' then 2
               when 'confirmed' then 1
               else 0 end) as rank,
         max(toe.event_at) as last_event_at
  from public.tracked_order_emails toe
  group by toe.order_id
)
update public.tracked_orders t
set status = case ranked.rank
               when 6 then 'refunded'
               when 5 then 'canceled'
               when 4 then 'delivered'
               when 3 then 'shipped'
               when 2 then 'processing'
               when 1 then 'confirmed'
               else t.status end,
    last_status_at = greatest(coalesce(t.last_status_at,'1970-01-01'::timestamptz), coalesce(ranked.last_event_at,t.last_status_at)),
    updated_at = now()
from ranked
where ranked.order_id=t.id and ranked.rank>0;

commit;
