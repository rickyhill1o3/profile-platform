const { execFileSync } = require('child_process');

if (process.env.SKIP_PLAYWRIGHT_BROWSER_INSTALL === '1') {
  console.log('[postinstall] SKIP_PLAYWRIGHT_BROWSER_INSTALL=1; skipping Chromium download.');
  process.exit(0);
}

try {
  require.resolve('playwright');
} catch (err) {
  console.warn('[postinstall] playwright package is not available; skipping Chromium install.');
  process.exit(0);
}

console.log('[postinstall] installing Playwright Chromium browser for Render...');
try {
  execFileSync(process.execPath, [require.resolve('playwright/cli'), 'install', 'chromium'], {
    stdio: 'inherit',
    env: { ...process.env }
  });
  console.log('[postinstall] Playwright Chromium install complete.');
} catch (err) {
  console.error('[postinstall] Playwright Chromium install failed.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
