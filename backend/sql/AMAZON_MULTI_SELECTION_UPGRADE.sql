-- Amazon multi-product selection upgrade
-- Run once in Supabase SQL Editor before deploying this code.

alter table public.user_product_preferences
  add column if not exists quantity integer not null default 1,
  add column if not exists is_primary boolean not null default false;

alter table public.user_product_preferences
  drop constraint if exists user_product_preferences_quantity_check;

alter table public.user_product_preferences
  add constraint user_product_preferences_quantity_check
  check (quantity between 1 and 99);

create unique index if not exists user_product_preferences_one_primary_per_user_idx
  on public.user_product_preferences (user_id)
  where is_primary = true and selected = true;

-- Preserve existing Amazon selections by making the first selected Amazon item
-- the user's main item when no main item has been assigned yet.
with ranked as (
  select upp.id,
         row_number() over (partition by upp.user_id order by upp.updated_at desc nulls last, upp.id) as rn
  from public.user_product_preferences upp
  join public.catalog_products cp on cp.id = upp.catalog_product_id
  where cp.site = 'amazon'
    and upp.selected = true
    and not exists (
      select 1
      from public.user_product_preferences existing
      join public.catalog_products existing_cp on existing_cp.id = existing.catalog_product_id
      where existing.user_id = upp.user_id
        and existing_cp.site = 'amazon'
        and existing.selected = true
        and existing.is_primary = true
    )
)
update public.user_product_preferences upp
set is_primary = true
from ranked
where upp.id = ranked.id and ranked.rn = 1;
