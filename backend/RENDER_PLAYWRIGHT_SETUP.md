# Render Playwright setup

This build removes the `postinstall` hook that was causing Render/npm to fail with `Exit handler never called`.

Use this Render setup:

- Root Directory: `backend`
- Build Command: `npm install && npm run render-build`
- Start Command: `npm start`

The start command also runs `ensure-playwright.js`, so if Chromium is missing it will try to install it before starting the server.

If Render still has trouble installing local Chromium, use Browserless instead and set one of these environment variables:

```
BROWSERLESS_WS_ENDPOINT=wss://...
# or
BROWSERLESS_URL=wss://...
```

If you need to skip the local Chromium install because you are using Browserless, set:

```
SKIP_PLAYWRIGHT_INSTALL=1
```

Recommended Node version is pinned in `package.json` to Node 20.x because the Render log showed an npm internal failure on Node 22 while running install scripts.
