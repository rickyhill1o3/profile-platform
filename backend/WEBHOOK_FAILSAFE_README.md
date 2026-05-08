# Webhook fail-safe queue

This build adds a local file-based webhook fail-safe queue for Supabase outages.

## What it does

- If Supabase is unavailable when a checkout or monitor webhook is received, the server returns `204` so the sender does not keep retrying.
- The raw webhook payload is saved under `backend/webhook_failover_queue/` as a JSON file.
- A background worker checks Supabase every 60 seconds.
- When Supabase is back online, queued webhook files are replayed automatically through the normal webhook routes.
- The queue file is deleted only after replay is accepted.

## Database outage alerts

Outage/recovery alerts no longer require a separate environment variable.

The server now sends database outage and recovery alerts to existing checkout webhook routes:

- all active super admin checkout routes
- all active admin checkout routes
- each account's `checkout_error` webhook is preferred
- if an account does not have `checkout_error`, `checkout_success` is used as a fallback

Because Supabase cannot be queried during an outage, the server keeps a local cache of checkout alert webhook targets at:

`backend/webhook_failover_queue/database_outage_checkout_webhooks.json`

That cache is refreshed while Supabase is healthy. If the database goes down, the cached checkout webhook routes are used to send outage alerts.

## Recommended Render setting

For best reliability, add a Render persistent disk and make sure `backend/webhook_failover_queue/` is on persistent storage. Without a persistent disk, queue files can be lost on a redeploy/restart.

## Health check endpoint

`GET /api/health/database`

Returns whether Supabase is online and how many webhooks are queued.
