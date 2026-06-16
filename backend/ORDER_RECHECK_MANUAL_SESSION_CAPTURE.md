# Target Manual Session Capture

This build adds a **Capture Target Session** button under successful orders.

## What it does

- Uses the same Target account credentials as the order checker.
- Uses the order webhook proxy first.
- Opens Target orders/sign-in.
- If running locally with `ORDER_RECHECK_HEADLESS=false`, you can complete the login in the visible Chromium window.
- Once Target appears logged in, the browser storage state is saved and reused for future **Check Order For Item** runs.

## Session key safety

Sessions are keyed by:

```text
user_id + profile_id + account_id/login_email + target
```

This prevents one user/profile/account session from being reused for another profile account.

## Render/local env

For local visible testing:

```bash
ORDER_RECHECK_BROWSER_MODE=local
ORDER_RECHECK_FORCE_LOCAL_CHROMIUM=true
ORDER_RECHECK_HEADLESS=false
ORDER_RECHECK_CAPTURE_TIMEOUT_MS=600000
```

For Render headless testing:

```bash
ORDER_RECHECK_BROWSER_MODE=local
ORDER_RECHECK_FORCE_LOCAL_CHROMIUM=true
ORDER_RECHECK_HEADLESS=true
ORDER_RECHECK_CAPTURE_TIMEOUT_MS=600000
```

Manual capture is only truly interactive when running the backend somewhere with a visible desktop, such as your PC. On Render it can still create screenshots/logs, but you cannot click inside the hidden browser.

## Optional Supabase table

If you want sessions to survive Render redeploys, add:

```sql
create table if not exists public.target_login_sessions (
  session_key text primary key,
  user_id uuid,
  profile_id uuid,
  account_id text,
  login_email text,
  store text not null default 'target',
  storage_state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists target_login_sessions_lookup_idx
  on public.target_login_sessions(user_id, profile_id, login_email, store);

alter table public.target_login_sessions enable row level security;
```

The backend uses the service role/Supabase server client, so RLS policies are usually not needed for server-only access.
