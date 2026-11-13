'use strict';

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.env.SKIP_PLAYWRIGHT_BROWSER_INSTALL === '1') {
  console.log('[chromium-check] SKIP_PLAYWRIGHT_BROWSER_INSTALL=1; skipping Chromium download.');
  process.exit(0);
}

const backendRoot = path.join(__dirname, '..');
const playwrightBin = process.platform === 'win32'
  ? path.join(backendRoot, 'node_modules', '.bin', 'playwright.cmd')
  : path.join(backendRoot, 'node_modules', '.bin', 'playwright');
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' };

try {
  require.resolve('playwright');
} catch (_) {
  console.error('[chromium-check] playwright was not installed.');
  process.exit(1);
}

try {
  const { chromium } = require('playwright');
  const expectedExecutable = chromium.executablePath();
  if (fs.existsSync(expectedExecutable)) {
    console.log('[chromium-check] local Chromium is ready:', expectedExecutable);
    process.exit(0);
  }

  console.log('[chromium-check] installing local Chromium for Target retail-price scans...');
  if (fs.existsSync(playwrightBin)) {
    execFileSync(playwrightBin, ['install', 'chromium'], { cwd: backendRoot, env, stdio: 'inherit' });
  } else {
    execFileSync('npx', ['playwright', 'install', 'chromium'], { cwd: backendRoot, env, stdio: 'inherit' });
  }

  if (!fs.existsSync(expectedExecutable)) {
    throw new Error(`Chromium install completed but its executable was not found at ${expectedExecutable}`);
  }
  console.log('[chromium-check] local Chromium is ready:', expectedExecutable);
} catch (error) {
  console.error('[chromium-check] local Chromium installation failed.');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
