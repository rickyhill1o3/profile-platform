# Render Node 20 Supabase WebSocket Fix

Render is running Node 20. Supabase's realtime client requires a WebSocket implementation on Node versions below 22.

This build adds the `ws` package and passes it to Supabase in `database.js`:

```js
const WebSocket = require("ws");

const supabase = createClient(url, key, {
  realtime: { transport: WebSocket }
});
```

Render settings:

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

The Playwright Chromium installer remains in `postinstall`, and the stale `imapflow` cache cleanup remains in `preinstall`.
