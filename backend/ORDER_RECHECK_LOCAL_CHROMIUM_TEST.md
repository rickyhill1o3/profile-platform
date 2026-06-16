# Order Recheck: Local Chromium Mode on Render

This build can ignore Browserless and launch Playwright Chromium directly on the Render instance.

## Render Environment

Add or update:

```bash
ORDER_RECHECK_BROWSER_MODE=local
ORDER_RECHECK_FORCE_LOCAL_CHROMIUM=true
ORDER_RECHECK_HEADLESS=true
ORDER_RECHECK_TIMEOUT_MS=60000
ORDER_RECHECK_VIDEO=false
ORDER_RECHECK_TRACE=false
```

You can leave `BROWSERLESS_CDP_ENDPOINT` in Render. This build ignores it when `ORDER_RECHECK_BROWSER_MODE=local`.

## Render Build

Use:

```bash
Root Directory: backend
Build Command: npm install
Start Command: npm start
```

The package postinstall downloads Chromium into `backend/node_modules/playwright-core/.local-browsers`.

## Important

Render Starter has 512 MB RAM. Local Chromium may crash or restart the service. If it does, either upgrade Render or return to Browserless with a paid plan that supports third-party proxies.

## Proxy Behavior

Local Chromium uses the proxy from the order webhook:

```text
ip:port:username:password
```

Example:

```text
46.203.173.196:36612:DZgHm83n:RqLRyRoq
```

The browser launch receives:

```js
proxy: {
  server: "http://46.203.173.196:36612",
  username: "DZgHm83n",
  password: "RqLRyRoq"
}
```

## Validation

Open an order recheck log. You should see:

```text
ORDER_RECHECK_BROWSER_MODE=local / ORDER_RECHECK_FORCE_LOCAL_CHROMIUM=true detected. Ignoring Browserless env and launching local Chromium.
Local Chromium will use order proxy: http://46.203.173.196:36612 with auth
Launching local Chromium. headless=true
```

If Target still shows `accessDenied-CheckVPN`, the proxy itself is blocked or not residential enough.
