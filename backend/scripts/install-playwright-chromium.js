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

// CRITICAL FOR RENDER:
// Put Playwright browsers inside node_modules so they are included in Render's build artifact.
// Installing to /opt/render/.cache can disappear between build/runtime or between instances.
const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: '0'
};

function run(cmd, args) {
  console.log('[postinstall] running:', cmd, args.join(' '));
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, env });
}

try {
  require.resolve('playwright');
} catch (err) {
  console.error('[postinstall] playwright package is not available. npm install did not finish correctly.');
  process.exit(1);
}

console.log('[postinstall] installing Playwright Chromium browser into node_modules for Render...');
try {
  if (fs.existsSync(bin)) {
    run(bin, ['install', 'chromium']);
  } else {
    run('npx', ['playwright', 'install', 'chromium']);
  }

  const localBrowsers = path.join(root, 'node_modules', 'playwright-core', '.local-browsers');
  if (fs.existsSync(localBrowsers)) {
    console.log('[postinstall] local browser folder:', localBrowsers);
    console.log('[postinstall] installed:', fs.readdirSync(localBrowsers).join(', '));
  } else {
    console.warn('[postinstall] browser install finished, but .local-browsers was not found at:', localBrowsers);
  }

  console.log('[postinstall] Playwright Chromium install complete.');
} catch (err) {
  console.error('[postinstall] Playwright Chromium install failed.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
