const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.env.SKIP_PLAYWRIGHT_BROWSER_INSTALL === '1') {
  console.log('[postinstall] SKIP_PLAYWRIGHT_BROWSER_INSTALL=1; skipping Chromium download.');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const bin = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'playwright.cmd')
  : path.join(root, 'node_modules', '.bin', 'playwright');
const cli = path.join(root, 'node_modules', 'playwright', 'cli.js');

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env } });
}

try {
  require.resolve('playwright');
} catch (err) {
  console.warn('[postinstall] playwright package is not available; skipping Chromium install.');
  process.exit(0);
}

console.log('[postinstall] installing Playwright Chromium browser for Render...');
try {
  if (fs.existsSync(bin)) {
    run(bin, ['install', 'chromium']);
  } else if (fs.existsSync(cli)) {
    run(process.execPath, [cli, 'install', 'chromium']);
  } else {
    run('npx', ['playwright', 'install', 'chromium']);
  }
  console.log('[postinstall] Playwright Chromium install complete.');
} catch (err) {
  console.error('[postinstall] Playwright Chromium install failed.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
