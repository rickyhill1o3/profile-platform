const { chromium } = require('playwright');
const { spawnSync } = require('child_process');

function hasChromium() {
  try {
    const path = chromium.executablePath();
    return !!path && require('fs').existsSync(path);
  } catch (err) {
    return false;
  }
}

if (process.env.SKIP_PLAYWRIGHT_INSTALL === '1') {
  console.log('[playwright] SKIP_PLAYWRIGHT_INSTALL=1, skipping browser check.');
  process.exit(0);
}

if (process.env.BROWSERLESS_WS_ENDPOINT || process.env.BROWSERLESS_URL) {
  console.log('[playwright] Remote Browserless endpoint configured; local Chromium install is optional.');
  process.exit(0);
}

if (hasChromium()) {
  console.log('[playwright] Chromium already installed.');
  process.exit(0);
}

console.log('[playwright] Chromium is missing. Installing now...');
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], {
  stdio: 'inherit',
  shell: false,
});

if (result.status !== 0) {
  console.error('[playwright] Chromium install failed.');
  console.error('[playwright] On Render, set Build Command to: npm install && npm run render-build');
  console.error('[playwright] If Linux dependencies are missing, use: npx playwright install --with-deps chromium');
  process.exit(result.status || 1);
}

console.log('[playwright] Chromium installed successfully.');
