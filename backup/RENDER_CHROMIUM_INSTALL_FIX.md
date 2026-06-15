# Render Chromium Install Fix

This build installs Playwright Chromium **inside `backend/node_modules`** using:

```bash
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```

That matters on Render because installing to `/opt/render/.cache/ms-playwright` can disappear or not be available to the running instance.

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

Then use **Manual Deploy → Clear build cache & deploy** once.

## Confirm during deploy logs

You should see:

```text
[postinstall] installing Playwright Chromium browser into node_modules for Render...
[postinstall] local browser folder: /opt/render/project/src/backend/node_modules/playwright-core/.local-browsers
[postinstall] Playwright Chromium install complete.
```

## If your instance runs out of memory

Render Starter has 512 MB RAM. Chromium + Target login may exceed that. If the service crashes with "used over 512MB", upgrade the service or use Browserless mode.

## Browserless fallback

Set one of these Render environment variables:

```bash
BROWSERLESS_CDP_ENDPOINT=wss://...
BROWSERLESS_WS_ENDPOINT=wss://...
```

The order checker will use Browserless instead of local Chromium.
