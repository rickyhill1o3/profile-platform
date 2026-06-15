# Target Order Checker + Browserless + IMAP Setup

This build starts from the working project and adds the Target order item checker from scratch.

## What was added

- Admin button: **Check Order For Item**
- Backend route: `POST /admin/orders/:id/recheck-item`
- Browserless / remote Chromium support
- Local Chromium fallback for development
- Target login with saved profile credentials
- IMAP OTP reader using the profile's Gmail app password / IMAP password
- Session/token reuse using Playwright `storageState`
- Debug screenshots, page HTML, logs, trace ZIP, and video when available
- Auto-refund of charged credits when the expected SKU/product is missing

## Important: visible browser on Render

Render cannot open a desktop browser window that you can watch directly. To watch live, use Browserless or run the backend locally with headed Chromium.

The Render/Browserless mode records debug artifacts and returns links in the admin alert if the check fails.

## Render settings

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

Do this once after uploading:

```text
Manual Deploy -> Clear build cache & deploy
```

This folder includes a preinstall cleaner for Render's stale `node_modules` cache and a postinstall verifier for `imapflow`, `playwright`, and `ws`.

## Browserless mode

Set one of these in Render Environment Variables:

```bash
BROWSERLESS_CDP_ENDPOINT=wss://your-browserless-host?token=YOUR_TOKEN
```

or:

```bash
BROWSERLESS_WS_ENDPOINT=wss://your-browserless-host?token=YOUR_TOKEN
```

The checker will use Browserless if either env var is present. If neither is present, it falls back to local Playwright Chromium.

## Local visible browser mode

On your PC:

```bash
cd backend
npm install
npx playwright install chromium
set ORDER_RECHECK_HEADLESS=false
set ORDER_RECHECK_SLOWMO_MS=300
npm start
```

Then use the admin panel from that local backend. Chromium will open visibly on your machine.

## Login token/session reuse

The checker saves a Playwright login session per Target account here:

```text
backend/order-recheck-sessions/<email>-target.json
```

On the next check, it loads that session first. If Target still asks for sign-in or the token is expired, the checker logs in again using the saved Target email/password and IMAP OTP.

On Render, this session persists while the instance filesystem persists. It can reset after deploys/restarts. Browserless can also maintain profile persistence depending on your Browserless provider/settings.

## IMAP requirements

The profile needs Target store credentials saved:

- Target login email
- Target account password
- Gmail app password / IMAP password

The IMAP reader defaults to Gmail:

```bash
ORDER_RECHECK_IMAP_HOST=imap.gmail.com
ORDER_RECHECK_IMAP_PORT=993
```

If the account uses another mail provider, set those env vars.

## Debug files

Debug files are served under:

```text
/admin/order-recheck-debug/<run-id>/
```

When the recheck fails, the alert will include direct links to:
- screenshots
- final HTML
- log.txt
- trace-error.zip
- video `.webm` when available

Open trace files with:

```bash
npx playwright show-trace trace-error.zip
```
