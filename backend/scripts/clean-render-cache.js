const fs = require('fs');
const path = require('path');
const targets = [
  path.join(__dirname, '..', 'node_modules', 'imapflow')
];
const nm = path.join(__dirname, '..', 'node_modules');
try {
  if (fs.existsSync(nm)) {
    for (const name of fs.readdirSync(nm)) {
      if (name.startsWith('.imapflow-')) targets.push(path.join(nm, name));
    }
  }
} catch (_) {}
for (const target of targets) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log('[preinstall] removed stale cache path:', target);
    }
  } catch (err) {
    console.warn('[preinstall] could not remove stale cache path:', target, err.message);
  }
}
