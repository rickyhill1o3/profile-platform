const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');

function rm(target) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      console.log('[preinstall] removed stale cache path:', target);
    }
  } catch (err) {
    console.warn('[preinstall] could not remove:', target, err.message);
  }
}

// Render sometimes restores a partially-written node_modules cache. Removing only one
// package can confuse npm's installer, so remove the whole folder before npm starts.
if (process.env.RENDER || process.env.FORCE_CLEAN_NODE_MODULES === '1') {
  rm(nodeModules);
} else {
  rm(path.join(nodeModules, 'imapflow'));
  try {
    if (fs.existsSync(nodeModules)) {
      for (const name of fs.readdirSync(nodeModules)) {
        if (name.startsWith('.imapflow-')) rm(path.join(nodeModules, name));
      }
    }
  } catch (_) {}
}
