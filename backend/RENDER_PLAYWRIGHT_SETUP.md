# Render Playwright setup

This build removes the Playwright browser download from `npm install` so Render can get past dependency installation.

Render settings:

Root Directory:
```
backend
```

Build Command:
```
npm install
```

Start Command:
```
npm start
```

For local Chromium on Render, use this only after `npm install` is passing:
```
npm install && npm run render-build
```

If the Chromium install fails on Render Starter, use Browserless instead and set one of these environment variables:

```
BROWSERLESS_WS_ENDPOINT=wss://...
```

or

```
BROWSERLESS_URL=wss://...
```

The app now uses `playwright-core`, so `npm install` will not download browsers automatically.
