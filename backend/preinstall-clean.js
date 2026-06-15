// Render can restore an old node_modules cache before running npm install.
// npm sometimes fails with ENOTEMPTY while renaming cached packages such as imapflow.
// This preinstall cleanup removes stale package folders before npm starts installing.
const fs = require('fs');
const path = require('path');

const root = __dirname;
const nm = path.join(root, 'node_modules');
const targets = [
  'imapflow',
  'mailparser',
  'playwright',
  'playwright-core',
  '@playwright',
];

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    console.log(`[preinstall-clean] removed ${p}`);
  } catch (err) {
    console.log(`[preinstall-clean] could not remove ${p}: ${err.message}`);
  }
}

if (fs.existsSync(nm)) {
  for (const name of targets) rm(path.join(nm, name));
  try {
    for (const entry of fs.readdirSync(nm)) {
      if (/^\.(imapflow|mailparser|playwright|playwright-core)-/.test(entry)) {
        rm(path.join(nm, entry));
      }
    }
  } catch (err) {
    console.log(`[preinstall-clean] scan skipped: ${err.message}`);
  }
}
