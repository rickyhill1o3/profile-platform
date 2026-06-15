'use strict';
const { spawnSync } = require('child_process');
if (process.env.SKIP_PLAYWRIGHT_INSTALL === '1') {
  console.log('Skipping Playwright browser install because SKIP_PLAYWRIGHT_INSTALL=1');
  process.exit(0);
}
console.log('Installing Playwright Chromium browser...');
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: false });
if (result.status !== 0) {
  console.error('Playwright Chromium install failed. On Render, use Clear build cache & deploy, then redeploy.');
  process.exit(result.status || 1);
}
