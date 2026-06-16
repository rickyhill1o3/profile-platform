# Local Chromium / Render headed-browser fix

Render does not provide a desktop/X server. If `ORDER_RECHECK_HEADLESS=false` is set on Render, Chromium cannot open a visible window and Playwright returns:

`Looks like you launched a headed browser without having a XServer running.`

This build now detects that condition and forces headless mode on Render/Linux when no display server exists.

## Render env for local Chromium test

Use these values on Render:

```bash
ORDER_RECHECK_BROWSER_MODE=local
ORDER_RECHECK_FORCE_LOCAL_CHROMIUM=true
ORDER_RECHECK_HEADLESS=true
ORDER_RECHECK_TIMEOUT_MS=60000
ORDER_RECHECK_VIDEO=false
ORDER_RECHECK_TRACE=false
```

## Build settings

```bash
Root Directory: backend
Build Command: npm install
Start Command: npm start
```

The package postinstall installs Chromium into `node_modules/playwright-core/.local-browsers`, so it is included in the Render deployment artifact.

## Important

The **Capture Target Session** button is only useful with a visible browser. Render cannot show a visible local Chromium window. To manually capture a Target session, run this backend on your Windows PC with:

```bash
ORDER_RECHECK_BROWSER_MODE=local
ORDER_RECHECK_FORCE_LOCAL_CHROMIUM=true
ORDER_RECHECK_HEADLESS=false
```

Then open your site locally and click **Capture Target Session**.
