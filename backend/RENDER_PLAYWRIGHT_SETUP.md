# Render Playwright setup

Use these Render settings:

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

If Render still restores a bad dependency cache and fails with `ENOTEMPTY`, clear the Render build cache once:

Manual Deploy → Clear build cache & deploy

This folder also includes `preinstall-clean.js`, which removes stale cached `imapflow`, `mailparser`, and Playwright folders before dependency installation.
