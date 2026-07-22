# Browserless timeout fix

This build clamps the Browserless `timeout` query parameter to `60000` even if Render has
`ORDER_RECHECK_TIMEOUT_MS=90000` or another stale value.

Recommended Render environment:

```bash
BROWSERLESS_CDP_ENDPOINT=wss://production-sfo.browserless.io?token=YOUR_BROWSERLESS_TOKEN
ORDER_RECHECK_HEADLESS=true
ORDER_RECHECK_TIMEOUT_MS=60000
ORDER_RECHECK_BROWSERLESS_TIMEOUT_MS=60000
ORDER_RECHECK_VIDEO=false
ORDER_RECHECK_TRACE=false
```

If Browserless still reports a timeout 400, delete any old environment variable named:

```bash
ORDER_RECHECK_TOTAL_TIMEOUT_MS
ORDER_RECHECK_BROWSERLESS_TIMEOUT_MS
```

then re-add `ORDER_RECHECK_BROWSERLESS_TIMEOUT_MS=60000` and redeploy.
