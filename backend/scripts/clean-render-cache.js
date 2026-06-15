const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');

function rm(target) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      console.log('[preinstall] removed stale cache path:', target);
    }
  } catch (err) {
    console.warn('[preinstall] could not remove:', target, err.message);
  }
}

// Do NOT delete the whole node_modules folder inside npm's own lifecycle.
// That can make npm think packages were installed while the folder was removed.
// This only clears the corrupted imapflow folders that previously caused ENOTEMPTY.
rm(path.join(nodeModules, 'imapflow'));
try {
  if (fs.existsSync(nodeModules)) {
    for (const name of fs.readdirSync(nodeModules)) {
      if (name.startsWith('.imapflow-')) rm(path.join(nodeModules, name));
    }
  }
} catch (_) {}
