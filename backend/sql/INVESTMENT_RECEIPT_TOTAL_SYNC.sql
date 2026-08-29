-- Investment Value: use the retailer-confirmed order total instead of webhook item price.
-- Run once after deploying the matching code. Safe to run more than once.
--
-- purchase_price on an automatically-created investment row is treated as the TOTAL
-- amount paid to the retailer for that tracked order. It includes merchandise,
-- retailer tax, shipping, and other amounts already included in tracked_orders.total.
-- Shore Shack service credits remain separate in credits_value.

begin;

-- Primary backfill: exact retailer receipt total.
update public.investment_products ip
set purchase_price = round(t.total::numeric, 2),
    order_id = t.id,
    order_number = t.order_number,
    updated_at = now()
from public.tracked_orders t
where ip.source_order_id = t.source_order_id
  and ip.user_id = t.user_id
  and t.status in ('confirmed','processing','shipped','delivered')
  and coalesce(t.total, 0) > 0
  and coalesce(ip.purchase_price, -1) is distinct from round(t.total::numeric, 2);

-- Fallback for retailers whose confirmation supplied subtotal/tax/shipping but no
-- explicit grand-total label. Only use this when tracked_orders.total is empty/zero.
update public.investment_products ip
set purchase_price = round((coalesce(t.subtotal,0) + coalesce(t.tax,0) + coalesce(t.shipping,0))::numeric, 2),
    order_id = t.id,
    order_number = t.order_number,
    updated_at = now()
from public.tracked_orders t
where ip.source_order_id = t.source_order_id
  and ip.user_id = t.user_id
  and t.status in ('confirmed','processing','shipped','delivered')
  and coalesce(t.total,0) <= 0
  and (coalesce(t.subtotal,0) + coalesce(t.tax,0) + coalesce(t.shipping,0)) > 0;

commit;
