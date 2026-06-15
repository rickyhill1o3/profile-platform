# Render Playwright setup

This build uses the full `playwright` package, not `playwright-core`, so `npx playwright install chromium` works correctly.

Render settings:

Root Directory:
```bash
backend
```

Build Command:
```bash
npm install && npm run render-build
```

Start Command:
```bash
npm start
```

If Chromium launches but complains about missing Linux packages, change Build Command to:

```bash
npm install && npm run render-build-deps
```

Live viewing note: Render cannot display a headed Chrome window in your local desktop. For local live viewing, run the backend on your PC with:

```bash
ORDER_RECHECK_HEADLESS=false npm start
```

For Render debugging, use the debug screenshots/video/trace that the Recheck Order flow saves.
