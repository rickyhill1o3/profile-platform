-- Allow webhook-created orders to remain unconfirmed until a matching retailer
-- confirmation email is found by direct IMAP or the AYCD Unified Inbox.
-- Run once in the Supabase SQL Editor.

begin;

alter table public.tracked_orders
  drop constraint if exists tracked_orders_status_check;

alter table public.tracked_orders
  add constraint tracked_orders_status_check
  check (
    status in (
      'waiting_confirmation',
      'confirmed',
      'processing',
      'shipped',
      'delivered',
      'canceled',
      'refunded',
      'unknown'
    )
  );

commit;
