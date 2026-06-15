# Target Order Recheck + Browserless Setup

This build adds the **Check Order For Item** button in Admin → Credits + Orders.

## What it does

1. Reads the order's raw webhook payload.
2. Finds the Target account login in this order:
   - first from webhook `Account` if it is formatted like `email:password`
   - then from the user's dashboard profile credentials
   - then from `profile_store_credentials`
   - then from `accounts`
3. Reuses a saved Target browser session when available.
4. If the saved session is expired, logs in again.
5. If Target asks for OTP, it uses the Gmail/IMAP app password saved on the profile/account.
6. Checks the Target order page for the expected SKU or item name.
7. If the expected item is missing, it refunds the charged credits.
8. Saves debug files under `/admin/order-recheck-debug/...`.

## Target login token/session reuse

The checker saves Playwright `storageState` cookies/localStorage in:

```bash
backend/order-recheck-sessions/
```

That is the login token/session cache. On the next recheck for the same Target login email, it loads that saved session first. If Target rejects it or sends the flow back to sign-in, it logs in again and refreshes the saved session.

## Browserless mode on Render

Render cannot show a visible Chrome window on your Windows desktop. Browserless gives you remote Chromium and a dashboard/live session view.

Add this environment variable in Render:

```bash
BROWSERLESS_CDP_ENDPOINT=wss://YOUR_BROWSERLESS_HOST?token=YOUR_TOKEN
```

The code also accepts these names:

```bash
BROWSERLESS_WS_ENDPOINT
PLAYWRIGHT_WS_ENDPOINT
```

Use one of them. `BROWSERLESS_CDP_ENDPOINT` is recommended.

Then redeploy.

## Render build/start commands

Root Directory:

```bash
backend
```

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

## If you do NOT use Browserless

Then Render must have Playwright Chromium installed. Use this build command instead:

```bash
npm install && npx playwright install chromium
```

If Render complains about Linux dependencies, use:

```bash
npm install && npx playwright install --with-deps chromium
```

## Local visible Chrome debugging

To actually watch Chrome open on your own computer, run the backend locally and set:

```bash
ORDER_RECHECK_HEADLESS=false
ORDER_RECHECK_SLOWMO_MS=300
```

Then click **Check Order For Item** from your local site.

## IMAP / OTP

For Gmail OTP, the account/profile needs:

- Target login email
- Target login password
- Gmail app password / IMAP password

The checker searches for these fields:

```bash
login_email
login_password
gmail_app_password
imap_password
gmail_imap_password
imap_app_password
app_password
```

Target OTP polling defaults:

```bash
ORDER_RECHECK_IMAP_HOST=imap.gmail.com
ORDER_RECHECK_IMAP_PORT=993
```

## Debug files

When an error happens, the admin alert will include links to:

- screenshots
- HTML dump
- log.txt
- Playwright trace when available
- video when using local Playwright recording

Browserless/live view is handled from the Browserless side.
