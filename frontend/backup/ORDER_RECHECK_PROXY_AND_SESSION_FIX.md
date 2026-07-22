# Order Recheck Proxy + Target Session Fix

This build forces the recheck browser to use the proxy from the successful checkout webhook/order.

## Render Environment

Use Browserless/remote Chromium:

```bash
BROWSERLESS_CDP_ENDPOINT=wss://production-sfo.browserless.io?token=YOUR_BROWSERLESS_TOKEN
ORDER_RECHECK_HEADLESS=true
ORDER_RECHECK_BROWSERLESS_STEALTH=true
ORDER_RECHECK_BROWSERLESS_HUMANLIKE=true
ORDER_RECHECK_TOTAL_TIMEOUT_MS=120000
ORDER_RECHECK_RECORD_VIDEO=false
ORDER_RECHECK_TRACE=false
```

The checker now reads the order proxy, for example:

```text
46.203.173.196:36612:DZgHm83n:RqLRyRoq
```

and launches Browserless with:

```text
--proxy-server=http://46.203.173.196:36612
```

It also attaches a proxy-auth handler for the username/password.

## Important Browserless note

Browserless supports launch options through the `launch` query parameter. This build uses that method to pass Chrome flags, including `--proxy-server`.

Authenticated proxies are harder over CDP than local Playwright. This build also attaches a CDP auth handler, but some proxy providers still may not accept auth through a remote Browserless connection. If Target still shows `accessDenied-CheckVPN`, the cleanest solution is one of these:

1. Use IP-authenticated proxies with Browserless.
2. Whitelist Browserless IPs in your proxy provider dashboard, if your proxy provider supports IP allowlisting.
3. Use Browserless/Steel/Browserbase provider-level proxy support.
4. Run the checker locally or on a VPS with local Playwright proxy support.

## Target login session reuse

This build stores Target login sessions by:

```text
user_id + profile_id + account_id/login_email + target
```

That prevents user 1 / account 2 from overwriting user 1 / account 1 when profile/account ids are available.

It saves session state locally by default. For persistence across Render redeploys, add this optional Supabase table:

```sql
create table if not exists target_login_sessions (
  session_key text primary key,
  user_id uuid null,
  profile_id text null,
  account_id text null,
  login_email text null,
  store text not null default 'target',
  storage_state jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists target_login_sessions_user_idx on target_login_sessions(user_id);
create index if not exists target_login_sessions_profile_idx on target_login_sessions(profile_id);
create index if not exists target_login_sessions_email_idx on target_login_sessions(login_email);
```

If the table does not exist, the app still works using local session files, but sessions may disappear on redeploy.

## Quantity behavior

Quantity mismatch does not trigger refund. Refund only happens when the expected item/SKU/name is missing entirely.
